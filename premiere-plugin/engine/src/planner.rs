//! Cut planning with integer frame and tick arithmetic.
//!
//! The planner never touches the host. It turns a read only timeline snapshot
//! plus per media silence intervals into an explicit list of razor points and
//! per track removal or mute operations. Everything is expressed in Premiere
//! ticks (254016000000 per second) and snapped to whole frames, so the panel and
//! the read back verification compare integers instead of floats.
//!
//! Safety rules implemented here:
//! * the snapshot protocol is typed and complete: every clip and track safety
//!   flag is mandatory, a missing or unknown value is an error, never a guess,
//! * silences are the intersection over the audible, overlapping clips of the
//!   explicitly selected dialogue tracks, so speech on a second microphone is
//!   never deleted and music tracks never drive the analysis,
//! * unsupported clip states (speed, reverse, time remap, nested sequence,
//!   transitions, missing media) are rejected, and a range whose ripple would
//!   also shift such a clip is skipped,
//! * locked tracks are never modified; a ripple range that would have to move
//!   material on a locked track is rejected instead of silently desynchronising
//!   the other tracks,
//! * a muted dialogue track is inaudible and therefore never an analysis source,
//!   but it is still cut like any other audible track if it is not the analysis
//!   source; disabled clips are never analysed and never used as evidence,
//! * exactly one track per time range performs the ripple, identified by kind
//!   and index, so video track 0 and audio track 0 are never confused,
//! * snapping is conservative: a cut starts at the next frame boundary and ends
//!   at the previous one, so it can never extend into speech,
//! * on a rendered timeline only time covered by an enabled clip on a selected
//!   dialogue track can be removed,
//! * a removal shorter than two frames or 100 ms is dropped after snapping.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::audio::ChannelMode;
use crate::detect::DetectionSettings;

/// Premiere Pro ticks per second.
pub const TICKS_PER_SECOND: i64 = 254_016_000_000;

/// Upper bound for one timeline position: 1e17 ticks is about 109 hours, far
/// beyond any realistic sequence, and keeps every later addition away from the
/// i64 limits.
const MAX_TICKS: i64 = 100_000_000_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
}

impl TrackKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TrackKind::Video => "video",
            TrackKind::Audio => "audio",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "video" => Ok(TrackKind::Video),
            "audio" => Ok(TrackKind::Audio),
            other => Err(format!("unknown track kind {other}")),
        }
    }
}

/// Identity of a track. The index alone is ambiguous because video and audio
/// tracks are numbered independently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct TrackId {
    pub kind: TrackKind,
    pub index: i64,
}

impl TrackId {
    pub fn label(&self) -> String {
        format!(
            "{}{}",
            if self.kind == TrackKind::Video {
                "V"
            } else {
                "A"
            },
            self.index
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanMode {
    /// Cut and ripple the silences out.
    DeleteRipple,
    /// Cut and lift the silences, gaps stay.
    DeleteLift,
    /// Cut only, silences stay in place as separate clips.
    KeepCuts,
    /// Cut and disable the audio of the silences.
    Mute,
}

impl PlanMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            PlanMode::DeleteRipple => "delete_ripple",
            PlanMode::DeleteLift => "delete_lift",
            PlanMode::KeepCuts => "keep_cuts",
            PlanMode::Mute => "mute",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "delete" | "delete_ripple" => Ok(PlanMode::DeleteRipple),
            "delete_lift" | "lift" => Ok(PlanMode::DeleteLift),
            "keep" | "keep_cuts" => Ok(PlanMode::KeepCuts),
            "mute" => Ok(PlanMode::Mute),
            other => Err(format!("unknown mode {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RippleDriver {
    VideoFirst,
    AudioFirst,
}

impl RippleDriver {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "video_first" => Ok(RippleDriver::VideoFirst),
            "audio_first" => Ok(RippleDriver::AudioFirst),
            other => Err(format!("unknown ripple driver {other}")),
        }
    }

    fn preferred_kind(&self) -> TrackKind {
        match self {
            RippleDriver::VideoFirst => TrackKind::Video,
            RippleDriver::AudioFirst => TrackKind::Audio,
        }
    }
}

/// Tri-state safety flag. Premiere does not expose every state through every
/// reader (for example `isTimeRemapped` is missing on both the public clip and
/// the QE clip), so "unknown" is a first class value and is always rejected
/// instead of being approximated as false.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafetyFlag {
    No,
    Yes,
    Unknown,
}

impl SafetyFlag {
    fn parse(value: &serde_json::Value, field: &str) -> Result<Self, String> {
        match value {
            serde_json::Value::Bool(true) => Ok(SafetyFlag::Yes),
            serde_json::Value::Bool(false) => Ok(SafetyFlag::No),
            serde_json::Value::Null => Ok(SafetyFlag::Unknown),
            serde_json::Value::String(text) if text == "unknown" => Ok(SafetyFlag::Unknown),
            other => Err(format!(
                "{field} must be true, false or unknown, got {other}"
            )),
        }
    }

    /// Reason for a timing state we cannot reproduce.
    fn timing_reason(&self, field: &str) -> Option<String> {
        match self {
            SafetyFlag::No => None,
            SafetyFlag::Yes => Some(format!("{field} is not supported")),
            SafetyFlag::Unknown => Some(format!("{field} could not be read")),
        }
    }

    /// Reason for an audible state that a raw source analysis cannot reproduce.
    fn audio_reason(&self, field: &str) -> Option<String> {
        match self {
            SafetyFlag::No => None,
            SafetyFlag::Yes => Some(format!(
                "{field} is not reproduced by a raw source analysis"
            )),
            SafetyFlag::Unknown => Some(format!("{field} could not be read")),
        }
    }
}

/// Where the analysed audio comes from. Raw source analysis misses clip gain,
/// effects and channel routing, so those states are rejected instead of guessed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalysisSource {
    /// The host rendered the audible timeline mixdown. Gain and effects are
    /// already part of the rendered audio.
    RenderedMixdown,
    /// Each clip's media file is analysed directly. Only clips without gain,
    /// effects or channel mapping changes are supported.
    RawSources,
}

impl AnalysisSource {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "rendered_mixdown" => Ok(AnalysisSource::RenderedMixdown),
            "raw_sources" => Ok(AnalysisSource::RawSources),
            other => Err(format!("unknown analysisSource {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackRole {
    Dialogue,
    Music,
    Other,
}

impl TrackRole {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "dialogue" => Ok(TrackRole::Dialogue),
            "music" => Ok(TrackRole::Music),
            "other" => Ok(TrackRole::Other),
            other => Err(format!("unknown track role {other}")),
        }
    }
}

// ---------------------------------------------------------------------------
// Snapshot protocol
// ---------------------------------------------------------------------------

fn de_i64_from_string_or_number<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = i64;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("an integer or a decimal integer string")
        }
        fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
            Ok(value)
        }
        fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
            i64::try_from(value).map_err(|_| E::custom("value out of range"))
        }
        fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
            value
                .trim()
                .parse::<i64>()
                .map_err(|_| E::custom("not an integer string"))
        }
    }
    deserializer.deserialize_any(Visitor)
}

fn ser_i64_as_string<S>(value: &i64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&value.to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotJson {
    #[serde(default)]
    pub selected_sections: Option<Vec<SectionJson>>,
    pub analysis_source: String,
    #[serde(default)]
    pub rendered_mixdown: Option<RenderedMixdownJson>,
    pub sequence: SequenceJson,
    pub tracks: Vec<TrackJson>,
    pub analysis_tracks: Vec<TrackRefJson>,
    pub parameters: ParametersJson,
    pub channel_mode: String,
    pub mode: String,
    pub ripple_driver: String,
    pub respect_locks: bool,
}

/// Explicit disjoint editing ranges. The rendered audio still covers the full timeline.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SectionJson {
    #[serde(deserialize_with = "de_i64_from_string_or_number")]
    pub start_ticks: i64,
    #[serde(deserialize_with = "de_i64_from_string_or_number")]
    pub end_ticks: i64,
}

/// A native render covers the entire timeline starting at tick zero. The host
/// must isolate the declared audio tracks on a separate sequence copy.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderedMixdownJson {
    pub media_path: String,
    pub analysis_tracks: Vec<TrackRefJson>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SequenceJson {
    pub name: String,
    pub fps_numerator: i64,
    pub fps_denominator: i64,
    #[serde(deserialize_with = "de_i64_from_string_or_number")]
    pub zero_point_ticks: i64,
    #[serde(deserialize_with = "de_i64_from_string_or_number")]
    pub start_ticks: i64,
    #[serde(deserialize_with = "de_i64_from_string_or_number")]
    pub end_ticks: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackRefJson {
    pub kind: String,
    pub index: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackJson {
    pub kind: String,
    pub index: i64,
    pub name: String,
    pub locked: bool,
    pub muted: bool,
    pub role: String,
    pub clips: Vec<ClipJson>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipJson {
    pub id: String,
    #[serde(deserialize_with = "de_i64_from_string_or_number")]
    pub start_ticks: i64,
    #[serde(deserialize_with = "de_i64_from_string_or_number")]
    pub end_ticks: i64,
    pub in_point_seconds: f64,
    pub out_point_seconds: f64,
    pub speed: f64,
    pub reversed: serde_json::Value,
    pub time_remap: serde_json::Value,
    pub nested: serde_json::Value,
    pub transition_in: serde_json::Value,
    pub transition_out: serde_json::Value,
    /// Present but possibly null. `serde_json::Value` is used on purpose: an
    /// `Option` would silently accept a missing field.
    pub media_path: serde_json::Value,
    pub disabled: bool,
    pub linked: serde_json::Value,
    /// Audio state that raw source analysis cannot reproduce. `null` means the
    /// reader could not determine the value.
    pub gain_db: serde_json::Value,
    pub audio_effects: serde_json::Value,
    pub channel_mapping_changed: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParametersJson {
    pub threshold_db: f64,
    pub min_pause: f64,
    pub min_speech: f64,
    pub lead_in: f64,
    pub tail: f64,
}

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ClipInfo {
    pub id: String,
    pub start_ticks: i64,
    pub end_ticks: i64,
    pub in_point_seconds: f64,
    pub out_point_seconds: f64,
    pub speed: f64,
    pub reversed: SafetyFlag,
    pub time_remap: SafetyFlag,
    pub nested: SafetyFlag,
    pub transition_in: SafetyFlag,
    pub transition_out: SafetyFlag,
    pub media_path: Option<String>,
    pub disabled: bool,
    pub linked: SafetyFlag,
    pub gain_db: Option<f64>,
    pub audio_effects: SafetyFlag,
    pub channel_mapping_changed: SafetyFlag,
}

impl ClipInfo {
    /// Rejects clips whose audible state a raw source analysis would misjudge.
    pub fn audio_state_reason(&self, source: AnalysisSource) -> Option<String> {
        if source == AnalysisSource::RenderedMixdown {
            return None;
        }
        if let Some(reason) = self.audio_effects.audio_reason("clip audio effects") {
            return Some(format!("{reason}, analyse the rendered mixdown instead"));
        }
        if let Some(reason) = self
            .channel_mapping_changed
            .audio_reason("clip channel mapping")
        {
            return Some(format!("{reason}, analyse the rendered mixdown instead"));
        }
        match self.gain_db {
            None => Some(
                "clip gain could not be read, analyse the rendered mixdown instead".to_string(),
            ),
            Some(gain) if !gain.is_finite() => Some("clip gain is not finite".to_string()),
            Some(gain) if gain.abs() > 0.01 => Some(format!(
                "clip gain {gain} dB would not appear in a raw source analysis"
            )),
            _ => None,
        }
    }

    /// Conservative rejection of clip states whose timing cannot be reproduced.
    pub fn unsupported_reason(&self) -> Option<String> {
        if !self.speed.is_finite() || (self.speed - 1.0).abs() > 1e-9 {
            return Some(format!("speed {} is not supported", self.speed));
        }
        for (flag, field) in [
            (self.reversed, "reverse playback"),
            (self.time_remap, "time remapping"),
            (self.nested, "nested sequence"),
            (self.transition_in, "incoming transition"),
            (self.transition_out, "outgoing transition"),
        ] {
            if let Some(reason) = flag.timing_reason(field) {
                return Some(reason);
            }
        }
        if !self.in_point_seconds.is_finite() || !self.out_point_seconds.is_finite() {
            return Some("non finite source in or out point".to_string());
        }
        if self.out_point_seconds <= self.in_point_seconds {
            return Some("source out point is not after the in point".to_string());
        }
        if self.end_ticks <= self.start_ticks {
            return Some("clip has no duration".to_string());
        }
        match self.media_path.as_deref() {
            None | Some("") => Some("no media path available".to_string()),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TrackInfo {
    pub id: TrackId,
    pub name: String,
    pub locked: bool,
    pub muted: bool,
    pub role: TrackRole,
    pub clips: Vec<ClipInfo>,
}

#[derive(Debug, Clone)]
pub struct SequenceInfo {
    pub name: String,
    pub fps_numerator: i64,
    pub fps_denominator: i64,
    /// Display offset of the sequence start timecode. It is used for timecode
    /// display only. The frame grid of the internal timeline is anchored at
    /// tick zero, so the emitted ticks stay absolute and comparable.
    pub zero_point_ticks: i64,
    pub start_ticks: i64,
    pub end_ticks: i64,
}

impl SequenceInfo {
    pub fn ticks_per_frame(&self) -> Result<i64, String> {
        if self.fps_numerator <= 0 || self.fps_denominator <= 0 {
            return Err("frame rate must be positive".to_string());
        }
        let numerator = TICKS_PER_SECOND as i128 * self.fps_denominator as i128;
        let ticks = (numerator + self.fps_numerator as i128 / 2) / self.fps_numerator as i128;
        if ticks <= 0 || ticks > i64::MAX as i128 {
            return Err("frame rate produces an invalid tick size".to_string());
        }
        Ok(ticks as i64)
    }

    pub fn frame_rate(&self) -> f64 {
        self.fps_numerator as f64 / self.fps_denominator as f64
    }

    /// Absolute frame index of a timeline tick. The zero point is a display
    /// offset and does not move the grid, so the panel adds it when it builds a
    /// timecode string.
    pub fn frame_of(&self, ticks: i64, ticks_per_frame: i64) -> i64 {
        if ticks_per_frame <= 0 {
            return 0;
        }
        divide_floor(ticks, ticks_per_frame)
    }

    /// First frame boundary at or after `ticks`, on a grid anchored at zero.
    /// Conservative for cut starts.
    pub fn snap_ceil(&self, ticks: i64, ticks_per_frame: i64) -> i64 {
        if ticks_per_frame <= 0 {
            return ticks;
        }
        let frames = divide_floor(ticks, ticks_per_frame);
        let candidate = frames.saturating_mul(ticks_per_frame);
        if candidate < ticks {
            candidate.saturating_add(ticks_per_frame)
        } else {
            candidate
        }
    }

    /// Last frame boundary at or before `ticks`, on a grid anchored at zero.
    /// Conservative for cut ends.
    pub fn snap_floor(&self, ticks: i64, ticks_per_frame: i64) -> i64 {
        if ticks_per_frame <= 0 {
            return ticks;
        }
        divide_floor(ticks, ticks_per_frame).saturating_mul(ticks_per_frame)
    }
}

/// Rounds towards the nearest integer, halves away from zero. Uses i128
/// internally so `i64::MIN` cannot overflow.
pub fn divide_round_half_away(value: i64, divisor: i64) -> i64 {
    if divisor == 0 {
        return 0;
    }
    let value = value as i128;
    let divisor = divisor as i128;
    let half = divisor / 2;
    let result = if value >= 0 {
        (value + half) / divisor
    } else {
        -((-value + half) / divisor)
    };
    clamp_to_i64(result)
}

/// Floor division that also works for negative values and cannot overflow.
pub fn divide_floor(value: i64, divisor: i64) -> i64 {
    if divisor == 0 {
        return 0;
    }
    let value = value as i128;
    let divisor = divisor as i128;
    let quotient = value / divisor;
    let result = if value % divisor != 0 && (value < 0) != (divisor < 0) {
        quotient - 1
    } else {
        quotient
    };
    clamp_to_i64(result)
}

fn clamp_to_i64(value: i128) -> i64 {
    if value > i64::MAX as i128 {
        i64::MAX
    } else if value < i64::MIN as i128 {
        i64::MIN
    } else {
        value as i64
    }
}

#[derive(Debug, Clone)]
pub struct PlanRequest {
    pub selected_sections: Vec<(i64, i64)>,
    pub analysis_source: AnalysisSource,
    pub rendered_mixdown: Option<String>,
    pub sequence: SequenceInfo,
    pub tracks: Vec<TrackInfo>,
    pub analysis_tracks: Vec<TrackId>,
    pub parameters: DetectionSettings,
    pub channel_mode: ChannelMode,
    pub mode: PlanMode,
    pub ripple_driver: RippleDriver,
    pub respect_locks: bool,
}

// ---------------------------------------------------------------------------
// Plan output
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedInterval {
    #[serde(serialize_with = "ser_i64_as_string")]
    pub start_ticks: i64,
    #[serde(serialize_with = "ser_i64_as_string")]
    pub end_ticks: i64,
    pub start_frame: i64,
    pub end_frame: i64,
    /// Removed ticks of this interval and every earlier one. The adapter moves
    /// an item that starts at or after this interval's end left by this amount.
    #[serde(serialize_with = "ser_i64_as_string")]
    pub cumulative_removed_ticks: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RazorPoint {
    #[serde(serialize_with = "ser_i64_as_string")]
    pub ticks: i64,
    pub frame: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalOp {
    pub track_kind: String,
    pub track_index: i64,
    #[serde(serialize_with = "ser_i64_as_string")]
    pub start_ticks: i64,
    #[serde(serialize_with = "ser_i64_as_string")]
    pub end_ticks: i64,
    pub ripple: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MuteOp {
    pub track_kind: String,
    pub track_index: i64,
    #[serde(serialize_with = "ser_i64_as_string")]
    pub start_ticks: i64,
    #[serde(serialize_with = "ser_i64_as_string")]
    pub end_ticks: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rejection {
    pub clip_id: String,
    pub track: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaUsage {
    pub media_path: String,
    pub clips: usize,
    pub silence_intervals: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub ticks_per_frame: i64,
    pub frame_rate: f64,
    pub intervals: Vec<PlannedInterval>,
    pub razor_points: Vec<RazorPoint>,
    pub removals: Vec<RemovalOp>,
    pub mutes: Vec<MuteOp>,
    pub rejections: Vec<Rejection>,
    pub warnings: Vec<String>,
    pub media: Vec<MediaUsage>,
    #[serde(serialize_with = "ser_i64_as_string")]
    pub removed_ticks: i64,
    #[serde(serialize_with = "ser_i64_as_string")]
    pub expected_duration_delta_ticks: i64,
}

// ---------------------------------------------------------------------------
// Building the plan
// ---------------------------------------------------------------------------

fn overlap(start_a: i64, end_a: i64, start_b: i64, end_b: i64) -> Option<(i64, i64)> {
    let start = start_a.max(start_b);
    let end = end_a.min(end_b);
    if end > start {
        Some((start, end))
    } else {
        None
    }
}

/// Shortest removal worth a jump cut: two frames and never under 100 ms.
pub fn min_cut_ticks(ticks_per_frame: i64) -> i64 {
    ticks_per_frame.saturating_mul(2).max(TICKS_PER_SECOND / 10)
}

/// Time covered by an enabled clip on a selected dialogue track, sorted and
/// merged. Rendered audio outside these ranges is not speech evidence.
pub fn dialogue_coverage(request: &PlanRequest) -> Vec<(i64, i64)> {
    let mut ranges: Vec<(i64, i64)> = request
        .tracks
        .iter()
        .filter(|track| request.analysis_tracks.contains(&track.id))
        .flat_map(|track| track.clips.iter())
        .filter(|clip| !clip.disabled)
        .map(|clip| (clip.start_ticks, clip.end_ticks))
        .collect();
    ranges.sort_unstable();
    merge_sorted(&ranges)
}

/// Intersection of two sorted lists of disjoint ranges.
pub fn intersect_sorted(first: &[(i64, i64)], second: &[(i64, i64)]) -> Vec<(i64, i64)> {
    let mut result = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < first.len() && j < second.len() {
        if let Some(range) = overlap(first[i].0, first[i].1, second[j].0, second[j].1) {
            result.push(range);
        }
        if first[i].1 < second[j].1 {
            i += 1;
        } else {
            j += 1;
        }
    }
    result
}

fn contains(outer: (i64, i64), inner_start: i64, inner_end: i64) -> bool {
    outer.0 <= inner_start && inner_end <= outer.1
}

/// Converts seconds to ticks with range checking.
pub fn seconds_to_ticks(seconds: f64) -> Result<i64, String> {
    if !seconds.is_finite() {
        return Err(format!("non finite time value {seconds}"));
    }
    let ticks = (seconds * TICKS_PER_SECOND as f64).round();
    if !(-9.2e18..9.2e18).contains(&ticks) {
        return Err(format!("time value {seconds} out of range"));
    }
    Ok(ticks as i64)
}

/// Silence intervals of one media file, in source seconds.
pub type MediaIntervals = Vec<(f64, f64)>;

/// Looks up the silence intervals of a media file. Implementations are expected
/// to cache internally.
pub type IntervalSource<'a> = &'a mut dyn FnMut(&str) -> Result<MediaIntervals, String>;

/// Builds the plan. `source_intervals` returns the silence intervals of a media
/// file in source seconds and is expected to cache internally.
pub fn build_plan(
    request: &PlanRequest,
    source_intervals: IntervalSource<'_>,
) -> Result<Plan, String> {
    let ticks_per_frame = request.sequence.ticks_per_frame()?;
    let mut plan = Plan {
        ticks_per_frame,
        frame_rate: request.sequence.frame_rate(),
        ..Plan::default()
    };

    if request.analysis_tracks.is_empty() {
        return Err("no analysis track selected".to_string());
    }
    let silent_ranges;
    let mut protected: Vec<(i64, i64)> = Vec::new();
    let mut media_usage: std::collections::BTreeMap<String, (usize, usize)> =
        std::collections::BTreeMap::new();
    if request.analysis_source == AnalysisSource::RenderedMixdown {
        let media = request
            .rendered_mixdown
            .as_deref()
            .ok_or("rendered_mixdown requires a native timeline render")?;
        let intervals = source_intervals(media)?;
        let mut ranges = Vec::with_capacity(intervals.len());
        for (start, end) in &intervals {
            if *start < 0.0 || end <= start {
                return Err("invalid rendered timeline interval".to_string());
            }
            ranges.push((seconds_to_ticks(*start)?, seconds_to_ticks(*end)?));
        }
        ranges.sort_unstable();
        // Only time covered by an enabled clip on a selected dialogue track can
        // be judged as a pause. Rendered silence elsewhere is never cut.
        silent_ranges = intersect_sorted(&merge_sorted(&ranges), &dialogue_coverage(request));
        media_usage.insert(media.to_string(), (1, intervals.len()));
    } else {
        // --- analysis phase: only the selected dialogue tracks contribute -------
        let mut track_silences: Vec<(TrackId, Vec<(i64, i64)>)> = Vec::new();
        let mut track_coverage: Vec<(TrackId, Vec<(i64, i64)>)> = Vec::new();
        // A rejected clip on a selected dialogue track means we have no evidence for
        // its time range. That range must never be cut, otherwise the remaining
        // tracks could delete audible speech we know nothing about.

        for track in &request.tracks {
            let is_analysis_track = request.analysis_tracks.contains(&track.id);
            if !is_analysis_track {
                continue;
            }
            if track.role != TrackRole::Dialogue {
                plan.warnings.push(format!(
                    "track {} is selected for analysis but its role is not dialogue, it is skipped",
                    track.id.label()
                ));
                continue;
            }
            if track.locked && request.respect_locks {
                plan.warnings.push(format!(
                    "analysis track {} is locked and is skipped",
                    track.id.label()
                ));
                continue;
            }
            if track.muted {
                plan.warnings.push(format!(
                    "analysis track {} is muted and is skipped",
                    track.id.label()
                ));
                continue;
            }
            let mut silences: Vec<(i64, i64)> = Vec::new();
            let mut coverage: Vec<(i64, i64)> = Vec::new();
            for clip in &track.clips {
                let rejection = clip
                    .unsupported_reason()
                    .or_else(|| clip.audio_state_reason(request.analysis_source));
                if let Some(reason) = rejection {
                    protected.push((clip.start_ticks, clip.end_ticks));
                    plan.rejections.push(Rejection {
                        clip_id: clip.id.clone(),
                        track: track.id.label(),
                        reason,
                    });
                    plan.warnings.push(format!(
                        "clip {} on track {} was not analysed, its range stays uncut",
                        clip.id,
                        track.id.label()
                    ));
                    continue;
                }
                if clip.disabled {
                    continue;
                }
                coverage.push((clip.start_ticks, clip.end_ticks));
                let media_path = clip.media_path.clone().unwrap_or_default();
                let intervals = source_intervals(&media_path)?;
                let usage = media_usage
                    .entry(media_path)
                    .or_insert((0, intervals.len()));
                usage.0 += 1;

                let in_ticks = seconds_to_ticks(clip.in_point_seconds)?;
                for (start_seconds, end_seconds) in intervals {
                    let source_start = seconds_to_ticks(start_seconds)?;
                    let source_end = seconds_to_ticks(end_seconds)?;
                    let start = clip
                        .start_ticks
                        .saturating_add(source_start.saturating_sub(in_ticks));
                    let end = clip
                        .start_ticks
                        .saturating_add(source_end.saturating_sub(in_ticks));
                    if let Some((start, end)) =
                        overlap(start, end, clip.start_ticks, clip.end_ticks)
                    {
                        silences.push((start, end));
                    }
                }
            }
            silences.sort_unstable();
            coverage.sort_unstable();
            track_silences.push((track.id, merge_sorted(&silences)));
            track_coverage.push((track.id, merge_sorted(&coverage)));
        }

        if track_silences.is_empty() {
            plan.warnings
                .push("no usable analysis track found, nothing to cut".to_string());
            return Ok(plan);
        }

        // --- intersection over all audible analysis tracks ----------------------
        let mut boundaries: BTreeSet<i64> = BTreeSet::new();
        for (_, intervals) in track_coverage.iter().chain(track_silences.iter()) {
            for (start, end) in intervals {
                boundaries.insert(*start);
                boundaries.insert(*end);
            }
        }
        let points: Vec<i64> = boundaries.into_iter().collect();
        let mut gathered_ranges: Vec<(i64, i64)> = Vec::new();
        for window in points.windows(2) {
            let (start, end) = (window[0], window[1]);
            if end <= start {
                continue;
            }
            let mut audible_tracks = 0usize;
            let mut all_silent = true;
            for (index, (_id, coverage)) in track_coverage.iter().enumerate() {
                let covered = coverage.iter().any(|range| contains(*range, start, end));
                if !covered {
                    continue;
                }
                audible_tracks += 1;
                let silent = track_silences[index]
                    .1
                    .iter()
                    .any(|range| contains(*range, start, end));
                if !silent {
                    all_silent = false;
                    break;
                }
            }
            if audible_tracks > 0 && all_silent {
                gathered_ranges.push((start, end));
            }
        }
        silent_ranges = merge_sorted(&gathered_ranges);
    }

    // --- clip to the selected range and snap conservatively -----------------
    let mut snapped: Vec<(i64, i64)> = Vec::new();
    for (start, end) in silent_ranges {
        for &(section_start, section_end) in &request.selected_sections {
            let Some((start, end)) = overlap(start, end, section_start, section_end) else {
                continue;
            };
            let start = request.sequence.snap_ceil(start, ticks_per_frame);
            let end = request.sequence.snap_floor(end, ticks_per_frame);
            if end - start >= ticks_per_frame {
                snapped.push((start, end));
            }
        }
    }
    let snapped = merge_sorted(&snapped);
    // A removal shorter than this is a visible jump without a real gain.
    let min_cut = min_cut_ticks(ticks_per_frame);
    let snapped: Vec<(i64, i64)> = snapped
        .into_iter()
        .filter(|(start, end)| end - start >= min_cut)
        .collect();
    // Partition at existing clip boundaries. Every removal then has one exact
    // middle segment per affected track, even on an already edited timeline.
    let snapped = if request.analysis_source == AnalysisSource::RenderedMixdown {
        let mut pieces = Vec::new();
        for (start, end) in snapped {
            let mut boundaries = BTreeSet::from([start, end]);
            for track in &request.tracks {
                for clip in &track.clips {
                    for boundary in [clip.start_ticks, clip.end_ticks] {
                        if start < boundary && boundary < end {
                            if boundary % ticks_per_frame != 0 {
                                return Err(
                                    "clip boundary is not on the video frame grid".to_string()
                                );
                            }
                            boundaries.insert(boundary);
                        }
                    }
                }
            }
            let points: Vec<_> = boundaries.into_iter().collect();
            pieces.extend(points.windows(2).map(|pair| (pair[0], pair[1])));
        }
        pieces
    } else {
        snapped
    };

    // Drop every candidate that touches a range we could not analyse.
    let protected = merge_sorted(&protected);
    let snapped: Vec<(i64, i64)> = snapped
        .into_iter()
        .filter(|(start, end)| {
            let blocked = protected.iter().any(|range| overlap(*start, *end, range.0, range.1).is_some());
            if blocked {
                plan.warnings.push(format!(
                    "range at frame {} to {} overlaps a clip that could not be analysed and was skipped",
                    request.sequence.frame_of(*start, ticks_per_frame),
                    request.sequence.frame_of(*end, ticks_per_frame)
                ));
            }
            !blocked
        })
        .collect();

    // --- validation of every clip that would be touched or shifted ----------
    let mut accepted: Vec<(i64, i64)> = Vec::new();
    for (start, end) in snapped {
        match validate_range(request, start, end) {
            Ok(()) => accepted.push((start, end)),
            Err(reason) => plan.warnings.push(format!(
                "range at frame {} to {} was skipped: {}",
                request.sequence.frame_of(start, ticks_per_frame),
                request.sequence.frame_of(end, ticks_per_frame),
                reason
            )),
        }
    }

    for (start, end) in &accepted {
        plan.removed_ticks = plan.removed_ticks.saturating_add(end - start);
        plan.intervals.push(PlannedInterval {
            start_ticks: *start,
            end_ticks: *end,
            start_frame: request.sequence.frame_of(*start, ticks_per_frame),
            end_frame: request.sequence.frame_of(*end, ticks_per_frame),
            cumulative_removed_ticks: plan.removed_ticks,
        });
    }

    // --- operations ---------------------------------------------------------
    if matches!(
        request.mode,
        PlanMode::DeleteRipple | PlanMode::DeleteLift | PlanMode::Mute
    ) {
        for interval in &plan.intervals {
            let affected: Vec<&TrackInfo> = request
                .tracks
                .iter()
                .filter(|track| !(track.locked && request.respect_locks))
                .filter(|track| {
                    track.clips.iter().any(|clip| {
                        overlap(
                            clip.start_ticks,
                            clip.end_ticks,
                            interval.start_ticks,
                            interval.end_ticks,
                        )
                        .is_some()
                    })
                })
                .collect();

            if request.mode == PlanMode::Mute {
                for track in affected
                    .iter()
                    .filter(|track| track.id.kind == TrackKind::Audio)
                {
                    plan.mutes.push(MuteOp {
                        track_kind: track.id.kind.as_str().to_string(),
                        track_index: track.id.index,
                        start_ticks: interval.start_ticks,
                        end_ticks: interval.end_ticks,
                    });
                }
                continue;
            }

            let ripple_enabled = request.mode == PlanMode::DeleteRipple;
            let driver: Option<TrackId> = if ripple_enabled {
                affected
                    .iter()
                    .find(|track| track.id.kind == request.ripple_driver.preferred_kind())
                    .or_else(|| affected.first())
                    .map(|track| track.id)
            } else {
                None
            };

            if ripple_enabled && driver.is_none() {
                plan.warnings.push(format!(
                    "no writable track covers frame {} to {}, range skipped",
                    interval.start_frame, interval.end_frame
                ));
                plan.removed_ticks -= interval.end_ticks - interval.start_ticks;
                continue;
            }

            for track in affected {
                plan.removals.push(RemovalOp {
                    track_kind: track.id.kind.as_str().to_string(),
                    track_index: track.id.index,
                    start_ticks: interval.start_ticks,
                    end_ticks: interval.end_ticks,
                    ripple: Some(track.id) == driver,
                });
            }
        }
    }

    let mut razor_ticks: Vec<i64> = Vec::new();
    for interval in &plan.intervals {
        razor_ticks.push(interval.start_ticks);
        razor_ticks.push(interval.end_ticks);
    }
    razor_ticks.sort_unstable();
    razor_ticks.dedup();
    plan.razor_points = razor_ticks
        .into_iter()
        .map(|ticks| RazorPoint {
            ticks,
            frame: request.sequence.frame_of(ticks, ticks_per_frame),
        })
        .collect();

    plan.expected_duration_delta_ticks = if request.mode == PlanMode::DeleteRipple {
        -plan.removed_ticks
    } else {
        0
    };

    plan.media = media_usage
        .into_iter()
        .map(|(media_path, (clips, silence_intervals))| MediaUsage {
            media_path,
            clips,
            silence_intervals,
        })
        .collect();

    Ok(plan)
}

/// Every clip the operation could touch must be in a supported state, and a
/// ripple must not have to move content on a track we are not allowed to write.
fn validate_range(request: &PlanRequest, start: i64, end: i64) -> Result<(), String> {
    let ripple = request.mode == PlanMode::DeleteRipple;
    if !request.tracks.iter().any(|track| {
        !track.locked
            && track
                .clips
                .iter()
                .any(|clip| contains((clip.start_ticks, clip.end_ticks), start, end))
    }) {
        return Err("no writable clip covers the range".to_string());
    }
    if ripple {
        for track in &request.tracks {
            if !(track.locked && request.respect_locks) {
                continue;
            }
            let blocked = track.clips.iter().any(|clip| clip.end_ticks > start);
            if blocked {
                return Err(format!(
                    "locked track {} contains material that a ripple would have to move",
                    track.id.label()
                ));
            }
        }
    }
    for track in &request.tracks {
        if track.locked && request.respect_locks {
            continue;
        }
        for clip in &track.clips {
            let overlaps = overlap(clip.start_ticks, clip.end_ticks, start, end).is_some();
            // A ripple delete also moves every later clip on every writable track.
            let shifted = ripple && clip.end_ticks > start;
            if !overlaps && !shifted {
                continue;
            }
            let timing_reason = if request.analysis_source == AnalysisSource::RenderedMixdown {
                // Native rendering and native razor preserve source timing.
                // Source offset arithmetic is never used for this path.
                clip.transition_in
                    .timing_reason("incoming transition")
                    .or_else(|| clip.transition_out.timing_reason("outgoing transition"))
            } else {
                clip.unsupported_reason()
            };
            if let Some(reason) = timing_reason {
                return Err(format!(
                    "clip {} on track {} has an unsupported state ({reason})",
                    clip.id,
                    track.id.label()
                ));
            }
            if let Some(reason) = clip.audio_state_reason(request.analysis_source) {
                return Err(format!(
                    "clip {} on track {} has an unreadable audible state ({reason})",
                    clip.id,
                    track.id.label()
                ));
            }
        }
    }
    for id in &request.analysis_tracks {
        let found = request.tracks.iter().any(|track| track.id == *id);
        if !found {
            return Err(format!(
                "analysis track {} is not part of the snapshot",
                id.label()
            ));
        }
    }
    Ok(())
}

fn merge_sorted(intervals: &[(i64, i64)]) -> Vec<(i64, i64)> {
    let mut merged: Vec<(i64, i64)> = Vec::with_capacity(intervals.len());
    for (start, end) in intervals.iter().copied() {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

// ---------------------------------------------------------------------------
// Snapshot conversion
// ---------------------------------------------------------------------------

impl PlanRequest {
    pub fn from_json(input: &str) -> Result<Self, String> {
        let snapshot: SnapshotJson =
            serde_json::from_str(input).map_err(|error| format!("invalid snapshot: {error}"))?;
        let analysis_source = AnalysisSource::parse(&snapshot.analysis_source)?;
        if snapshot.sequence.fps_numerator <= 0 || snapshot.sequence.fps_denominator <= 0 {
            return Err("frame rate must be positive".to_string());
        }
        let out_of_range = |value: i64| !(-MAX_TICKS..=MAX_TICKS).contains(&value);
        if out_of_range(snapshot.sequence.zero_point_ticks)
            || out_of_range(snapshot.sequence.start_ticks)
            || out_of_range(snapshot.sequence.end_ticks)
        {
            return Err("sequence tick values are out of range".to_string());
        }

        let mut tracks = Vec::with_capacity(snapshot.tracks.len());
        for track in snapshot.tracks {
            let kind = TrackKind::parse(&track.kind)?;
            let role = TrackRole::parse(&track.role)?;
            let mut clips = Vec::with_capacity(track.clips.len());
            for clip in track.clips {
                let clip_id = clip.id.clone();
                if !(-MAX_TICKS..=MAX_TICKS).contains(&clip.start_ticks)
                    || !(-MAX_TICKS..=MAX_TICKS).contains(&clip.end_ticks)
                {
                    return Err(format!("clip {clip_id} has tick values out of range"));
                }
                let media_path = match &clip.media_path {
                    serde_json::Value::Null => None,
                    serde_json::Value::String(text) => Some(text.clone()),
                    other => {
                        return Err(format!(
                            "clip {} mediaPath must be a string or null, got {other}",
                            clip.id
                        ))
                    }
                };
                let linked = SafetyFlag::parse(&clip.linked, "linked")?;
                if analysis_source == AnalysisSource::RawSources && linked == SafetyFlag::Unknown {
                    return Err("raw_sources requires a readable linked flag".to_string());
                }
                clips.push(ClipInfo {
                    id: clip.id,
                    start_ticks: clip.start_ticks,
                    end_ticks: clip.end_ticks,
                    in_point_seconds: clip.in_point_seconds,
                    out_point_seconds: clip.out_point_seconds,
                    speed: clip.speed,
                    reversed: SafetyFlag::parse(&clip.reversed, "reversed")?,
                    time_remap: SafetyFlag::parse(&clip.time_remap, "timeRemap")?,
                    nested: SafetyFlag::parse(&clip.nested, "nested")?,
                    transition_in: SafetyFlag::parse(&clip.transition_in, "transitionIn")?,
                    transition_out: SafetyFlag::parse(&clip.transition_out, "transitionOut")?,
                    media_path,
                    disabled: clip.disabled,
                    linked,
                    gain_db: match &clip.gain_db {
                        serde_json::Value::Null => None,
                        serde_json::Value::Number(number) => number.as_f64(),
                        other => {
                            return Err(format!(
                                "clip {clip_id} gainDb must be a number or null, got {other}"
                            ))
                        }
                    },
                    audio_effects: SafetyFlag::parse(&clip.audio_effects, "audioEffects")?,
                    channel_mapping_changed: SafetyFlag::parse(
                        &clip.channel_mapping_changed,
                        "channelMappingChanged",
                    )?,
                });
            }
            tracks.push(TrackInfo {
                id: TrackId {
                    kind,
                    index: track.index,
                },
                name: track.name,
                locked: track.locked,
                muted: track.muted,
                role,
                clips,
            });
        }

        let mut analysis_tracks = Vec::with_capacity(snapshot.analysis_tracks.len());
        for reference in snapshot.analysis_tracks {
            let id = TrackId {
                kind: TrackKind::parse(&reference.kind)?,
                index: reference.index,
            };
            if !tracks.iter().any(|track| track.id == id) {
                return Err(format!(
                    "analysis track {} is not part of the snapshot",
                    id.label()
                ));
            }
            analysis_tracks.push(id);
        }
        if analysis_tracks.is_empty() {
            return Err("no analysis track selected".to_string());
        }

        let rendered_mixdown = match (analysis_source, snapshot.rendered_mixdown) {
            (AnalysisSource::RenderedMixdown, Some(render)) => {
                if render.media_path.trim().is_empty() {
                    return Err("native render mediaPath is empty".to_string());
                }
                let declared: Result<Vec<_>, String> = render
                    .analysis_tracks
                    .iter()
                    .map(|track| {
                        Ok(TrackId {
                            kind: TrackKind::parse(&track.kind)?,
                            index: track.index,
                        })
                    })
                    .collect();
                if declared? != analysis_tracks {
                    return Err(
                        "native render analysisTracks differ from the selected tracks".to_string(),
                    );
                }
                for id in &analysis_tracks {
                    let track = tracks
                        .iter()
                        .find(|track| track.id == *id)
                        .ok_or("native render analysis track is missing")?;
                    if id.kind != TrackKind::Audio
                        || track.muted
                        || track.locked
                        || track.role != TrackRole::Dialogue
                    {
                        return Err(
                            "native render requires audible unlocked dialogue tracks".to_string()
                        );
                    }
                }
                Some(render.media_path)
            }
            (AnalysisSource::RenderedMixdown, None) => {
                return Err("rendered_mixdown requires a native timeline render".to_string())
            }
            (AnalysisSource::RawSources, Some(_)) => {
                return Err("raw_sources cannot carry a rendered mixdown".to_string())
            }
            (AnalysisSource::RawSources, None) => None,
        };

        let sections = match snapshot.selected_sections {
            Some(sections) => {
                if sections.is_empty() || sections.len() > 100_000 {
                    return Err("selectedSections must contain 1..100000 ranges".to_string());
                }
                let mut ranges = Vec::with_capacity(sections.len());
                for section in sections {
                    if section.start_ticks < snapshot.sequence.start_ticks
                        || section.end_ticks > snapshot.sequence.end_ticks
                        || section.start_ticks >= section.end_ticks
                    {
                        return Err("selected section is empty or outside the timeline".to_string());
                    }
                    ranges.push((section.start_ticks, section.end_ticks));
                }
                merge_sorted(&ranges)
            }
            None => vec![(snapshot.sequence.start_ticks, snapshot.sequence.end_ticks)],
        };

        Ok(PlanRequest {
            selected_sections: sections,
            analysis_source,
            rendered_mixdown,
            sequence: SequenceInfo {
                name: snapshot.sequence.name,
                fps_numerator: snapshot.sequence.fps_numerator,
                fps_denominator: snapshot.sequence.fps_denominator,
                zero_point_ticks: snapshot.sequence.zero_point_ticks,
                start_ticks: snapshot.sequence.start_ticks,
                end_ticks: snapshot.sequence.end_ticks,
            },
            tracks,
            analysis_tracks,
            parameters: DetectionSettings {
                threshold_db: snapshot.parameters.threshold_db,
                min_pause: snapshot.parameters.min_pause,
                min_speech: snapshot.parameters.min_speech,
                lead_in: snapshot.parameters.lead_in,
                tail: snapshot.parameters.tail,
            },
            channel_mode: ChannelMode::parse(&snapshot.channel_mode)?,
            mode: PlanMode::parse(&snapshot.mode)?,
            ripple_driver: RippleDriver::parse(&snapshot.ripple_driver)?,
            respect_locks: snapshot.respect_locks,
        })
    }
}

impl Plan {
    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|error| format!("cannot serialise plan: {error}"))
    }
}
