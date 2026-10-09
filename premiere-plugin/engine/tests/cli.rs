//! CLI contract tests: argument validation, exit codes and the stdin guard.

use std::process::Command;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_silences-engine")
}

fn run(args: &[&str]) -> (i32, String, String) {
    let output = Command::new(binary())
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .expect("engine binary must run");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}

#[test]
fn version_is_printed() {
    let (code, stdout, _) = run(&["version"]);
    assert_eq!(code, 0);
    assert!(
        stdout.trim().starts_with("2.0.0"),
        "unexpected version: {stdout}"
    );
}

#[test]
fn unknown_option_is_a_usage_error() {
    let (code, _, stderr) = run(&["analyze", "file.wav", "--does-not-exist"]);
    assert_eq!(code, 2, "stderr: {stderr}");
    assert!(stderr.contains("unknown option"));
}

/// The detector accepts thresholds from -90 dB to 0 dB. A valid value reaches
/// the decoder and fails there with a runtime error because the file is absent.
#[test]
fn threshold_range_is_enforced() {
    for (value, expected) in [("-95", 2), ("0.5", 2), ("nan", 2), ("-60", 1), ("-20", 1)] {
        let (code, _, stderr) = run(&["analyze", "file.wav", "--threshold-db", value]);
        assert_eq!(code, expected, "value {value}: stderr {stderr}");
    }
}

/// stdin cannot be both the snapshot source and the cancellation channel.
#[test]
fn watch_stdin_with_stdin_snapshot_is_rejected() {
    let (code, _, stderr) = run(&["plan", "--watch-stdin"]);
    assert_eq!(code, 2, "stderr: {stderr}");
    assert!(
        stderr.contains("--watch-stdin cannot be combined"),
        "unexpected message: {stderr}"
    );

    let (code, _, stderr) = run(&["plan", "--watch-stdin", "--input", "-"]);
    assert_eq!(code, 2, "stderr: {stderr}");
    assert!(stderr.contains("--watch-stdin cannot be combined"));
}

/// A snapshot file is the supported path for the panel.
#[test]
fn plan_rejects_a_broken_snapshot() {
    let directory =
        std::env::temp_dir().join(format!("silences-engine-cli-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("snapshot.json");
    // Exit code 2: the caller can fix the snapshot, it is not a runtime fault.
    std::fs::write(&path, b"{ not json").unwrap();
    let (code, _, stderr) = run(&["plan", "--input", path.to_str().unwrap()]);
    assert_eq!(code, 2, "stderr: {stderr}");
    assert!(
        stderr.contains("invalid snapshot"),
        "unexpected message: {stderr}"
    );

    // A minimal but incomplete snapshot must fail on the missing safety fields.
    std::fs::write(&path, br#"{"analysisSource":"raw_sources"}"#).unwrap();
    let (code, _, stderr) = run(&["plan", "--input", path.to_str().unwrap()]);
    assert_eq!(code, 2, "stderr: {stderr}");
    assert!(
        stderr.contains("invalid snapshot"),
        "unexpected message: {stderr}"
    );

    let (code, _, stderr) = run(&["plan", "--input", "/nonexistent/snapshot.json"]);
    assert_eq!(code, 1, "a missing file is a runtime failure: {stderr}");
}
