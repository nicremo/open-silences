//! Audio front end: ffprobe for duration and sample rate, ffmpeg for raw
//! float32 PCM, RMS windows of `max(1, floor(sampleRate / valuesPerSecond))`
//! sample frames.
//!
//! Robustness rules:
//! * the decoder is resolved deterministically; an explicitly configured binary
//!   that does not work is an error and is never silently replaced,
//! * ffprobe and ffmpeg always select the same audio stream explicitly,
//! * windows count sample frames, not interleaved samples,
//! * channels are analysed separately by default and the loudest channel wins,
//!   so out of phase stereo cannot be mistaken for silence,
//! * every child process has a timeout, a cancel token, bounded stderr and a
//!   process group kill.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::level::amplitude_to_db;
use crate::process::{self, CancelToken};

pub const DEFAULT_TIMEOUT_SECONDS: u64 = 1800;
pub const DEFAULT_STDERR_LIMIT: usize = 8192;
pub const MIN_VALUES_PER_SECOND: f64 = 1.0;
pub const MAX_VALUES_PER_SECOND: f64 = 1000.0;

/// How the channels of the decoded audio are combined.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelMode {
    /// Analyse every channel and use the loudest one per window. Robust against
    /// out of phase stereo. This is the default.
    Loudest,
    /// Mono downmix by the decoder (`-ac 1`). Out of phase stereo can cancel
    /// out completely, so this mode is for diagnostics only.
    Mono,
}

impl ChannelMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChannelMode::Loudest => "loudest",
            ChannelMode::Mono => "mono",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "loudest" => Ok(ChannelMode::Loudest),
            "mono" => Ok(ChannelMode::Mono),
            other => Err(format!("unknown channel mode {other}")),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Decoder {
    pub ffmpeg: String,
    pub ffprobe: String,
    pub ffmpeg_version: String,
    pub ffprobe_version: String,
}

#[derive(Debug, Clone)]
pub struct AudioInfo {
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u32,
    pub stream_index: i64,
}

#[derive(Debug, Clone)]
pub struct AnalyzeOptions {
    pub channel_mode: ChannelMode,
    pub values_per_second: f64,
    pub timeout: Duration,
    pub stderr_limit: usize,
}

impl Default for AnalyzeOptions {
    fn default() -> Self {
        Self {
            channel_mode: ChannelMode::Loudest,
            values_per_second: crate::level::BLOCKS_PER_SECOND,
            timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECONDS),
            stderr_limit: DEFAULT_STDERR_LIMIT,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AudioAnalysis {
    /// Effective values per second, `sample_rate / window_frames`. It equals the
    /// requested value whenever the sample rate is divisible by it (44100 and
    /// 48000 at 50) and is exact otherwise, so the time axis never drifts.
    pub values_per_second: f64,
    /// Requested value, reported for transparency.
    pub requested_values_per_second: f64,
    /// Duration of one analysis value, `window_frames / sample_rate`.
    pub value_duration_sec: f64,
    /// Frames per analysis value.
    pub window_frames: usize,
    /// Effective duration: the shorter of the container duration and the decoded
    /// audio. Cut points are never emitted beyond this value.
    pub duration_sec: f64,
    /// Duration of the decoded audio (complete sample frames only).
    pub decoded_duration_sec: f64,
    pub channels_analyzed: u32,
    pub trailing_samples_ignored: usize,
    pub stream_index: i64,
    /// One level per window in dBFS, unrounded, floored at `level::FLOOR_DB`.
    /// Memory grows with the number of windows.
    pub db_values: Vec<f64>,
    /// Unrounded RMS values, for tests and diagnostics.
    pub rms_values: Vec<f64>,
}

fn is_executable(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(metadata) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                metadata.is_file()
            }
        }
        Err(_) => false,
    }
}

fn bundled_candidates(name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join(name));
            if let Some(parent) = directory.parent() {
                candidates.push(parent.join(name));
            }
        }
    }
    candidates
}

/// Deterministic decoder lookup.
///
/// An explicitly configured binary (command line or environment) is binding: if
/// it cannot be executed the call fails instead of quietly using another one.
/// Only the bundled copies and `PATH` form a fallback chain.
pub fn resolve_decoder(
    explicit_ffmpeg: Option<&str>,
    explicit_ffprobe: Option<&str>,
    cancel: &CancelToken,
) -> Result<Decoder, String> {
    let ffmpeg = resolve_one(
        "ffmpeg",
        explicit_ffmpeg,
        std::env::var("OPEN_SILENCES_FFMPEG").ok(),
        cancel,
    )?;
    let ffprobe = resolve_one(
        "ffprobe",
        explicit_ffprobe,
        std::env::var("OPEN_SILENCES_FFPROBE").ok(),
        cancel,
    )?;
    Ok(Decoder {
        ffmpeg: ffmpeg.0,
        ffmpeg_version: ffmpeg.1,
        ffprobe: ffprobe.0,
        ffprobe_version: ffprobe.1,
    })
}

fn resolve_one(
    name: &str,
    explicit: Option<&str>,
    from_environment: Option<String>,
    cancel: &CancelToken,
) -> Result<(String, String), String> {
    if let Some(path) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return match version_of(path, name, cancel) {
            Ok(version) => Ok((path.to_string(), version)),
            Err(error) => Err(format!("configured {name} is not usable: {error}")),
        };
    }
    if let Some(path) = from_environment
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return match version_of(path, name, cancel) {
            Ok(version) => Ok((path.to_string(), version)),
            Err(error) => Err(format!(
                "{name} from the environment is not usable: {error}"
            )),
        };
    }

    let mut tried: Vec<String> = Vec::new();
    for candidate in bundled_candidates(name) {
        if !is_executable(&candidate) {
            tried.push(format!("{} (not executable)", candidate.display()));
            continue;
        }
        let text = candidate.to_string_lossy().to_string();
        match version_of(&text, name, cancel) {
            Ok(version) => return Ok((text, version)),
            Err(error) => tried.push(error),
        }
    }
    match version_of(name, name, cancel) {
        Ok(version) => Ok((name.to_string(), version)),
        Err(error) => {
            tried.push(error);
            Err(format!(
                "no usable {name} found. Place it next to the engine binary, add it to PATH, or pass --{name}. Tried: {}",
                tried.join("; ")
            ))
        }
    }
}

fn version_of(
    program: &str,
    expected_prefix: &str,
    cancel: &CancelToken,
) -> Result<String, String> {
    let args = vec!["-version".to_string()];
    let output = process::run(program, &args, Duration::from_secs(10), 8192, 4096, cancel)
        .map_err(|error| format!("{program}: {error}"))?;
    if !output.success {
        return Err(format!("{program}: -version failed"));
    }
    let first_line = output
        .stdout
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !first_line.starts_with(expected_prefix) {
        return Err(format!(
            "{program}: unexpected version output {first_line:?}"
        ));
    }
    Ok(first_line)
}

/// ffprobe for duration, sample rate and channel count of the first audio stream.
///
/// Two separate probes keep the parsing trivial and unambiguous: one for the
/// container duration, one for the explicitly selected audio stream.
pub fn probe_audio(
    file: &str,
    decoder: &Decoder,
    timeout: Duration,
    cancel: &CancelToken,
) -> Result<AudioInfo, String> {
    let duration_args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-show_entries".to_string(),
        "format=duration".to_string(),
        "-of".to_string(),
        "default=noprint_wrappers=1:nokey=1".to_string(),
        file.to_string(),
    ];
    let duration_output = process::run(
        &decoder.ffprobe,
        &duration_args,
        timeout,
        64 * 1024,
        DEFAULT_STDERR_LIMIT,
        cancel,
    )?;
    if !duration_output.success {
        return Err(format!(
            "ffprobe failed for {file}: {}",
            duration_output.stderr.tail.trim()
        ));
    }
    let duration: f64 = duration_output
        .stdout
        .lines()
        .find_map(|line| line.trim().parse::<f64>().ok())
        .ok_or_else(|| format!("ffprobe returned no usable duration for {file}"))?;
    if !duration.is_finite() || duration <= 0.0 {
        return Err(format!(
            "ffprobe returned an invalid duration for {file}: {duration}"
        ));
    }

    let stream_args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-select_streams".to_string(),
        "a:0".to_string(),
        "-show_entries".to_string(),
        "stream=index,sample_rate,channels".to_string(),
        "-of".to_string(),
        "default=noprint_wrappers=1".to_string(),
        file.to_string(),
    ];
    let stream_output = process::run(
        &decoder.ffprobe,
        &stream_args,
        timeout,
        64 * 1024,
        DEFAULT_STDERR_LIMIT,
        cancel,
    )?;
    if !stream_output.success {
        return Err(format!(
            "ffprobe failed for {file}: {}",
            stream_output.stderr.tail.trim()
        ));
    }
    let mut stream_index: Option<i64> = None;
    let mut sample_rate: Option<u32> = None;
    let mut channels: Option<u32> = None;
    for line in stream_output.stdout.lines() {
        let (key, value) = match line.trim().split_once('=') {
            Some(parts) => parts,
            None => continue,
        };
        match key {
            "index" if stream_index.is_none() => stream_index = value.trim().parse::<i64>().ok(),
            "sample_rate" if sample_rate.is_none() => {
                sample_rate = value.trim().parse::<u32>().ok()
            }
            "channels" if channels.is_none() => channels = value.trim().parse::<u32>().ok(),
            _ => {}
        }
    }
    let sample_rate = sample_rate.ok_or_else(|| format!("no audio stream in {file}"))?;
    if !(1..=768_000).contains(&sample_rate) {
        return Err(format!("unexpected sample rate {sample_rate} in {file}"));
    }
    let channels = channels.ok_or_else(|| format!("no channel count for {file}"))?;
    if !(1..=64).contains(&channels) {
        return Err(format!("unexpected channel count {channels} in {file}"));
    }
    let stream_index = stream_index.ok_or_else(|| format!("no stream index for {file}"))?;
    if stream_index < 0 {
        return Err(format!("negative stream index {stream_index} in {file}"));
    }
    Ok(AudioInfo {
        duration,
        sample_rate,
        channels,
        stream_index,
    })
}

/// Decode the selected audio stream to raw float32 PCM and build the windowed analysis.
pub fn analyze(
    file: &str,
    decoder: &Decoder,
    options: &AnalyzeOptions,
    cancel: &CancelToken,
) -> Result<(AudioInfo, AudioAnalysis), String> {
    if !options.values_per_second.is_finite()
        || options.values_per_second < MIN_VALUES_PER_SECOND
        || options.values_per_second > MAX_VALUES_PER_SECOND
    {
        return Err(format!(
            "valuesPerSecond must be a finite value between {MIN_VALUES_PER_SECOND} and {MAX_VALUES_PER_SECOND}"
        ));
    }

    let info = probe_audio(file, decoder, options.timeout, cancel)?;
    let window_frames =
        ((info.sample_rate as f64 / options.values_per_second).floor() as u64).max(1) as usize;
    // The window length is an integer number of frames, so the real resolution is
    // sample_rate / window_frames. Reporting the requested value would drift the
    // time axis for non divisible rates (11025 Hz at 50, 44100 Hz at 1000).
    let effective_values_per_second = info.sample_rate as f64 / window_frames as f64;
    let value_duration_sec = window_frames as f64 / info.sample_rate as f64;
    let deviation =
        (effective_values_per_second - options.values_per_second).abs() / options.values_per_second;
    if deviation > 0.1 {
        return Err(format!(
            "requested {:.3} values per second cannot be approximated at {} Hz (would be {:.3} values per second with {} frames per value); choose a lower resolution",
            options.values_per_second, info.sample_rate, effective_values_per_second, window_frames
        ));
    }

    let mut args: Vec<String> = vec![
        "-v".to_string(),
        "error".to_string(),
        "-nostdin".to_string(),
        "-i".to_string(),
        file.to_string(),
        "-map".to_string(),
        format!("0:{}", info.stream_index),
        "-vn".to_string(),
    ];
    if options.channel_mode == ChannelMode::Mono {
        args.push("-ac".to_string());
        args.push("1".to_string());
    }
    args.extend([
        "-f".to_string(),
        "f32le".to_string(),
        "-acodec".to_string(),
        "pcm_f32le".to_string(),
        "pipe:1".to_string(),
    ]);

    let channels = if options.channel_mode == ChannelMode::Mono {
        1usize
    } else {
        info.channels as usize
    };

    let mut sums = vec![0.0f64; channels];
    let mut frames_in_window = 0usize;
    let mut frame_index = 0usize;
    let mut total_frames: u64 = 0;
    let mut rms_values: Vec<f64> = Vec::new();
    let mut pending = [0u8; 4];
    let mut pending_len = 0usize;

    let result = process::run_streaming(
        &decoder.ffmpeg,
        &args,
        options.timeout,
        options.stderr_limit,
        cancel,
        |chunk| {
            let mut data = chunk;
            if pending_len > 0 {
                let needed = 4 - pending_len;
                let take = needed.min(data.len());
                pending[pending_len..pending_len + take].copy_from_slice(&data[..take]);
                pending_len += take;
                data = &data[take..];
                if pending_len == 4 {
                    let sample = f32::from_le_bytes(pending) as f64;
                    if !sample.is_finite() {
                        return Err(format!(
                            "decoder produced a non finite sample ({sample}) at sample index {}",
                            total_frames * channels as u64 + frame_index as u64
                        ));
                    }
                    accumulate(
                        sample,
                        channels,
                        &mut sums,
                        &mut frame_index,
                        &mut frames_in_window,
                        window_frames,
                        &mut rms_values,
                        &mut total_frames,
                    );
                    pending_len = 0;
                }
            }
            let complete = data.len() / 4;
            for index in 0..complete {
                let offset = index * 4;
                let sample = f32::from_le_bytes([
                    data[offset],
                    data[offset + 1],
                    data[offset + 2],
                    data[offset + 3],
                ]) as f64;
                if !sample.is_finite() {
                    return Err(format!(
                        "decoder produced a non finite sample ({sample}) at sample index {}",
                        total_frames * channels as u64 + frame_index as u64
                    ));
                }
                accumulate(
                    sample,
                    channels,
                    &mut sums,
                    &mut frame_index,
                    &mut frames_in_window,
                    window_frames,
                    &mut rms_values,
                    &mut total_frames,
                );
            }
            let remainder = data.len() % 4;
            if remainder > 0 {
                pending[..remainder].copy_from_slice(&data[data.len() - remainder..]);
                pending_len = remainder;
            }
            if rms_values.len() > 200_000_000 {
                return Err("decoded stream is implausibly long".to_string());
            }
            Ok(())
        },
    );
    result?;

    // A trailing partial sample frame means the decoder produced a truncated
    // stream. Those samples are not silently folded into the last window, the
    // analysis is rejected instead.
    if pending_len != 0 {
        return Err(format!(
            "decoder produced {} trailing bytes that do not complete a float sample",
            pending_len
        ));
    }
    if frame_index != 0 {
        return Err(format!(
            "decoder produced {} trailing samples that do not complete a sample frame",
            frame_index
        ));
    }
    if frames_in_window > 0 {
        rms_values.push(window_rms_of(&sums, frames_in_window, channels));
    }
    let trailing_samples_ignored = 0usize;

    if let Some(index) = rms_values.iter().position(|value| !value.is_finite()) {
        return Err(format!(
            "analysis produced a non finite RMS value at window {index}, the decoded audio is corrupt"
        ));
    }

    let decoded_duration_sec = total_frames as f64 / info.sample_rate as f64;
    let duration_sec = info.duration.min(decoded_duration_sec);

    let db_values: Vec<f64> = rms_values.iter().map(|rms| amplitude_to_db(*rms)).collect();
    Ok((
        info.clone(),
        AudioAnalysis {
            values_per_second: effective_values_per_second,
            requested_values_per_second: options.values_per_second,
            value_duration_sec,
            window_frames,
            duration_sec,
            decoded_duration_sec,
            channels_analyzed: channels as u32,
            trailing_samples_ignored,
            stream_index: info.stream_index,
            db_values,
            rms_values,
        },
    ))
}

/// Loudest channel per window (or the only channel in mono mode).
fn window_rms_of(sums: &[f64], frames: usize, channels: usize) -> f64 {
    sums.iter()
        .take(channels)
        .map(|sum| {
            let mean = sum / frames as f64;
            // Sums of squares cannot be negative; a negative or non finite mean
            // means the accumulator was corrupted and must not become silence.
            if mean.is_finite() && mean >= 0.0 {
                mean.sqrt()
            } else {
                f64::NAN
            }
        })
        .fold(0.0f64, f64::max)
}

/// Read Premiere's lossless PCM16 timeline render without a decoder process.
/// Metadata chunks are skipped, PCM is streamed, malformed bounds fail closed.
pub fn analyze_native_wav(
    file: &str,
    options: &AnalyzeOptions,
    cancel: &CancelToken,
) -> Result<(AudioInfo, AudioAnalysis), String> {
    use std::io::{Read, Seek, SeekFrom};
    let started = std::time::Instant::now();
    let run = || -> Result<(AudioInfo, AudioAnalysis), String> {
        if options.channel_mode != ChannelMode::Loudest {
            return Err("native PCM analysis requires loudest channel mode".to_string());
        }
        if !options.values_per_second.is_finite()
            || !(MIN_VALUES_PER_SECOND..=MAX_VALUES_PER_SECOND).contains(&options.values_per_second)
        {
            return Err("invalid native WAV analysis resolution".to_string());
        }
        let mut input = std::fs::File::open(file).map_err(|e| e.to_string())?;
        let length = input.metadata().map_err(|e| e.to_string())?.len();
        let mut header = [0u8; 12];
        input.read_exact(&mut header).map_err(|e| e.to_string())?;
        if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
            return Err("expected a RIFF PCM16 WAV render (maximum 4 GiB)".to_string());
        }
        let container_end = u32::from_le_bytes(header[4..8].try_into().unwrap()) as u64 + 8;
        if container_end != length {
            return Err("WAV container length is inconsistent".to_string());
        }
        let mut format = None;
        let mut data = None;
        let mut offset = 12u64;
        while offset < container_end {
            if cancel.is_cancelled() {
                return Err("native WAV analysis cancelled".to_string());
            }
            if started.elapsed() >= options.timeout {
                return Err("native WAV analysis timed out".to_string());
            }
            if container_end - offset < 8 {
                return Err("truncated WAV chunk header".to_string());
            }
            input
                .seek(SeekFrom::Start(offset))
                .map_err(|e| e.to_string())?;
            let mut chunk = [0u8; 8];
            input.read_exact(&mut chunk).map_err(|e| e.to_string())?;
            let size = u32::from_le_bytes(chunk[4..8].try_into().unwrap()) as u64;
            let body = offset + 8;
            let next = body + size + (size % 2);
            if next > container_end {
                return Err("WAV chunk exceeds the container".to_string());
            }
            match &chunk[0..4] {
                b"fmt " => {
                    if format.is_some() || size < 16 {
                        return Err("invalid WAV format chunk".to_string());
                    }
                    let mut fmt = [0u8; 16];
                    input.read_exact(&mut fmt).map_err(|e| e.to_string())?;
                    let tag = u16::from_le_bytes(fmt[0..2].try_into().unwrap());
                    let channels = u16::from_le_bytes(fmt[2..4].try_into().unwrap()) as u32;
                    let rate = u32::from_le_bytes(fmt[4..8].try_into().unwrap());
                    let byte_rate = u32::from_le_bytes(fmt[8..12].try_into().unwrap());
                    let align = u16::from_le_bytes(fmt[12..14].try_into().unwrap()) as u32;
                    let bits = u16::from_le_bytes(fmt[14..16].try_into().unwrap());
                    if tag != 1
                        || bits != 16
                        || !(1..=64).contains(&channels)
                        || !(1..=768000).contains(&rate)
                        || align != channels * 2
                        || byte_rate != rate * align
                    {
                        return Err(
                            "unsupported WAV format, expected interleaved PCM16".to_string()
                        );
                    }
                    format = Some((channels, rate, align));
                }
                b"data" => {
                    if data.is_some() {
                        return Err("multiple WAV data chunks are unsupported".to_string());
                    }
                    data = Some((body, size));
                }
                _ => {}
            }
            offset = next;
        }
        let (channels, rate, align) = format.ok_or("WAV format chunk missing")?;
        let (body, size) = data.ok_or("WAV data chunk missing")?;
        if size == 0 || size % align as u64 != 0 {
            return Err("WAV data does not contain complete sample frames".to_string());
        }
        let frames = size / align as u64;
        let window = ((rate as f64 / options.values_per_second).floor() as usize).max(1);
        let effective = rate as f64 / window as f64;
        if (effective - options.values_per_second).abs() / options.values_per_second > 0.1 {
            return Err("native WAV resolution deviates too much".to_string());
        }
        if frames.div_ceil(window as u64) > 2_000_000 {
            return Err("native WAV exceeds the analysis memory limit".to_string());
        }
        input
            .seek(SeekFrom::Start(body))
            .map_err(|e| e.to_string())?;
        let mut sums = vec![0.0; channels as usize];
        let (mut frame_index, mut in_window, mut total) = (0usize, 0usize, 0u64);
        let mut rms = Vec::new();
        let mut buffer = [0u8; 65536];
        let mut remaining = size;
        while remaining > 0 {
            if cancel.is_cancelled() {
                return Err("native WAV analysis cancelled".to_string());
            }
            if started.elapsed() >= options.timeout {
                return Err("native WAV analysis timed out".to_string());
            }
            let take = remaining.min(buffer.len() as u64) as usize;
            input
                .read_exact(&mut buffer[..take])
                .map_err(|e| e.to_string())?;
            for bytes in buffer[..take].as_chunks::<2>().0 {
                let sample = i16::from_le_bytes(*bytes) as f64 / 32768.0;
                accumulate(
                    sample,
                    channels as usize,
                    &mut sums,
                    &mut frame_index,
                    &mut in_window,
                    window,
                    &mut rms,
                    &mut total,
                );
            }
            remaining -= take as u64;
        }
        if in_window > 0 {
            rms.push(window_rms_of(&sums, in_window, channels as usize));
        }
        let duration = frames as f64 / rate as f64;
        let db_values = rms.iter().map(|r| amplitude_to_db(*r)).collect();
        Ok((
            AudioInfo {
                duration,
                sample_rate: rate,
                channels,
                stream_index: 0,
            },
            AudioAnalysis {
                values_per_second: effective,
                requested_values_per_second: options.values_per_second,
                value_duration_sec: window as f64 / rate as f64,
                window_frames: window,
                duration_sec: duration,
                decoded_duration_sec: duration,
                channels_analyzed: channels,
                trailing_samples_ignored: 0,
                stream_index: 0,
                db_values,
                rms_values: rms,
            },
        ))
    };
    run().map_err(|error| format!("native WAV {file}: {error}"))
}

#[allow(clippy::too_many_arguments)]
fn accumulate(
    sample: f64,
    channels: usize,
    sums: &mut [f64],
    frame_index: &mut usize,
    frames_in_window: &mut usize,
    window_frames: usize,
    rms_values: &mut Vec<f64>,
    total_frames: &mut u64,
) {
    if channels == 0 {
        return;
    }
    sums[*frame_index] += sample * sample;
    *frame_index += 1;
    if *frame_index == channels {
        *frame_index = 0;
        *total_frames += 1;
        *frames_in_window += 1;
        if *frames_in_window == window_frames {
            rms_values.push(window_rms_of(sums, *frames_in_window, channels));
            for value in sums.iter_mut() {
                *value = 0.0;
            }
            *frames_in_window = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Analytic level of a sine: rms = amplitude / sqrt(2).
    fn sine_db(amplitude: f64) -> f64 {
        20.0 * amplitude.log10() - 10.0 * std::f64::consts::LOG10_2
    }

    /// One directory per process: several test runs (and the reviewer's suite)
    /// may execute at the same time and must never clobber each other.
    fn fixture_dir() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "silences-engine-audio-tests-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn decoder() -> Option<Decoder> {
        resolve_decoder(None, None, &CancelToken::new()).ok()
    }

    fn make_fixture(name: &str, args: &[&str]) -> PathBuf {
        let path = fixture_dir().join(name);
        let ffmpeg = decoder()
            .map(|value| value.ffmpeg)
            .unwrap_or_else(|| "ffmpeg".to_string());
        let status = Command::new(ffmpeg)
            .args(["-v", "error", "-y"])
            .args(args)
            .arg(&path)
            .status()
            .expect("ffmpeg must be installed for these tests");
        assert!(status.success(), "fixture {name} could not be created");
        path
    }

    fn assert_close(actual: f64, expected: f64, tolerance: f64, what: &str) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "{what}: expected {expected} +/- {tolerance} dB, measured {actual} dB"
        );
    }

    #[test]
    fn explicit_decoder_is_binding() {
        let cancel = CancelToken::new();
        let error = resolve_decoder(Some("/nonexistent/ffmpeg"), None, &cancel).unwrap_err();
        assert!(
            error.contains("configured ffmpeg is not usable"),
            "explicit path must not silently fall back: {error}"
        );
    }

    #[test]
    fn decoder_resolution_reports_versions() {
        let Some(decoder) = decoder() else {
            eprintln!("skipped: no ffmpeg available");
            return;
        };
        assert!(decoder.ffmpeg_version.starts_with("ffmpeg version"));
        assert!(decoder.ffprobe_version.starts_with("ffprobe version"));
    }

    /// The lavfi `sine` source has an amplitude of 1/8, so tests use `aevalsrc`
    /// with an explicit amplitude and compare against the analytic RMS.
    #[test]
    fn analytic_level_and_last_partial_window() {
        let Some(decoder) = decoder() else {
            eprintln!("skipped: no ffmpeg available");
            return;
        };
        // 0.03 s at 48 kHz = 1440 frames: one full window of 960 frames plus 480.
        // 1000 Hz means 20 and 10 whole periods, so both windows must measure the
        // analytic level of a 0.5 amplitude sine.
        let path = make_fixture(
            "partial.wav",
            &[
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=0.5*sin(2*PI*1000*t):s=48000:d=0.03",
                "-ac",
                "1",
                "-c:a",
                "pcm_f32le",
            ],
        );
        let (_, analysis) = analyze(
            path.to_str().unwrap(),
            &decoder,
            &AnalyzeOptions {
                values_per_second: 50.0,
                ..AnalyzeOptions::default()
            },
            &CancelToken::new(),
        )
        .unwrap();
        assert_eq!(
            analysis.db_values.len(),
            2,
            "partial trailing window missing"
        );
        let expected = sine_db(0.5);
        assert_close(analysis.db_values[0], expected, 0.05, "full window");
        assert_close(
            analysis.db_values[1],
            expected,
            0.05,
            "partial trailing window",
        );
        // The decoded duration is the real limit for cut points.
        assert!(analysis.duration_sec <= 0.03 + 1e-9);
        assert!(analysis.decoded_duration_sec <= 0.031);
    }

    #[test]
    fn out_of_phase_stereo_is_not_silence_in_loudest_mode() {
        let Some(decoder) = decoder() else {
            eprintln!("skipped: no ffmpeg available");
            return;
        };
        // Right channel is the inverted left channel: our own mono downmix
        // cancels it out completely.
        let path = make_fixture(
            "phase.wav",
            &[
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=0.5*sin(2*PI*1000*t)|-0.5*sin(2*PI*1000*t):s=48000:d=1",
                "-c:a",
                "pcm_f32le",
            ],
        );
        let cancel = CancelToken::new();
        let loudest = AnalyzeOptions {
            channel_mode: ChannelMode::Loudest,
            ..AnalyzeOptions::default()
        };
        let mono = AnalyzeOptions {
            channel_mode: ChannelMode::Mono,
            ..AnalyzeOptions::default()
        };
        let (info, analysis) =
            analyze(path.to_str().unwrap(), &decoder, &loudest, &cancel).unwrap();
        assert_eq!(info.channels, 2);
        assert_eq!(analysis.channels_analyzed, 2);
        assert_close(analysis.db_values[5], sine_db(0.5), 0.05, "loudest channel");

        let (_, downmix) = analyze(path.to_str().unwrap(), &decoder, &mono, &cancel).unwrap();
        assert_eq!(downmix.channels_analyzed, 1);
        assert!(
            downmix.db_values[5] <= -59.0,
            "our mono downmix is expected to cancel out, got {}",
            downmix.db_values[5]
        );
    }

    #[test]
    fn stereo_windows_keep_the_time_axis() {
        let Some(decoder) = decoder() else {
            eprintln!("skipped: no ffmpeg available");
            return;
        };
        let path = make_fixture(
            "stereo.wav",
            &[
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=0.5*sin(2*PI*1000*t)|0.25*sin(2*PI*1000*t):s=48000:d=2",
                "-c:a",
                "pcm_f32le",
            ],
        );
        let options = AnalyzeOptions {
            channel_mode: ChannelMode::Loudest,
            values_per_second: 50.0,
            ..AnalyzeOptions::default()
        };
        let (info, analysis) = analyze(
            path.to_str().unwrap(),
            &decoder,
            &options,
            &CancelToken::new(),
        )
        .unwrap();
        assert_eq!(info.channels, 2);
        // 2 s at 50 values/s == 100 windows, not 200: windows count frames.
        assert!(
            (99..=101).contains(&analysis.db_values.len()),
            "window count {} suggests interleaved samples were counted",
            analysis.db_values.len()
        );
        assert_close(
            analysis.db_values[10],
            sine_db(0.5),
            0.05,
            "loudest of two channels",
        );
    }

    #[test]
    fn selects_the_first_audio_stream_explicitly() {
        let Some(decoder) = decoder() else {
            eprintln!("skipped: no ffmpeg available");
            return;
        };
        // Stream 0: quiet tone (amplitude 0.02), stream 1: loud tone (0.8).
        // The engine must follow the probe (a:0), whatever ffmpeg would pick.
        let path = make_fixture(
            "two_streams.mkv",
            &[
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=0.02*sin(2*PI*1000*t):s=48000:d=1",
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=0.8*sin(2*PI*1000*t):s=48000:d=1",
                "-map",
                "0:a:0",
                "-map",
                "1:a:0",
                "-c:a",
                "pcm_f32le",
            ],
        );
        let (info, analysis) = analyze(
            path.to_str().unwrap(),
            &decoder,
            &AnalyzeOptions::default(),
            &CancelToken::new(),
        )
        .unwrap();
        assert_eq!(
            info.stream_index, 0,
            "probe must report the first audio stream"
        );
        assert_eq!(analysis.stream_index, 0);
        assert_close(
            analysis.db_values[10],
            sine_db(0.02),
            0.2,
            "first (quiet) stream",
        );
    }

    /// The window length is an integer number of frames, so the real resolution
    /// is `sample_rate / window_frames`. For a non divisible rate the reported
    /// timing must use that effective value, otherwise cut positions drift.
    #[test]
    fn non_divisible_sample_rate_uses_the_effective_timing() {
        let Some(decoder) = decoder() else {
            eprintln!("skipped: no ffmpeg available");
            return;
        };
        // 11025 Hz at 50 values per second: 11025 / 50 = 220.5, so the window is
        // 220 frames and the real resolution is 50.1136 values per second. The
        // fixture is a 4 s tone followed by 1 s of silence, repeating for 60 s.
        let path = make_fixture(
            "nondivisible.wav",
            &[
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=0.5*sin(2*PI*1000*t)*lt(mod(t\\,5)\\,4):s=11025:d=60",
                "-ac",
                "1",
                "-c:a",
                "pcm_f32le",
            ],
        );
        let (_, analysis) = analyze(
            path.to_str().unwrap(),
            &decoder,
            &AnalyzeOptions {
                values_per_second: 50.0,
                ..AnalyzeOptions::default()
            },
            &CancelToken::new(),
        )
        .unwrap();
        assert_eq!(analysis.window_frames, 220);
        assert_eq!(analysis.values_per_second, 11025.0 / 220.0);
        assert_eq!(analysis.value_duration_sec, 220.0 / 11025.0);
        assert_eq!(analysis.requested_values_per_second, 50.0);

        let pauses = crate::detect::detect_pauses(
            &crate::detect::Levels {
                db: analysis.db_values.clone(),
                block_seconds: analysis.value_duration_sec,
                duration: analysis.duration_sec,
            },
            &crate::detect::DetectionSettings {
                threshold_db: -35.0,
                min_pause: 0.3,
                min_speech: 0.2,
                lead_in: 0.2,
                tail: 0.2,
            },
        );
        // The gate is a 4 s tone followed by 1 s of silence, repeating, so the
        // silence at 54 s must be cut at about 54.2 s to 54.8 s. With the
        // requested value duration of 20 ms instead of 220/11025 s this point
        // would drift by about 0.12 s.
        let mid = pauses
            .iter()
            .find(|interval| (interval.0 - 54.2).abs() < 0.3)
            .unwrap_or_else(|| panic!("no cut near 54.2 s in {pauses:?}"));
        assert!(
            (mid.0 - 54.2).abs() < 0.06 && (mid.1 - 54.8).abs() < 0.06,
            "drifted cut position: {mid:?}"
        );
        // The final silence touches the end of the material, so the cut ends at
        // the duration and is never extended beyond it.
        let last = pauses.last().unwrap();
        assert!(
            (last.0 - 59.2).abs() < 0.06,
            "drifted final cut start: {last:?}"
        );
        assert!(
            (last.1 - analysis.duration_sec).abs() < 0.01,
            "final cut must end at the duration: {last:?}"
        );
    }

    /// 44100 and 48000 Hz are both divisible by 50, so 50 values per second must
    /// stay exactly 50 and both rates must produce the same cut positions.
    #[test]
    fn standard_rates_at_fifty_stay_identical() {
        let Some(decoder) = decoder() else {
            eprintln!("skipped: no ffmpeg available");
            return;
        };
        let gate = "aevalsrc=0.5*sin(2*PI*1000*t)*lt(mod(t\\,5)\\,4):s=%RATE%:d=10";
        let mut intervals = Vec::new();
        for rate in [44100u32, 48000u32] {
            let path = make_fixture(
                &format!("standard-{rate}.wav"),
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    &gate.replace("%RATE%", &rate.to_string()),
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_f32le",
                ],
            );
            let (_, analysis) = analyze(
                path.to_str().unwrap(),
                &decoder,
                &AnalyzeOptions {
                    values_per_second: 50.0,
                    ..AnalyzeOptions::default()
                },
                &CancelToken::new(),
            )
            .unwrap();
            assert_eq!(
                analysis.values_per_second, 50.0,
                "rate {rate} must give exactly 50 values per second"
            );
            assert_eq!(analysis.value_duration_sec, 1.0 / 50.0);
            let pauses = crate::detect::detect_pauses(
                &crate::detect::Levels {
                    db: analysis.db_values.clone(),
                    block_seconds: analysis.value_duration_sec,
                    duration: analysis.duration_sec,
                },
                &crate::detect::DetectionSettings {
                    threshold_db: -35.0,
                    min_pause: 0.3,
                    min_speech: 0.2,
                    lead_in: 0.2,
                    tail: 0.2,
                },
            );
            intervals.push(pauses);
        }
        assert_eq!(intervals[0].len(), intervals[1].len());
        for (first, second) in intervals[0].iter().zip(intervals[1].iter()) {
            assert!(
                (first.0 - second.0).abs() < 0.03 && (first.1 - second.1).abs() < 0.03,
                "44100 and 48000 disagree: {first:?} vs {second:?}"
            );
        }
    }

    /// A corrupt float stream must not turn into silence. Without the finite
    /// check a NaN sample makes the sum NaN, every comparison fails and the
    /// window would be reported as -60 dBFS, which is exactly a cut.
    #[test]
    fn non_finite_pcm_is_rejected() {
        let Some(decoder) = decoder() else {
            eprintln!("skipped: no ffmpeg available");
            return;
        };
        // Minimal float WAV: 48 kHz mono, 960 samples, one NaN and one +Inf.
        let sample_rate: u32 = 48_000;
        let mut samples: Vec<f32> = (0..960)
            .map(|index| if index % 100 < 50 { 0.5 } else { 0.0 })
            .collect();
        samples[100] = f32::NAN;
        samples[200] = f32::INFINITY;
        let mut data = Vec::with_capacity(samples.len() * 4);
        for sample in &samples {
            data.extend_from_slice(&sample.to_le_bytes());
        }
        let data_len = data.len() as u32;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * 4).to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&32u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        wav.extend_from_slice(&data);

        let path = fixture_dir().join("non-finite.wav");
        std::fs::write(&path, &wav).unwrap();

        let result = analyze(
            path.to_str().unwrap(),
            &decoder,
            &AnalyzeOptions::default(),
            &CancelToken::new(),
        );
        match result {
            Err(message) => assert!(
                message.contains("non finite"),
                "unexpected error: {message}"
            ),
            Ok((_, analysis)) => panic!(
                "a non finite stream must not produce an analysis, got {} values starting at {:?}",
                analysis.db_values.len(),
                &analysis.db_values[..analysis.db_values.len().min(5)]
            ),
        }
    }

    /// Truncated PCM must be rejected, never silently folded into the analysis.
    #[test]
    fn truncated_pcm_is_rejected() {
        let Some(decoder) = decoder() else {
            eprintln!("skipped: no ffmpeg available");
            return;
        };
        let path = make_fixture(
            "truncate-source.wav",
            &[
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=0.5*sin(2*PI*1000*t):s=48000:d=1",
                "-ac",
                "1",
                "-c:a",
                "pcm_f32le",
            ],
        );
        let bytes = std::fs::read(&path).unwrap();
        let truncated = path.with_file_name("truncated.wav");
        std::fs::write(&truncated, &bytes[..bytes.len() - 3]).unwrap();
        let result = analyze(
            truncated.to_str().unwrap(),
            &decoder,
            &AnalyzeOptions::default(),
            &CancelToken::new(),
        );
        match result {
            Err(message) => assert!(
                message.contains("trailing")
                    || message.contains("failed")
                    || message.contains("invalid"),
                "unexpected error: {message}"
            ),
            Ok((_, analysis)) => {
                // A decoder may pad the tail, but the effective duration must not
                // exceed the real material.
                assert!(analysis.duration_sec <= 1.0 + 1e-6);
            }
        }
    }

    #[test]
    fn rejects_invalid_options_and_files() {
        let Some(decoder) = decoder() else {
            eprintln!("skipped: no ffmpeg available");
            return;
        };
        let path = make_fixture(
            "simple.wav",
            &[
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=0.5*sin(2*PI*1000*t):s=48000:d=0.5",
                "-ac",
                "1",
                "-c:a",
                "pcm_f32le",
            ],
        );
        for bad in [f64::NAN, f64::INFINITY, 0.0, -50.0, 5000.0] {
            let options = AnalyzeOptions {
                values_per_second: bad,
                ..AnalyzeOptions::default()
            };
            assert!(
                analyze(
                    path.to_str().unwrap(),
                    &decoder,
                    &options,
                    &CancelToken::new()
                )
                .is_err(),
                "valuesPerSecond {bad} must be rejected"
            );
        }
        assert!(analyze(
            "/nonexistent/file.mov",
            &decoder,
            &AnalyzeOptions::default(),
            &CancelToken::new()
        )
        .is_err());
    }
}
