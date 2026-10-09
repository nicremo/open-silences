//! Block levels in dBFS. Specification: docs/DETECTION.md, stage 1 and the
//! threshold suggestion.

/// Analysis blocks per second requested from the PCM readers (about 10 ms).
pub const BLOCKS_PER_SECOND: f64 = 100.0;

/// Quietest reported level. Digital silence maps here.
pub const FLOOR_DB: f64 = -100.0;

/// RMS amplitude to dBFS, unrounded and floored at `FLOOR_DB`.
pub fn amplitude_to_db(rms: f64) -> f64 {
    if !rms.is_finite() || rms <= 0.0 {
        return FLOOR_DB;
    }
    (20.0 * rms.log10()).max(FLOOR_DB)
}

/// Blocks at or below this level are digital silence from gaps, noise gates or
/// denoisers, not room tone.
pub const DIGITAL_SILENCE_DB: f64 = -90.0;

/// Distance between the speech level and the highest allowed threshold.
const SPEECH_MARGIN_DB: f64 = 16.0;
/// Distance between the quiet level and the threshold.
const QUIET_MARGIN_DB: f64 = 6.0;
/// Minimum distance between quiet level and speech for a usable quiet level.
const MIN_SEPARATION_DB: f64 = 12.0;
/// Quiet level assumed when the pauses are digital silence.
const GATED_QUIET_DB: f64 = -72.0;

/// Threshold suggestion from block levels, see docs/DETECTION.md.
pub fn suggest_threshold(levels: &[f64]) -> Option<f64> {
    if levels.iter().any(|level| !level.is_finite()) {
        return None;
    }
    let mut audible: Vec<f64> = levels
        .iter()
        .copied()
        .filter(|level| *level > DIGITAL_SILENCE_DB)
        .collect();
    if audible.len() < BLOCKS_PER_SECOND as usize {
        return None;
    }
    let gated_share = (levels.len() - audible.len()) as f64 / levels.len() as f64;
    audible.sort_by(f64::total_cmp);
    let speech = percentile(&audible, 0.9);
    if speech < -50.0 {
        return None;
    }
    let ceiling = speech - SPEECH_MARGIN_DB;
    let measured = match quiet_peak(&audible, percentile(&audible, 0.5)) {
        Some(peak) if speech - peak >= MIN_SEPARATION_DB => Some(peak),
        Some(_) => None,
        None if gated_share >= 0.05 => None,
        None => {
            let low = percentile(&audible, 0.05);
            (speech - low >= MIN_SEPARATION_DB).then_some(low)
        }
    };
    let quiet = match measured {
        Some(level) => level,
        None if gated_share >= 0.05 => GATED_QUIET_DB,
        None => return None,
    };
    // Lower edge of speech: the quiet end of the blocks clearly above the room.
    let speech_blocks: Vec<f64> = audible
        .iter()
        .copied()
        .filter(|level| *level >= quiet + MIN_SEPARATION_DB)
        .collect();
    if speech_blocks.is_empty() {
        return None;
    }
    let speech_edge = percentile(&speech_blocks, 0.1);
    let suggestion = ((quiet + speech_edge) / 2.0)
        .max(quiet + QUIET_MARGIN_DB)
        .min(ceiling);
    Some((suggestion.clamp(-60.0, -20.0) * 10.0).round() / 10.0)
}

/// Value at quantile `q` of an ascending slice.
fn percentile(sorted: &[f64], q: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * q).round() as usize]
}

/// Lowest clear peak of the level histogram below the median: 1 dB bins from
/// -90 dBFS, smoothed over three bins, holding at least 2 percent of the blocks
/// and followed by a valley of at most half its height 3 to 12 dB above it.
/// Returns the mean level of the blocks around the peak.
fn quiet_peak(sorted: &[f64], median: f64) -> Option<f64> {
    const BINS: usize = 90;
    let mut counts = [0usize; BINS];
    let mut sums = [0.0f64; BINS];
    for level in sorted {
        let bin = ((level - DIGITAL_SILENCE_DB).floor().max(0.0) as usize).min(BINS - 1);
        counts[bin] += 1;
        sums[bin] += level;
    }
    let window = |bin: usize| bin.saturating_sub(1)..(bin + 2).min(BINS);
    let smoothed: Vec<usize> = (0..BINS)
        .map(|bin| counts[window(bin)].iter().sum())
        .collect();
    let minimum = (sorted.len() / 50).max(1);
    for peak in 1..BINS - 1 {
        if DIGITAL_SILENCE_DB + peak as f64 >= median {
            break;
        }
        let height = smoothed[peak];
        if height < minimum || height < smoothed[peak - 1] || height < smoothed[peak + 1] {
            continue;
        }
        let valley = (peak + 3..=(peak + 12).min(BINS - 1))
            .map(|bin| smoothed[bin])
            .min()
            .unwrap_or(height);
        if valley * 2 <= height {
            let blocks: usize = counts[window(peak)].iter().sum();
            let total: f64 = sums[window(peak)].iter().sum();
            return Some(total / blocks as f64);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amplitude_maps_to_dbfs_without_rounding() {
        assert_eq!(amplitude_to_db(1.0), 0.0);
        assert!((amplitude_to_db(0.5) - 20.0 * 0.5f64.log10()).abs() < 1e-12);
        assert_eq!(amplitude_to_db(0.0), FLOOR_DB);
        assert_eq!(amplitude_to_db(-0.25), FLOOR_DB);
        assert_eq!(amplitude_to_db(1e-9), FLOOR_DB);
        assert_eq!(amplitude_to_db(f64::NAN), FLOOR_DB);
        assert_eq!(amplitude_to_db(f64::INFINITY), FLOOR_DB);
    }

    #[test]
    fn suggestion_needs_separate_quiet_and_loud_levels() {
        let mut levels = vec![-50.0; 50];
        levels.extend(vec![-20.0; 200]);
        assert_eq!(suggest_threshold(&levels), Some(-36.0));

        // Gated pauses: the quiet level counts as -72 dB, never as -100 dB.
        let mut digital = vec![-100.0; 30];
        digital.extend(vec![-20.0; 200]);
        assert_eq!(suggest_threshold(&digital), Some(-46.0));

        assert_eq!(suggest_threshold(&vec![-20.0; 200]), None);
        assert_eq!(suggest_threshold(&vec![-70.0; 200]), None);
        assert_eq!(suggest_threshold(&vec![-20.0; 99]), None);
        assert_eq!(suggest_threshold(&[f64::NAN; 200]), None);
    }

    /// Speech levels spread over 20 dB, like real words and syllables.
    fn speech(blocks: usize) -> Vec<f64> {
        (0..blocks)
            .map(|index| -35.0 + (index % 21) as f64)
            .collect()
    }

    #[test]
    fn digital_silence_from_gaps_does_not_drag_the_suggestion_down() {
        // Gaps without dialogue render as digital silence, pauses hold room tone.
        let mut levels = vec![-100.0; 300];
        levels.extend(vec![-55.0; 100]);
        levels.extend(vec![-20.0; 600]);
        assert_eq!(suggest_threshold(&levels), Some(-37.5));
    }

    #[test]
    fn rare_pauses_still_find_the_room_tone() {
        // Only 5 percent pauses: a 10th percentile would land inside speech.
        let mut levels = vec![-58.0; 50];
        levels.extend(speech(950));
        assert_eq!(suggest_threshold(&levels), Some(-45.5));
    }

    #[test]
    fn gated_pauses_put_the_threshold_below_speech() {
        let mut levels = vec![-100.0; 300];
        levels.extend(speech(700));
        let suggestion = suggest_threshold(&levels).unwrap();
        assert_eq!(suggestion, -52.5);
    }

    #[test]
    fn the_suggestion_never_reaches_into_speech() {
        // Loud room tone close to speech: the cap 16 dB below speech wins.
        let mut levels = vec![-40.0; 200];
        levels.extend(vec![-22.0; 800]);
        assert_eq!(suggest_threshold(&levels), Some(-38.0));
    }

    #[test]
    fn quiet_room_with_breaths_lands_in_the_middle_of_the_gap() {
        // Good microphone: room tone at -68 dB, breaths at -55 dB, speech from
        // -28 dB. Room tone plus 6 dB would keep every breath as speech.
        let mut levels = vec![-68.0; 1000];
        levels.extend(vec![-55.0; 100]);
        levels.extend((0..3900).map(|index| -28.0 + (index % 15) as f64));
        assert_eq!(suggest_threshold(&levels), Some(-47.5));
    }
}
