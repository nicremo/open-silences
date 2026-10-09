//! Pause detection on block levels. Specification: docs/DETECTION.md.

/// A short region with a peak this far above the threshold is speech.
pub const BLIP_HEADROOM_DB: f64 = 10.0;
/// Lowest accepted threshold.
pub const MIN_THRESHOLD_DB: f64 = -90.0;
/// Upper bound for every timing setting.
pub const MAX_TIMING_SECONDS: f64 = 60.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DetectionSettings {
    pub threshold_db: f64,
    pub min_pause: f64,
    pub min_speech: f64,
    pub lead_in: f64,
    pub tail: f64,
}

impl Default for DetectionSettings {
    fn default() -> Self {
        Self {
            threshold_db: -45.0,
            min_pause: 0.16,
            min_speech: 0.16,
            lead_in: 0.16,
            tail: 0.16,
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
    pub db: Vec<f64>,
    pub block_seconds: f64,
    pub duration: f64,
}

/// Consecutive audible blocks `[start, end)` and their peak level.
#[derive(Debug, Clone, Copy)]
struct Region {
    start: usize,
    end: usize,
    peak_db: f64,
}

fn blocks_for(seconds: f64, block_seconds: f64) -> usize {
    (seconds / block_seconds).round().max(0.0) as usize
}

/// Stage 2: blocks at or above the threshold form regions.
fn audible_regions(db: &[f64], threshold_db: f64) -> Vec<Region> {
    let mut regions = Vec::new();
    let mut current: Option<Region> = None;
    for (index, level) in db.iter().copied().enumerate() {
        if level >= threshold_db {
            match current.as_mut() {
                Some(region) => {
                    region.end = index + 1;
                    region.peak_db = region.peak_db.max(level);
                }
                None => {
                    current = Some(Region {
                        start: index,
                        end: index + 1,
                        peak_db: level,
                    })
                }
            }
        } else if let Some(region) = current.take() {
            regions.push(region);
        }
    }
    regions.extend(current);
    regions
}

/// Stage 3: gaps shorter than the minimum pause join their neighbours.
fn bridge_short_pauses(regions: Vec<Region>, min_pause_blocks: usize) -> Vec<Region> {
    let mut bridged: Vec<Region> = Vec::with_capacity(regions.len());
    for region in regions {
        match bridged.last_mut() {
            Some(last) if region.start - last.end < min_pause_blocks => {
                last.end = region.end;
                last.peak_db = last.peak_db.max(region.peak_db);
            }
            _ => bridged.push(region),
        }
    }
    bridged
}

/// Stage 4: short regions without a clear peak are noise.
fn drop_quiet_blips(
    regions: Vec<Region>,
    min_speech_blocks: usize,
    clear_peak_db: f64,
) -> Vec<Region> {
    regions
        .into_iter()
        .filter(|region| {
            region.end - region.start >= min_speech_blocks || region.peak_db >= clear_peak_db
        })
        .collect()
}

/// Gaps between regions as block ranges, including both outer gaps.
fn gaps(regions: &[Region], block_count: usize) -> Vec<(usize, usize)> {
    let mut result = Vec::with_capacity(regions.len() + 1);
    let mut cursor = 0;
    for region in regions {
        if region.start > cursor {
            result.push((cursor, region.start));
        }
        cursor = region.end;
    }
    if block_count > cursor {
        result.push((cursor, block_count));
    }
    result
}

/// Removable pauses in seconds, see docs/DETECTION.md stages 2 to 5.
pub fn detect_pauses(levels: &Levels, settings: &DetectionSettings) -> Vec<(f64, f64)> {
    let block = levels.block_seconds;
    let duration = levels.duration;
    if levels.db.is_empty()
        || block.is_nan()
        || block <= 0.0
        || duration.is_nan()
        || duration <= 0.0
    {
        return Vec::new();
    }
    let min_pause_blocks = blocks_for(settings.min_pause, block);
    let regions = audible_regions(&levels.db, settings.threshold_db);
    let regions = bridge_short_pauses(regions, min_pause_blocks);
    let regions = drop_quiet_blips(
        regions,
        blocks_for(settings.min_speech, block),
        settings.threshold_db + BLIP_HEADROOM_DB,
    );
    let block_count = levels.db.len();
    gaps(&regions, block_count)
        .into_iter()
        .filter(|(first, last)| last - first >= min_pause_blocks)
        .filter_map(|(first, last)| {
            let mut start = (first as f64 * block).min(duration);
            let mut end = (last as f64 * block).min(duration);
            if first > 0 {
                start += settings.tail;
            }
            if last < block_count {
                end -= settings.lead_in;
            }
            (end > start).then_some((start, end))
        })
        .collect()
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
