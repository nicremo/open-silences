//! Levels in dBFS. Specification: docs/DETECTION.md, stage 1 and the threshold
//! suggestion.

/// Analysis values per second (20 ms per value).
pub const VALUES_PER_SECOND: f64 = 50.0;

/// Quietest level. Digital silence and everything quieter maps here.
pub const FLOOR_DB: f64 = -60.0;

/// RMS amplitude to the stored level: dBFS floored at `FLOOR_DB`, kept as a
/// 32 bit float and rounded to two decimals.
pub fn amplitude_to_db(rms: f64) -> f64 {
    let db = if rms.is_finite() && rms > 0.0 {
        (20.0 * rms.log10()).max(FLOOR_DB)
    } else {
        FLOOR_DB
    };
    round_hundredths(db as f32 as f64)
}

/// Rounds to two decimals like a decimal formatter: the exact decimal value of
/// the float decides, halves go away from zero.
pub fn round_hundredths(value: f64) -> f64 {
    if !value.is_finite() || value.abs() >= 1e12 {
        return value;
    }
    let magnitude = value.abs();
    let scaled = magnitude * 100.0;
    let lower = scaled.floor();
    let fraction = scaled - lower;
    // Far from a half the scaled float decides safely. Close to a half only the
    // exact decimal expansion of the value can tell the two sides apart.
    let hundredths = if (fraction - 0.5).abs() > 1e-6 {
        if fraction > 0.5 {
            lower + 1.0
        } else {
            lower
        }
    } else {
        exact_hundredths(magnitude)
    };
    let rounded = hundredths / 100.0;
    if value.is_sign_negative() {
        -rounded
    } else {
        rounded
    }
}

/// Hundredths of a non negative value from its exact decimal expansion.
fn exact_hundredths(magnitude: f64) -> f64 {
    let text = format!("{magnitude:.80}");
    let (whole, fraction) = text.split_once('.').unwrap_or((&text, "000"));
    let digits: Vec<u64> = fraction
        .bytes()
        .map(|byte| u64::from(byte - b'0'))
        .collect();
    let whole: u64 = whole.parse().unwrap_or(0);
    let mut hundredths = whole * 100 + digits[0] * 10 + digits[1];
    if digits[2] >= 5 {
        hundredths += 1;
    }
    hundredths as f64
}

/// Most rounds of the two group split.
const MAX_ROUNDS: usize = 50;
/// A centre has settled when it moved by less than this share of its value.
const SETTLED_SHARE: f64 = 0.0001;

/// Threshold suggestion, see docs/DETECTION.md: the levels split into a quiet
/// and a loud group, the suggestion is the top of the quiet group in whole dB.
pub fn suggest_threshold(levels: &[f64]) -> Option<f64> {
    if levels.is_empty() || levels.iter().any(|level| !level.is_finite()) {
        return None;
    }
    let lowest = levels.iter().copied().fold(f64::INFINITY, f64::min);
    let highest = levels.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if lowest == highest {
        return Some(round_half_up(highest));
    }
    let mut centres = [lowest, highest];
    let mut quiet_top = lowest;
    for _ in 0..MAX_ROUNDS {
        // Assignment with the current centres; a tie joins the quiet group.
        let mut sums = [0.0f64; 2];
        let mut counts = [0usize; 2];
        quiet_top = f64::NEG_INFINITY;
        for &level in levels {
            let group = usize::from((level - centres[1]).abs() < (level - centres[0]).abs());
            sums[group] += level;
            counts[group] += 1;
            if group == 0 {
                quiet_top = quiet_top.max(level);
            }
        }
        let moved = [0, 1].map(|group| {
            if counts[group] == 0 {
                centres[group]
            } else {
                sums[group] / counts[group] as f64
            }
        });
        let settled = (0..2)
            .all(|group| ((centres[group] - moved[group]) / centres[group]).abs() < SETTLED_SHARE);
        centres = moved;
        if settled {
            break;
        }
    }
    Some(round_half_up(quiet_top))
}

/// Whole number, halves rounded up.
fn round_half_up(value: f64) -> f64 {
    (value + 0.5).floor()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amplitude_maps_to_rounded_dbfs_with_a_floor() {
        assert_eq!(amplitude_to_db(1.0), 0.0);
        assert_eq!(amplitude_to_db(0.5), -6.02);
        assert_eq!(amplitude_to_db(0.1), -20.0);
        assert_eq!(amplitude_to_db(0.0), FLOOR_DB);
        assert_eq!(amplitude_to_db(-0.25), FLOOR_DB);
        assert_eq!(amplitude_to_db(1e-9), FLOOR_DB);
        assert_eq!(amplitude_to_db(f64::NAN), FLOOR_DB);
        assert_eq!(amplitude_to_db(f64::INFINITY), FLOOR_DB);
        // Just above the floor stays above it.
        assert_eq!(amplitude_to_db(0.001001), -59.99);
    }

    #[test]
    fn hundredths_follow_the_exact_decimal_value_with_halves_away_from_zero() {
        // Exact binary halves round away from zero.
        assert_eq!(round_hundredths(0.125), 0.13);
        assert_eq!(round_hundredths(-0.125), -0.13);
        assert_eq!(round_hundredths(0.375), 0.38);
        // 1.005 and 2.675 are stored slightly below the half.
        assert_eq!(round_hundredths(1.005), 1.0);
        assert_eq!(round_hundredths(2.675), 2.67);
        assert_eq!(round_hundredths(-45.005), -45.01);
        assert_eq!(round_hundredths(-59.995), -59.99);
        assert_eq!(round_hundredths(12.345), 12.35);
        assert_eq!(round_hundredths(-0.001), 0.0);
        assert_eq!(round_hundredths(-41.237), -41.24);
    }

    #[test]
    fn the_suggestion_is_the_top_of_the_quiet_group() {
        // 40 percent room tone at -58 dB, 60 percent speech from -35 to -15 dB.
        let mut levels = vec![-58.0; 400];
        levels.extend((0..600).map(|index| -35.0 + 20.0 * index as f64 / 599.0));
        assert_eq!(suggest_threshold(&levels), Some(-58.0));

        // Breaths between room tone and speech belong to the quiet group.
        let mut levels = vec![-62.0f64.max(FLOOR_DB); 300];
        levels.extend(vec![-48.3; 100]);
        levels.extend(vec![-20.0; 600]);
        assert_eq!(suggest_threshold(&levels), Some(-48.0));
    }

    #[test]
    fn the_suggestion_rounds_halves_up_and_handles_edge_cases() {
        assert_eq!(
            suggest_threshold(&[-45.5, -45.5, -10.0, -10.0]),
            Some(-45.0)
        );
        assert_eq!(
            suggest_threshold(&[-45.6, -45.6, -10.0, -10.0]),
            Some(-46.0)
        );
        assert_eq!(suggest_threshold(&[-33.0; 10]), Some(-33.0));
        assert_eq!(suggest_threshold(&[]), None);
        assert_eq!(suggest_threshold(&[-30.0, f64::NAN]), None);
        // A centre at exactly 0 never settles; the split still ends after 50 rounds.
        assert_eq!(suggest_threshold(&[0.0, 0.0, -60.0]), Some(-60.0));
    }

    #[test]
    fn the_float_step_happens_before_the_rounding() {
        // A level that only a 32 bit float moves across the half.
        let level = -45.004_999_9f64;
        assert_eq!(round_hundredths(level), -45.0);
        assert_eq!(round_hundredths(level as f32 as f64), -45.01);
    }
}
