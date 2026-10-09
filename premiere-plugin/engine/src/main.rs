//! silences-engine: silence analysis and integer tick cut planning for the
//! Premiere Pro panel.
//!
//! Commands:
//!   analyze <media> [options]   analyse a media file and print the cut plan
//!   plan [--input <file|->]     turn a timeline snapshot plus media analyses
//!                               into an explicit integer tick plan
//!   version
//!
//! Exit codes: 0 success, 1 runtime failure, 2 invalid arguments or parameters.

use std::collections::HashMap;
use std::io::Read;
use std::process::ExitCode;
use std::time::Duration;

use serde_json::json;
use silences_engine::audio::{self, AnalyzeOptions, ChannelMode, Decoder};
use silences_engine::detect::{detect_pauses, kept_segments, DetectionSettings, Levels};
use silences_engine::level::{self, BLOCKS_PER_SECOND};
use silences_engine::planner::{PlanRequest, TICKS_PER_SECOND};
use silences_engine::process::{self, CancelToken};

/// Exit codes: 0 success, 1 runtime failure, 2 invalid arguments, parameters or
/// snapshot content. Everything the caller can fix by correcting the input is a
/// usage error, every decoder or io failure is a runtime error.
const EXIT_RUNTIME: u8 = 1;
const EXIT_USAGE: u8 = 2;

struct Failure {
    code: u8,
    message: String,
}

impl Failure {
    fn usage(message: impl Into<String>) -> Self {
        Self {
            code: EXIT_USAGE,
            message: message.into(),
        }
    }

    fn runtime(message: impl Into<String>) -> Self {
        Self {
            code: EXIT_RUNTIME,
            message: message.into(),
        }
    }
}

type CliResult = Result<String, Failure>;

struct Options {
    file: String,
    input: Option<String>,
    parameters: DetectionSettings,
    channel_mode: ChannelMode,
    values_per_second: f64,
    ffmpeg: Option<String>,
    ffprobe: Option<String>,
    with_db_values: bool,
    timeout: Duration,
    watch_stdin: bool,
}

fn usage() -> String {
    [
        "silences-engine 2.0.0",
        "",
        "Usage:",
        "  silences-engine analyze <media> [options]",
        "  silences-engine plan [--input <snapshot.json|->] [options]",
        "  silences-engine version",
        "",
        "Options:",
        "  --threshold-db <db>       pause threshold, -90..0 (default -45)",
        "  --min-pause <seconds>     shorter pauses stay (default 0.16)",
        "  --min-speech <seconds>    shorter quiet regions are noise (default 0.16)",
        "  --lead-in <seconds>       air kept before speech (default 0.16)",
        "  --tail <seconds>          air kept after speech (default 0.16)",
        "  --values-per-second <n>   analysis resolution, 1..1000 (default 100)",
        "  --channel-mode <mode>     loudest (default) or mono",
        "  --stereo                  synonym for --channel-mode loudest",
        "  --mono                    synonym for --channel-mode mono",
        "  --timeout-seconds <n>     per decoder process timeout (default 1800)",
        "  --watch-stdin             cancel when the parent closes standard input",
        "  --ffmpeg <path>           decoder binary",
        "  --ffprobe <path>          probe binary",
        "  --with-db-values          include block levels and the threshold suggestion",
    ]
    .join("\n")
}

fn parse_arguments(arguments: Vec<String>) -> Result<(String, Options), Failure> {
    let mut options = Options {
        file: String::new(),
        input: None,
        parameters: DetectionSettings::default(),
        channel_mode: ChannelMode::Loudest,
        values_per_second: BLOCKS_PER_SECOND,
        ffmpeg: None,
        ffprobe: None,
        with_db_values: false,
        timeout: Duration::from_secs(audio::DEFAULT_TIMEOUT_SECONDS),
        watch_stdin: false,
    };
    let mut command: Option<String> = None;
    let mut index = 0;
    while index < arguments.len() {
        let argument = arguments[index].clone();
        let value = |index: &mut usize| -> Result<String, Failure> {
            *index += 1;
            arguments
                .get(*index)
                .cloned()
                .ok_or_else(|| Failure::usage(format!("missing value for {argument}")))
        };
        match argument.as_str() {
            "--threshold-db" => {
                options.parameters.threshold_db = parse_number(&value(&mut index)?)?
            }
            "--min-pause" => options.parameters.min_pause = parse_number(&value(&mut index)?)?,
            "--min-speech" => options.parameters.min_speech = parse_number(&value(&mut index)?)?,
            "--lead-in" => options.parameters.lead_in = parse_number(&value(&mut index)?)?,
            "--tail" => options.parameters.tail = parse_number(&value(&mut index)?)?,
            "--values-per-second" => options.values_per_second = parse_number(&value(&mut index)?)?,
            "--timeout-seconds" => {
                let seconds = parse_number(&value(&mut index)?)?;
                if !(1.0..=86_400.0).contains(&seconds) {
                    return Err(Failure::usage(
                        "timeout-seconds must be between 1 and 86400",
                    ));
                }
                options.timeout = Duration::from_secs_f64(seconds);
            }
            "--channel-mode" => {
                options.channel_mode =
                    ChannelMode::parse(&value(&mut index)?).map_err(Failure::usage)?
            }
            "--ffmpeg" => options.ffmpeg = Some(value(&mut index)?),
            "--ffprobe" => options.ffprobe = Some(value(&mut index)?),
            "--input" => options.input = Some(value(&mut index)?),
            "--stereo" => options.channel_mode = ChannelMode::Loudest,
            "--mono" => options.channel_mode = ChannelMode::Mono,
            "--watch-stdin" => options.watch_stdin = true,
            "--with-db-values" => options.with_db_values = true,
            "--help" | "-h" => return Err(Failure::usage(usage())),
            other if other.starts_with("--") => {
                return Err(Failure::usage(format!("unknown option {other}")))
            }
            other if command.is_none() => command = Some(other.to_string()),
            other => options.file = other.to_string(),
        }
        index += 1;
    }
    let command = command.ok_or_else(|| Failure::usage(usage()))?;
    Ok((command, options))
}

fn parse_number(text: &str) -> Result<f64, Failure> {
    let value: f64 = text
        .parse()
        .map_err(|_| Failure::usage(format!("invalid number {text}")))?;
    if !value.is_finite() {
        return Err(Failure::usage(format!("value {text} must be finite")));
    }
    Ok(value)
}

/// Rejects parameter values that would produce a meaningless or unsafe plan.
fn validate_parameters(
    parameters: &DetectionSettings,
    values_per_second: f64,
) -> Result<(), Failure> {
    parameters.validate().map_err(Failure::usage)?;
    if !values_per_second.is_finite()
        || !(audio::MIN_VALUES_PER_SECOND..=audio::MAX_VALUES_PER_SECOND)
            .contains(&values_per_second)
    {
        return Err(Failure::usage(format!(
            "valuesPerSecond must be between {} and {}",
            audio::MIN_VALUES_PER_SECOND,
            audio::MAX_VALUES_PER_SECOND
        )));
    }
    Ok(())
}

fn decoder_json(decoder: &Decoder) -> serde_json::Value {
    json!({
        "ffmpeg": decoder.ffmpeg,
        "ffmpegVersion": decoder.ffmpeg_version,
        "ffprobe": decoder.ffprobe,
        "ffprobeVersion": decoder.ffprobe_version,
    })
}

fn analyze(options: &Options, cancel: &CancelToken) -> CliResult {
    let decoder = audio::resolve_decoder(
        options.ffmpeg.as_deref(),
        options.ffprobe.as_deref(),
        cancel,
    )
    .map_err(Failure::runtime)?;
    let analyze_options = AnalyzeOptions {
        channel_mode: options.channel_mode,
        values_per_second: options.values_per_second,
        timeout: options.timeout,
        stderr_limit: audio::DEFAULT_STDERR_LIMIT,
    };
    let (info, analysis) = audio::analyze(&options.file, &decoder, &analyze_options, cancel)
        .map_err(Failure::runtime)?;
    let value_duration = analysis.value_duration_sec;
    let pauses = detect_pauses(
        &Levels {
            db: analysis.db_values.clone(),
            block_seconds: value_duration,
            duration: analysis.duration_sec,
        },
        &options.parameters,
    );
    let segments = kept_segments(&pauses, analysis.duration_sec);
    let removed: f64 = pauses.iter().map(|(start, end)| end - start).sum();

    let mut output = json!({
        "file": options.file,
        "decoder": decoder_json(&decoder),
        "channelMode": options.channel_mode.as_str(),
        "channelsAnalyzed": analysis.channels_analyzed,
        "streamIndex": analysis.stream_index,
        "trailingSamplesIgnored": analysis.trailing_samples_ignored,
        "valuesPerSecond": analysis.values_per_second,
        "requestedValuesPerSecond": analysis.requested_values_per_second,
        "valueDuration": value_duration,
        "windowFrames": analysis.window_frames,
        "durationSec": info.duration,
        "sampleRate": info.sample_rate,
        "channels": info.channels,
        "valueCount": analysis.db_values.len(),
        "parameters": {
            "thresholdDb": options.parameters.threshold_db,
            "minPause": options.parameters.min_pause,
            "minSpeech": options.parameters.min_speech,
            "leadIn": options.parameters.lead_in,
            "tail": options.parameters.tail,
        },
        "pauses": pauses,
        "keptSegments": segments,
        "keptSegmentCount": segments.len(),
        "removedSeconds": removed,
    });
    if options.with_db_values {
        output["levels"] = json!(analysis.db_values);
        output["thresholdSuggestion"] = json!(level::suggest_threshold(&analysis.db_values));
    }
    serde_json::to_string(&output)
        .map_err(|error| Failure::runtime(format!("cannot serialise result: {error}")))
}

fn read_input(source: &str) -> Result<String, String> {
    if source == "-" {
        let mut text = String::new();
        std::io::stdin()
            .read_to_string(&mut text)
            .map_err(|error| format!("cannot read stdin: {error}"))?;
        Ok(text)
    } else {
        std::fs::read_to_string(source).map_err(|error| format!("cannot read {source}: {error}"))
    }
}

fn plan(options: &Options, cancel: &CancelToken) -> CliResult {
    let input = match &options.input {
        Some(source) => read_input(source).map_err(Failure::runtime)?,
        None => {
            let mut text = String::new();
            std::io::stdin()
                .read_to_string(&mut text)
                .map_err(|error| Failure::runtime(format!("cannot read stdin: {error}")))?;
            text
        }
    };
    let request = PlanRequest::from_json(&input).map_err(Failure::usage)?;
    validate_parameters(&request.parameters, options.values_per_second)?;

    let native_pcm =
        request.rendered_mixdown.is_some() && request.channel_mode == ChannelMode::Loudest;
    let decoder = if native_pcm {
        None
    } else {
        Some(
            audio::resolve_decoder(
                options.ffmpeg.as_deref(),
                options.ffprobe.as_deref(),
                cancel,
            )
            .map_err(Failure::runtime)?,
        )
    };
    let analyze_options = AnalyzeOptions {
        channel_mode: request.channel_mode,
        values_per_second: options.values_per_second,
        timeout: options.timeout,
        stderr_limit: audio::DEFAULT_STDERR_LIMIT,
    };

    let mut noise_estimate = None;
    let mut cache: HashMap<String, Vec<(f64, f64)>> = HashMap::new();
    let mut source_intervals = |media_path: &str| -> Result<Vec<(f64, f64)>, String> {
        if let Some(cached) = cache.get(media_path) {
            return Ok(cached.clone());
        }
        let (_, analysis) = if native_pcm {
            audio::analyze_native_wav(media_path, &analyze_options, cancel)
        } else {
            audio::analyze(
                media_path,
                decoder.as_ref().unwrap(),
                &analyze_options,
                cancel,
            )
        }
        .map_err(|error| format!("cannot analyse {media_path}: {error}"))?;
        if request.rendered_mixdown.as_deref() == Some(media_path) {
            let expected = request.sequence.end_ticks as f64 / TICKS_PER_SECOND as f64;
            if (analysis.duration_sec - expected).abs() > 0.001 {
                return Err(format!(
                    "native render duration {} does not match timeline {expected}",
                    analysis.duration_sec
                ));
            }
        }
        if options.with_db_values && native_pcm {
            // Only selected time under an enabled dialogue clip is evidence for
            // the room tone. Gaps render as digital silence.
            let evidence = silences_engine::planner::intersect_sorted(
                &request.selected_sections,
                &silences_engine::planner::dialogue_coverage(&request),
            );
            let levels: Vec<f64> = analysis
                .db_values
                .iter()
                .enumerate()
                .filter_map(|(i, db)| {
                    let at =
                        (i as f64 * analysis.value_duration_sec * TICKS_PER_SECOND as f64) as i64;
                    evidence
                        .iter()
                        .any(|&(start, end)| at >= start && at < end)
                        .then_some(*db)
                })
                .collect();
            noise_estimate = level::suggest_threshold(&levels);
        }
        let pauses = detect_pauses(
            &Levels {
                db: analysis.db_values.clone(),
                block_seconds: analysis.value_duration_sec,
                duration: analysis.duration_sec,
            },
            &request.parameters,
        );
        cache.insert(media_path.to_string(), pauses.clone());
        Ok(pauses)
    };

    let plan = silences_engine::planner::build_plan(&request, &mut source_intervals)
        .map_err(Failure::usage)?;
    let output = json!({
        "noiseEstimate": noise_estimate,
        "sequence": request.sequence.name,
        "mode": request.mode.as_str(),
        "channelMode": request.channel_mode.as_str(),
        "decoder": decoder.as_ref().map(decoder_json).unwrap_or_else(|| json!({"backend":"native_pcm16"})),
        "plan": plan,
    });
    serde_json::to_string(&output)
        .map_err(|error| Failure::runtime(format!("cannot serialise plan: {error}")))
}

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.is_empty() {
        println!("{}", usage());
        return ExitCode::from(EXIT_USAGE);
    }
    if arguments[0] == "--help" || arguments[0] == "-h" || arguments[0] == "help" {
        println!("{}", usage());
        return ExitCode::SUCCESS;
    }

    let (command, options) = match parse_arguments(arguments) {
        Ok(parsed) => parsed,
        Err(failure) => {
            eprintln!("{}", failure.message);
            return ExitCode::from(failure.code);
        }
    };

    // Guard: the snapshot may come from stdin and the cancellation watcher also
    // reads stdin. Both at once cannot work, so the combination is refused.
    let snapshot_from_stdin = command == "plan"
        && options
            .input
            .as_deref()
            .map(|value| value == "-")
            .unwrap_or(true);
    if options.watch_stdin && snapshot_from_stdin {
        eprintln!("--watch-stdin cannot be combined with reading the snapshot from stdin, pass --input <file>");
        return ExitCode::from(EXIT_USAGE);
    }

    let cancel = CancelToken::new();
    if options.watch_stdin {
        process::watch_stdin(cancel.clone());
    }

    let outcome = match command.as_str() {
        "version" | "--version" | "-v" => {
            println!("2.0.0");
            return ExitCode::SUCCESS;
        }
        "analyze" => {
            if options.file.is_empty() {
                Err(Failure::usage("analyze needs a media path"))
            } else {
                validate_parameters(&options.parameters, options.values_per_second)
                    .and_then(|()| analyze(&options, &cancel))
            }
        }
        "plan" => plan(&options, &cancel),
        other => Err(Failure::usage(format!(
            "unknown command {other}\n\n{}",
            usage()
        ))),
    };

    match outcome {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(failure) => {
            eprintln!("{}", failure.message);
            ExitCode::from(failure.code)
        }
    }
}
