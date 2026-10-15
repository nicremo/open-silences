//! Pause detection on levels. Specification: docs/DETECTION.md.

use std::cmp::Ordering;

/// Lowest accepted threshold.
pub const MIN_THRESHOLD_DB: f64 = -90.0;
/// Upper bound for every timing setting.
pub const MAX_TIMING_SECONDS: f64 = 60.0;
/// The minimum pause and the minimum speech never go below this.
pub const MIN_TIMING_SECONDS: f64 = 0.05;
/// An edge this close to the start or the end of the analysed range keeps its
/// place when the air is added.
pub const EDGE_TOLERANCE_SECONDS: f64 = 0.005;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DetectionSettings {
    pub threshold_db: f64,
    /// Shortest cut after the air is removed.
    pub min_pause: f64,
    /// Two cuts whose gap, air included, is shorter than this become one.
    pub min_speech: f64,
    /// Air kept before speech: the end of a pause moves earlier.
    pub lead_in: f64,
    /// Air kept after speech: the start of a pause moves later.
    pub tail: f64,
    /// Neighbouring cuts at most this far apart are thinned out. 0 is off.
    pub min_cut_spacing: f64,
}

impl Default for DetectionSettings {
    fn default() -> Self {
        Self {
            threshold_db: -45.0,
            min_pause: 0.16,
            min_speech: 0.16,
            lead_in: 0.16,
            tail: 0.16,
            min_cut_spacing: 0.0,
        }
    }
}

impl DetectionSettings {
    /// Rejects values that would produce a meaningless or unsafe plan.
    pub fn validate(&self) -> Result<(), String> {
        if !self.threshold_db.is_finite() || !(MIN_THRESHOLD_DB..=0.0).contains(&self.threshold_db)
        {
            return Err(format!(
                "thresholdDb must be between {MIN_THRESHOLD_DB} and 0 dB"
            ));
        }
        for (name, value) in [
            ("minPause", self.min_pause),
            ("minSpeech", self.min_speech),
            ("leadIn", self.lead_in),
            ("tail", self.tail),
            ("minCutSpacing", self.min_cut_spacing),
        ] {
            if !value.is_finite() || !(0.0..=MAX_TIMING_SECONDS).contains(&value) {
                return Err(format!(
                    "{name} must be between 0 and {MAX_TIMING_SECONDS} seconds"
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Levels {
    /// One level per value in dBFS, see docs/DETECTION.md stage 1.
    pub db: Vec<f64>,
    /// Duration of one value in seconds.
    pub block_seconds: f64,
    /// Analysed duration in seconds.
    pub duration: f64,
}

/// Pauses in seconds from the start of the analysed range, stages 2 to 7.
pub fn detect_pauses(levels: &Levels, settings: &DetectionSettings) -> Vec<(f64, f64)> {
    let step = levels.block_seconds;
    let duration = levels.duration;
    if levels.db.is_empty()
        || !step.is_finite()
        || step <= 0.0
        || !duration.is_finite()
        || duration <= 0.0
    {
        return Vec::new();
    }
    let min_pause = settings.min_pause.max(MIN_TIMING_SECONDS);
    let raw = quiet_runs(&levels.db, settings.threshold_db, step);
    let refined = raw
        .into_iter()
        .map(|pause| refine_edges(&levels.db, pause, step))
        .collect();
    let aired = add_air(refined, duration, settings);
    let long = keep_long(aired, min_pause);
    let joined = join_short_speech(long, settings.min_speech.max(MIN_TIMING_SECONDS));
    let long = keep_long(joined, min_pause);
    if settings.min_cut_spacing > 0.0 {
        thin_out(long, settings.min_cut_spacing)
    } else {
        long
    }
}

/// Stage 2: maximal runs of values strictly below the threshold.
fn quiet_runs(db: &[f64], threshold_db: f64, step: f64) -> Vec<(f64, f64)> {
    let mut runs = Vec::new();
    let mut first: Option<usize> = None;
    for (index, level) in db.iter().enumerate() {
        if *level < threshold_db {
            first.get_or_insert(index);
        } else if let Some(start) = first.take() {
            runs.push((start as f64 * step, index as f64 * step));
        }
    }
    if let Some(start) = first {
        runs.push((start as f64 * step, db.len() as f64 * step));
    }
    runs
}

fn power(level: f64) -> f64 {
    10f64.powf(level / 10.0)
}

/// Share of speech in `level` between a loud and a quiet reference level.
fn speech_share(level: f64, loud: f64, quiet: f64) -> f64 {
    let loud_power = power(loud);
    let quiet_power = power(quiet);
    if loud_power <= quiet_power {
        return if level > quiet { 1.0 } else { 0.0 };
    }
    ((power(level) - quiet_power) / (loud_power - quiet_power)).clamp(0.0, 1.0)
}

/// Stage 3: both edges move inside their neighbouring values by energy.
fn refine_edges(db: &[f64], (start, end): (f64, f64), step: f64) -> (f64, f64) {
    let last = db.len() as i64 - 1;
    let at = |index: i64| db[index.clamp(0, last) as usize];
    let first = (start / step).round() as i64;
    let next = (end / step).round() as i64;
    let mut refined_start = start;
    if first > 0 {
        let loud = at(first - 2);
        let quiet = at(next.min(first + 1));
        let share = speech_share(at(first - 1), loud, quiet) + speech_share(at(first), loud, quiet);
        refined_start = (first as f64 - 1.0 + share) * step;
    }
    let mut refined_end = end;
    if next <= last {
        let loud = at(next + 1);
        let quiet = at(first.max(next - 2));
        let share = speech_share(at(next), loud, quiet) + speech_share(at(next - 1), loud, quiet);
        refined_end = (next as f64 + 1.0 - share) * step;
    }
    if !refined_start.is_finite() || !refined_end.is_finite() || refined_start >= refined_end {
        return (start, end);
    }
    (refined_start, refined_end)
}

fn within(edge: f64, value: f64) -> bool {
    edge - EDGE_TOLERANCE_SECONDS <= value && value <= edge + EDGE_TOLERANCE_SECONDS
}

/// Stage 4: air on both sides, then an ordered merge.
fn add_air(
    pauses: Vec<(f64, f64)>,
    duration: f64,
    settings: &DetectionSettings,
) -> Vec<(f64, f64)> {
    let mut aired: Vec<(f64, f64)> = pauses
        .into_iter()
        .map(|(start, end)| {
            let start = if within(0.0, start) {
                start
            } else {
                duration.min(start + settings.tail)
            };
            let end = if within(duration, end) {
                end
            } else {
                0f64.max(end - settings.lead_in)
            };
            (start, end)
        })
        .collect();
    aired.sort_by(|first, second| first.0.partial_cmp(&second.0).unwrap_or(Ordering::Equal));
    let mut merged: Vec<(f64, f64)> = Vec::with_capacity(aired.len());
    for pause in aired {
        // A pause joins unless the current one ends strictly before it starts.
        let ends_before = current_ends_before(merged.last(), pause.0);
        match merged.last_mut() {
            Some(current) if !ends_before => current.1 = current.1.max(pause.1),
            _ => merged.push(pause),
        }
    }
    merged
}

/// True when there is a current pause and it ends strictly before `start`.
fn current_ends_before(current: Option<&(f64, f64)>, start: f64) -> bool {
    current.is_some_and(|pause| pause.1.partial_cmp(&start) == Some(Ordering::Less))
}

/// Stage 5: only pauses of at least the minimum length stay.
fn keep_long(pauses: Vec<(f64, f64)>, min_pause: f64) -> Vec<(f64, f64)> {
    pauses
        .into_iter()
        .filter(|(start, end)| end - start >= min_pause)
        .collect()
}

/// Stage 6: a gap shorter than the minimum speech joins both pauses.
fn join_short_speech(mut pauses: Vec<(f64, f64)>, min_speech: f64) -> Vec<(f64, f64)> {
    let mut index = 0;
    while index + 1 < pauses.len() {
        if pauses[index + 1].0 - pauses[index].1 < min_speech {
            pauses[index].1 = pauses[index + 1].1;
            pauses.remove(index + 1);
        } else {
            index += 1;
        }
    }
    pauses
}

/// Stage 7: in every chain of close neighbours the longest pause stays uncut,
/// until no neighbours are that close any more.
fn thin_out(mut pauses: Vec<(f64, f64)>, spacing: f64) -> Vec<(f64, f64)> {
    let length = |pause: (f64, f64)| pause.1 - pause.0;
    loop {
        let mut groups: Vec<Vec<usize>> = Vec::new();
        let mut chain: Vec<usize> = Vec::new();
        for index in 0..pauses.len().saturating_sub(1) {
            if pauses[index + 1].0 - pauses[index].1 <= spacing {
                if chain.is_empty() {
                    chain.push(index);
                }
                chain.push(index + 1);
            } else if !chain.is_empty() {
                groups.push(std::mem::take(&mut chain));
            }
        }
        if !chain.is_empty() {
            groups.push(chain);
        }
        if groups.is_empty() {
            return pauses;
        }
        let mut longest: Vec<usize> = groups
            .iter()
            .map(|group| {
                let mut best = group[0];
                for &index in &group[1..] {
                    if length(pauses[index]) > length(pauses[best]) {
                        best = index;
                    }
                }
                best
            })
            .collect();
        longest.sort_unstable_by(|first, second| second.cmp(first));
        for index in longest {
            pauses.remove(index);
        }
    }
}

/// The material that stays: the complement of the pauses inside `[0, duration]`.
pub fn kept_segments(pauses: &[(f64, f64)], duration: f64) -> Vec<(f64, f64)> {
    let mut kept = Vec::with_capacity(pauses.len() + 1);
    let mut cursor = 0.0;
    for &(start, end) in pauses {
        if start > cursor {
            kept.push((cursor, start));
        }
        cursor = end;
    }
    if duration > cursor {
        kept.push((cursor, duration));
    }
    kept
}
