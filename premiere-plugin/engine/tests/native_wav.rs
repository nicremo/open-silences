//! Native PCM reader tests use generated audio only, without external tools.
use silences_engine::{
    audio::{
        analyze_native_wav, analyze_native_wav_range, AnalyzeOptions, AudioAnalysis, AudioInfo,
    },
    process::CancelToken,
};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn fixture() -> (PathBuf, Vec<u8>) {
    let path = std::env::temp_dir().join(format!(
        "open-silences-pcm-{}-{:?}.wav",
        std::process::id(),
        std::thread::current().id()
    ));
    let mut data = Vec::new();
    for _ in 0..2407 {
        data.extend_from_slice(&16384i16.to_le_bytes());
        data.extend_from_slice(&(-16384i16).to_le_bytes());
    }
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36u32 + data.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&48000u32.to_le_bytes());
    wav.extend_from_slice(&192000u32.to_le_bytes());
    wav.extend_from_slice(&4u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
    wav.extend_from_slice(&data);
    (path, wav)
}

#[test]
fn native_pcm_preserves_opposite_phase_channels_and_partial_window() {
    let (path, wav) = fixture();
    fs::write(&path, wav).unwrap();
    let (info, analysis) = analyze_native_wav(
        path.to_str().unwrap(),
        &AnalyzeOptions {
            values_per_second: 50.0,
            ..AnalyzeOptions::default()
        },
        &CancelToken::default(),
    )
    .unwrap();
    assert_eq!(info.channels, 2);
    assert_eq!(info.sample_rate, 48000);
    assert_eq!(analysis.db_values.len(), 3);
    // 20 log10(0.5) is -6.0206, stored rounded to two decimals.
    assert_eq!(analysis.db_values, vec![-6.02; 3]);
    assert_eq!(analysis.rms_values, vec![0.5; 3]);
    assert_eq!(analysis.window_frames, 960);
    assert_eq!(analysis.duration_sec, 2407.0 / 48000.0);
}

#[test]
fn native_pcm_skips_metadata_and_rejects_truncated_or_partial_data() {
    let (path, mut wav) = fixture();
    wav.extend_from_slice(b"JUNK");
    wav.extend_from_slice(&3u32.to_le_bytes());
    wav.extend_from_slice(b"abc\0");
    let length = wav.len() as u32 - 8;
    wav[4..8].copy_from_slice(&length.to_le_bytes());
    fs::write(&path, &wav).unwrap();
    assert!(analyze_native_wav(
        path.to_str().unwrap(),
        &AnalyzeOptions::default(),
        &CancelToken::default()
    )
    .is_ok());
    wav.pop();
    fs::write(&path, &wav).unwrap();
    assert!(analyze_native_wav(
        path.to_str().unwrap(),
        &AnalyzeOptions::default(),
        &CancelToken::default()
    )
    .unwrap_err()
    .contains("container length"));
    let (path, mut wav) = fixture();
    let data_size = u32::from_le_bytes(wav[40..44].try_into().unwrap()) - 2;
    wav[40..44].copy_from_slice(&data_size.to_le_bytes());
    wav.truncate(wav.len() - 2);
    let length = wav.len() as u32 - 8;
    wav[4..8].copy_from_slice(&length.to_le_bytes());
    fs::write(&path, &wav).unwrap();
    assert!(analyze_native_wav(
        path.to_str().unwrap(),
        &AnalyzeOptions::default(),
        &CancelToken::default()
    )
    .unwrap_err()
    .contains("complete sample frames"));
}

#[test]
fn native_pcm_honors_cancellation_and_rejects_wrong_format() {
    let (path, mut wav) = fixture();
    fs::write(&path, &wav).unwrap();
    let cancel = CancelToken::default();
    cancel.cancel();
    assert!(
        analyze_native_wav(path.to_str().unwrap(), &AnalyzeOptions::default(), &cancel)
            .unwrap_err()
            .contains("cancelled")
    );
    wav[20..22].copy_from_slice(&3u16.to_le_bytes());
    fs::write(&path, &wav).unwrap();
    assert!(analyze_native_wav(
        path.to_str().unwrap(),
        &AnalyzeOptions::default(),
        &CancelToken::default()
    )
    .unwrap_err()
    .contains("unsupported WAV format"));
}

#[test]
fn a_range_starts_the_grid_at_its_first_sample() {
    let (path, wav) = fixture();
    fs::write(&path, wav).unwrap();
    let options = AnalyzeOptions {
        values_per_second: 50.0,
        ..AnalyzeOptions::default()
    };
    let (info, analysis) = analyze_native_wav_range(
        path.to_str().unwrap(),
        &options,
        Some((0.01, 0.04)),
        &CancelToken::default(),
    )
    .unwrap();
    // 480 to 1920: one full window and a partial one of 480 frames.
    assert_eq!(analysis.db_values.len(), 2);
    assert_eq!(analysis.duration_sec, 1440.0 / 48000.0);
    assert_eq!(info.duration, 2407.0 / 48000.0);
    for range in [(0.06, 0.08), (0.03, 0.02), (f64::NAN, 1.0)] {
        assert!(analyze_native_wav_range(
            path.to_str().unwrap(),
            &options,
            Some(range),
            &CancelToken::default()
        )
        .is_err());
    }
}

/// A WAV file with a plain or an extensible format chunk around `data`.
fn wav_file(
    name: &str,
    tag: u16,
    channels: u16,
    rate: u32,
    bits: u16,
    extensible: bool,
    data: &[u8],
) -> PathBuf {
    let align = channels * bits / 8;
    let mut fmt = Vec::new();
    fmt.extend_from_slice(&(if extensible { 0xFFFEu16 } else { tag }).to_le_bytes());
    fmt.extend_from_slice(&channels.to_le_bytes());
    fmt.extend_from_slice(&rate.to_le_bytes());
    fmt.extend_from_slice(&(rate * u32::from(align)).to_le_bytes());
    fmt.extend_from_slice(&align.to_le_bytes());
    fmt.extend_from_slice(&bits.to_le_bytes());
    if extensible {
        fmt.extend_from_slice(&22u16.to_le_bytes());
        fmt.extend_from_slice(&bits.to_le_bytes());
        fmt.extend_from_slice(&4u32.to_le_bytes());
        fmt.extend_from_slice(&tag.to_le_bytes());
        fmt.extend_from_slice(&[0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71]);
    }
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(4 + 8 + fmt.len() as u32 + 8 + data.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
    wav.extend_from_slice(&fmt);
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
    wav.extend_from_slice(data);
    let path = std::env::temp_dir().join(format!(
        "open-silences-{name}-{}-{:?}.wav",
        std::process::id(),
        std::thread::current().id()
    ));
    fs::write(&path, wav).unwrap();
    path
}

/// Float samples in which only every third one carries the signal.
fn every_third(frames: usize, amplitude: f32) -> Vec<u8> {
    (0..frames)
        .flat_map(|index| (if index % 3 == 0 { amplitude } else { 0.0f32 }).to_le_bytes())
        .collect()
}

fn analyse(path: &Path) -> Result<(AudioInfo, AudioAnalysis), String> {
    analyze_native_wav(
        path.to_str().unwrap(),
        &AnalyzeOptions::default(),
        &CancelToken::default(),
    )
}

#[test]
fn float_renders_at_48_khz_are_measured_on_every_third_sample() {
    let path = wav_file("float48", 3, 1, 48000, 32, false, &every_third(1920, 0.5));
    let (info, analysis) = analyse(&path).unwrap();
    assert_eq!(info.sample_rate, 48000);
    assert_eq!(analysis.decimation, 3);
    assert_eq!(analysis.window_frames, 960);
    assert_eq!(analysis.value_duration_sec, 0.02);
    // Only the kept samples count: 0.5 RMS, not 0.5 / sqrt(3).
    assert_eq!(analysis.rms_values, vec![0.5, 0.5]);
    assert_eq!(analysis.db_values, vec![-6.02, -6.02]);
}

#[test]
fn extensible_float_and_pcm24_are_read_natively() {
    let path = wav_file("extensible", 3, 1, 48000, 32, true, &every_third(960, 0.5));
    assert_eq!(analyse(&path).unwrap().1.db_values, vec![-6.02]);
    let quarter: Vec<u8> = (0..960).flat_map(|_| [0x00, 0x00, 0x20]).collect();
    let path = wav_file("pcm24", 1, 1, 48000, 24, false, &quarter);
    let (_, analysis) = analyse(&path).unwrap();
    assert_eq!(analysis.rms_values, vec![0.25]);
    assert_eq!(analysis.db_values, vec![-12.04]);
}

#[test]
fn rates_that_are_no_multiple_of_16_khz_are_measured_as_they_are() {
    let path = wav_file("float441", 3, 1, 44100, 32, false, &every_third(882, 0.5));
    let (_, analysis) = analyse(&path).unwrap();
    assert_eq!(analysis.decimation, 1);
    assert_eq!(analysis.window_frames, 882);
    assert!((analysis.rms_values[0] - 0.5 / 3f64.sqrt()).abs() < 1e-9);
}

#[test]
fn non_finite_float_samples_are_rejected() {
    let mut data = every_third(960, 0.5);
    data[12..16].copy_from_slice(&f32::NAN.to_le_bytes());
    let path = wav_file("nan", 3, 1, 48000, 32, false, &data);
    assert!(analyse(&path).unwrap_err().contains("non finite"));
}
