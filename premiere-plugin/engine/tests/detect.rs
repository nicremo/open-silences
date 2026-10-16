//! Behavior tests for the pause detector. Every case maps to a rule in
//! docs/DETECTION.md. Expected values are worked out by hand from the rules.

use silences_engine::detect::{detect_pauses, kept_segments, DetectionSettings, Levels};

const STEP: f64 = 0.02;

/// Builds levels from (seconds, dBFS) parts on the 50 per second grid.
fn levels(parts: &[(f64, f64)]) -> Levels {
    let mut db = Vec::new();
    for (seconds, level) in parts {
        let values = (seconds / STEP).round() as usize;
        db.extend(std::iter::repeat_n(*level, values));
    }
    let duration = db.len() as f64 / 50.0;
    Levels {
        db,
        block_seconds: STEP,
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
        min_cut_spacing: 0.0,
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

fn power(level: f64) -> f64 {
    10f64.powf(level / 10.0)
}

#[test]
fn a_quiet_run_between_speech_is_a_pause() {
    let input = levels(&[(1.0, -20.0), (1.0, -60.0), (1.0, -20.0)]);
    assert_ranges(&detect_pauses(&input, &settings()), &[(1.0, 2.0)]);
}

#[test]
fn a_level_equal_to_the_threshold_is_speech() {
    let input = levels(&[(1.0, -20.0), (1.0, -40.0), (1.0, -20.0)]);
    assert_ranges(&detect_pauses(&input, &settings()), &[]);
    let input = levels(&[(1.0, -20.0), (1.0, -40.01), (1.0, -20.0)]);
    assert_ranges(&detect_pauses(&input, &settings()), &[(1.0, 2.0)]);
}

#[test]
fn a_fading_word_moves_the_start_into_the_value_where_it_fades() {
    // Speech, then -30 (still speech at -45), then -50 (quiet), then floor.
    let mut parts = vec![(1.0, -20.0), (STEP, -30.0), (STEP, -50.0), (0.96, -60.0)];
    parts.push((1.0, -20.0));
    let input = levels(&parts);
    let quiet = DetectionSettings {
        threshold_db: -45.0,
        ..settings()
    };
    // Raw pause from value 51. Loud reference value 49, quiet reference value 52.
    let share = |level: f64| (power(level) - power(-60.0)) / (power(-20.0) - power(-60.0));
    let start = (50.0 + share(-30.0) + share(-50.0)) * STEP;
    assert!((51.0 * STEP - start - 0.018).abs() < 0.0005, "{start}");
    assert_ranges(&detect_pauses(&input, &quiet), &[(start, 2.0)]);
}

#[test]
fn a_soft_onset_moves_the_end_later() {
    let input = levels(&[
        (1.0, -20.0),
        (0.96, -60.0),
        (STEP, -55.0),
        (STEP, -35.0),
        (1.0, -20.0),
    ]);
    let quiet = DetectionSettings {
        threshold_db: -45.0,
        ..settings()
    };
    // The run ends before value 99 (-35). Loud reference value 100, quiet
    // reference value 97.
    let share = |level: f64| (power(level) - power(-60.0)) / (power(-20.0) - power(-60.0));
    let end = (100.0 - share(-35.0) - share(-55.0)) * STEP;
    assert!((end - 99.0 * STEP - 0.0194).abs() < 0.0005, "{end}");
    assert_ranges(&detect_pauses(&input, &quiet), &[(1.0, end)]);
}

#[test]
fn air_comes_off_before_the_minimum_pause_is_checked() {
    let padded = DetectionSettings {
        min_pause: 0.16,
        lead_in: 0.16,
        tail: 0.16,
        ..settings()
    };
    // 0.46 s minus 0.32 s of air leaves 0.14 s: shorter than 0.16 s, no cut.
    let short = levels(&[(1.0, -20.0), (0.46, -60.0), (1.0, -20.0)]);
    assert_ranges(&detect_pauses(&short, &padded), &[]);
    // 0.5 s leaves 0.18 s.
    let long = levels(&[(1.0, -20.0), (0.5, -60.0), (1.0, -20.0)]);
    assert_ranges(&detect_pauses(&long, &padded), &[(1.16, 1.34)]);
}

#[test]
fn edges_at_the_start_and_the_end_keep_their_place() {
    let input = levels(&[(0.5, -60.0), (1.0, -20.0), (0.5, -60.0)]);
    let padded = DetectionSettings {
        min_pause: 0.25,
        lead_in: 0.2,
        tail: 0.2,
        ..settings()
    };
    assert_ranges(&detect_pauses(&input, &padded), &[(0.0, 0.3), (1.7, 2.0)]);
}

#[test]
fn short_speech_is_cut_with_its_neighbours_only_when_the_air_is_smaller() {
    let input = levels(&[
        (1.0, -20.0),
        (1.0, -60.0),
        (0.1, -20.0),
        (1.0, -60.0),
        (1.0, -20.0),
    ]);
    // Without air the 0.1 s gap is shorter than 0.15 s: one cut.
    assert_ranges(&detect_pauses(&input, &settings()), &[(1.0, 3.1)]);
    // With 0.1 s of air on both sides the gap is 0.3 s: two cuts.
    let padded = DetectionSettings {
        lead_in: 0.1,
        tail: 0.1,
        ..settings()
    };
    assert_ranges(&detect_pauses(&input, &padded), &[(1.1, 1.9), (2.2, 3.0)]);
}

#[test]
fn the_minimum_pause_and_speech_never_go_below_fifty_milliseconds() {
    let open = DetectionSettings {
        min_pause: 0.0,
        min_speech: 0.0,
        ..settings()
    };
    let input = levels(&[(1.0, -20.0), (0.04, -60.0), (1.0, -20.0)]);
    assert_ranges(&detect_pauses(&input, &open), &[]);
    let input = levels(&[(1.0, -20.0), (0.06, -60.0), (1.0, -20.0)]);
    assert_ranges(&detect_pauses(&input, &open), &[(1.0, 1.06)]);
    // A 0.04 s gap between two cuts is below the 0.05 s floor: one cut.
    let input = levels(&[
        (1.0, -20.0),
        (0.5, -60.0),
        (0.04, -20.0),
        (0.5, -60.0),
        (1.0, -20.0),
    ]);
    assert_ranges(&detect_pauses(&input, &open), &[(1.0, 2.04)]);
}

#[test]
fn cut_spacing_keeps_the_longest_pause_of_each_group() {
    let input = levels(&[
        (1.0, -20.0),
        (0.3, -60.0),
        (0.5, -20.0),
        (0.8, -60.0),
        (0.7, -20.0),
        (0.4, -60.0),
        (1.0, -20.0),
    ]);
    let spaced = DetectionSettings {
        min_pause: 0.25,
        min_speech: 0.0,
        min_cut_spacing: 1.0,
        ..settings()
    };
    assert_ranges(&detect_pauses(&input, &spaced), &[(1.0, 1.3), (3.3, 3.7)]);
    // Off by default.
    let all = DetectionSettings {
        min_cut_spacing: 0.0,
        ..spaced
    };
    assert_eq!(detect_pauses(&input, &all).len(), 3);
}

#[test]
fn on_a_tie_the_first_longest_pause_stays_uncut() {
    let input = levels(&[
        (1.0, -20.0),
        (0.4, -60.0),
        (0.2, -20.0),
        (0.4, -60.0),
        (1.0, -20.0),
    ]);
    let spaced = DetectionSettings {
        min_pause: 0.25,
        min_speech: 0.0,
        min_cut_spacing: 0.5,
        ..settings()
    };
    assert_ranges(&detect_pauses(&input, &spaced), &[(1.6, 2.0)]);
}

#[test]
fn audio_without_speech_is_one_pause() {
    let input = levels(&[(2.0, -60.0)]);
    let padded = DetectionSettings {
        lead_in: 0.3,
        tail: 0.3,
        ..settings()
    };
    assert_ranges(&detect_pauses(&input, &padded), &[(0.0, 2.0)]);
}

#[test]
fn empty_or_invalid_levels_yield_nothing() {
    let empty = Levels {
        db: Vec::new(),
        block_seconds: STEP,
        duration: 0.0,
    };
    assert!(detect_pauses(&empty, &settings()).is_empty());
    let mut invalid = levels(&[(1.0, -60.0)]);
    invalid.block_seconds = 0.0;
    assert!(detect_pauses(&invalid, &settings()).is_empty());
    let mut invalid = levels(&[(1.0, -60.0)]);
    invalid.duration = f64::NAN;
    assert!(detect_pauses(&invalid, &settings()).is_empty());
}

#[test]
fn kept_segments_are_the_complement() {
    let kept = kept_segments(&[(1.0, 2.0), (3.0, 4.0)], 5.0);
    assert_ranges(&kept, &[(0.0, 1.0), (2.0, 3.0), (4.0, 5.0)]);
    assert_ranges(&kept_segments(&[(0.0, 5.0)], 5.0), &[]);
}

#[test]
fn settings_are_validated() {
    assert!(DetectionSettings::default().validate().is_ok());
    for broken in [
        DetectionSettings {
            threshold_db: 1.0,
            ..settings()
        },
        DetectionSettings {
            threshold_db: -91.0,
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
            lead_in: f64::NAN,
            ..settings()
        },
        DetectionSettings {
            tail: f64::INFINITY,
            ..settings()
        },
        DetectionSettings {
            min_cut_spacing: -1.0,
            ..settings()
        },
    ] {
        assert!(broken.validate().is_err(), "{broken:?}");
    }
}
