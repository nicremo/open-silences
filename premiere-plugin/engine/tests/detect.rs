//! Behavior tests for the pause detector. Every case maps to a rule in
//! docs/DETECTION.md.

use silences_engine::detect::{detect_pauses, kept_segments, DetectionSettings, Levels};

const BLOCK: f64 = 0.01;

/// Builds block levels from (seconds, dBFS) parts.
fn levels(parts: &[(f64, f64)]) -> Levels {
    let mut db = Vec::new();
    for (seconds, level) in parts {
        let blocks = (seconds / BLOCK).round() as usize;
        db.extend(std::iter::repeat_n(*level, blocks));
    }
    let duration = db.len() as f64 * BLOCK;
    Levels {
        db,
        block_seconds: BLOCK,
        duration,
    }
}

fn settings() -> DetectionSettings {
    DetectionSettings {
        threshold_db: -40.0,
        min_pause: 0.3,
        min_speech: 0.15,
        lead_in: 0.0,
        tail: 0.0,
    }
}

fn assert_ranges(actual: &[(f64, f64)], expected: &[(f64, f64)]) {
    assert_eq!(actual.len(), expected.len(), "{actual:?} vs {expected:?}");
    for (a, e) in actual.iter().zip(expected) {
        assert!(
            (a.0 - e.0).abs() < 1e-9 && (a.1 - e.1).abs() < 1e-9,
            "{actual:?} vs {expected:?}"
        );
    }
}

#[test]
fn long_pause_between_speech_is_reported() {
    let input = levels(&[(1.0, -20.0), (1.0, -60.0), (1.0, -20.0)]);
    assert_ranges(&detect_pauses(&input, &settings()), &[(1.0, 2.0)]);
}

#[test]
fn pause_shorter_than_min_pause_stays() {
    let input = levels(&[(1.0, -20.0), (0.2, -60.0), (1.0, -20.0)]);
    assert_ranges(&detect_pauses(&input, &settings()), &[]);
}

#[test]
fn lead_in_and_tail_keep_air_around_speech() {
    let input = levels(&[(1.0, -20.0), (1.0, -60.0), (1.0, -20.0)]);
    let padded = DetectionSettings {
        lead_in: 0.1,
        tail: 0.2,
        ..settings()
    };
    assert_ranges(&detect_pauses(&input, &padded), &[(1.2, 1.9)]);
}

#[test]
fn leading_and_trailing_pauses_keep_their_outer_edge() {
    let input = levels(&[(0.5, -60.0), (1.0, -20.0), (0.5, -60.0)]);
    let padded = DetectionSettings {
        lead_in: 0.1,
        tail: 0.2,
        ..settings()
    };
    assert_ranges(&detect_pauses(&input, &padded), &[(0.0, 0.4), (1.7, 2.0)]);
}

#[test]
fn quiet_short_blip_inside_a_pause_is_ignored() {
    let input = levels(&[
        (1.0, -20.0),
        (0.6, -60.0),
        (0.1, -35.0),
        (0.6, -60.0),
        (1.0, -20.0),
    ]);
    assert_ranges(&detect_pauses(&input, &settings()), &[(1.0, 2.3)]);
}

#[test]
fn short_loud_word_is_kept() {
    let input = levels(&[
        (1.0, -20.0),
        (0.6, -60.0),
        (0.1, -20.0),
        (0.6, -60.0),
        (1.0, -20.0),
    ]);
    assert_ranges(
        &detect_pauses(&input, &settings()),
        &[(1.0, 1.6), (1.7, 2.3)],
    );
}

#[test]
fn soft_word_with_a_dip_is_judged_as_one_region() {
    let input = levels(&[
        (1.0, -20.0),
        (1.0, -60.0),
        (0.08, -38.0),
        (0.04, -60.0),
        (0.08, -38.0),
        (1.0, -60.0),
        (1.0, -20.0),
    ]);
    assert_ranges(
        &detect_pauses(&input, &settings()),
        &[(1.0, 2.0), (2.2, 3.2)],
    );
}

#[test]
fn level_equal_to_the_threshold_is_audible() {
    let at = levels(&[(1.0, -20.0), (0.5, -40.0), (1.0, -20.0)]);
    assert_ranges(&detect_pauses(&at, &settings()), &[]);
    let below = levels(&[(1.0, -20.0), (0.5, -40.01), (1.0, -20.0)]);
    assert_ranges(&detect_pauses(&below, &settings()), &[(1.0, 1.5)]);
}

#[test]
fn audio_without_speech_is_one_pause() {
    let input = levels(&[(2.0, -60.0)]);
    assert_ranges(&detect_pauses(&input, &settings()), &[(0.0, 2.0)]);
}

#[test]
fn empty_or_invalid_levels_yield_nothing() {
    let empty = Levels {
        db: vec![],
        block_seconds: BLOCK,
        duration: 1.0,
    };
    assert!(detect_pauses(&empty, &settings()).is_empty());
    let no_duration = Levels {
        db: vec![-60.0; 10],
        block_seconds: BLOCK,
        duration: 0.0,
    };
    assert!(detect_pauses(&no_duration, &settings()).is_empty());
}

#[test]
fn pauses_never_exceed_the_duration() {
    let input = Levels {
        db: vec![-60.0; 5],
        block_seconds: BLOCK,
        duration: 0.025,
    };
    let open = DetectionSettings {
        min_pause: 0.0,
        ..settings()
    };
    assert_ranges(&detect_pauses(&input, &open), &[(0.0, 0.025)]);
}

#[test]
fn kept_segments_are_the_complement() {
    assert_ranges(
        &kept_segments(&[(1.0, 2.0)], 3.0),
        &[(0.0, 1.0), (2.0, 3.0)],
    );
    assert_ranges(&kept_segments(&[(0.0, 1.0)], 1.0), &[]);
    assert_ranges(&kept_segments(&[], 2.0), &[(0.0, 2.0)]);
}

#[test]
fn settings_are_validated() {
    assert!(DetectionSettings::default().validate().is_ok());
    for invalid in [
        DetectionSettings {
            threshold_db: f64::NAN,
            ..settings()
        },
        DetectionSettings {
            threshold_db: 0.5,
            ..settings()
        },
        DetectionSettings {
            threshold_db: -95.0,
            ..settings()
        },
        DetectionSettings {
            min_pause: -0.1,
            ..settings()
        },
        DetectionSettings {
            min_speech: 61.0,
            ..settings()
        },
        DetectionSettings {
            lead_in: f64::INFINITY,
            ..settings()
        },
        DetectionSettings {
            tail: -1.0,
            ..settings()
        },
    ] {
        assert!(invalid.validate().is_err(), "{invalid:?} must be rejected");
    }
}
