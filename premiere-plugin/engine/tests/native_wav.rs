//! Native PCM reader tests use generated audio only, without external tools.
use silences_engine::{
    audio::{analyze_native_wav, AnalyzeOptions},
    process::CancelToken,
};
use std::{fs, path::PathBuf};

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
    for level in &analysis.db_values {
        assert!(
            (level - 20.0 * 0.5f64.log10()).abs() < 1e-9,
            "level {level}"
        );
    }
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
