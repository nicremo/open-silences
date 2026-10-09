//! Regression tests for the cut planner.
//!
//! Every test maps to a concrete safety requirement: track identity, dialogue
//! intersection, unsupported clip states, mandatory snapshot fields,
//! conservative frame snapping and the sequence zero point.

use std::collections::HashMap;

use serde_json::json;
use silences_engine::planner::{
    build_plan, dialogue_coverage, min_cut_ticks, PlanMode, PlanRequest, RippleDriver,
    TICKS_PER_SECOND,
};

/// One snapshot mutation case: a label and a function that edits the fixture.
type MutationCase = (&'static str, Box<dyn Fn(&mut serde_json::Value)>);

const FRAME_25: i64 = TICKS_PER_SECOND / 25; // 10160640000 ticks == 40 ms
const SECOND: i64 = TICKS_PER_SECOND;

fn ticks(seconds: f64) -> i64 {
    (seconds * TICKS_PER_SECOND as f64).round() as i64
}

struct Fixture {
    snapshot: serde_json::Value,
    sources: HashMap<String, Vec<(f64, f64)>>,
}

impl Fixture {
    fn new() -> Self {
        Self {
            snapshot: json!({
                "analysisSource": "raw_sources",
                "sequence": {
                    "name": "test",
                    "fpsNumerator": 25,
                    "fpsDenominator": 1,
                    "zeroPointTicks": "0",
                    "startTicks": "0",
                    "endTicks": ticks(10.0).to_string(),
                },
                "tracks": [],
                "analysisTracks": [],
                "parameters": {
                    "thresholdDb": -35.0,
                    "minPause": 0.3,
                    "minSpeech": 0.2,
                    "leadIn": 0.0,
                    "tail": 0.0,
                },
                "channelMode": "loudest",
                "mode": "delete",
                "rippleDriver": "video_first",
                "respectLocks": true,
            }),
            sources: HashMap::new(),
        }
    }

    fn sequence(mut self, zero_point: i64, start: i64, end: i64) -> Self {
        self.snapshot["sequence"]["zeroPointTicks"] = json!(zero_point.to_string());
        self.snapshot["sequence"]["startTicks"] = json!(start.to_string());
        self.snapshot["sequence"]["endTicks"] = json!(end.to_string());
        self
    }

    fn mode(mut self, mode: &str) -> Self {
        self.snapshot["mode"] = json!(mode);
        self
    }

    fn driver(mut self, driver: &str) -> Self {
        self.snapshot["rippleDriver"] = json!(driver);
        self
    }

    fn analysis(mut self, tracks: &[(&str, i64)]) -> Self {
        self.snapshot["analysisTracks"] = json!(tracks
            .iter()
            .map(|(kind, index)| json!({ "kind": kind, "index": index }))
            .collect::<Vec<_>>());
        self
    }

    fn track(
        mut self,
        kind: &str,
        index: i64,
        role: &str,
        locked: bool,
        muted: bool,
        clips: Vec<serde_json::Value>,
    ) -> Self {
        self.snapshot["tracks"].as_array_mut().unwrap().push(json!({
            "kind": kind,
            "index": index,
            "name": format!("{kind}{index}"),
            "locked": locked,
            "muted": muted,
            "role": role,
            "clips": clips,
        }));
        self
    }

    fn source(mut self, media: &str, intervals: Vec<(f64, f64)>) -> Self {
        self.sources.insert(media.to_string(), intervals);
        self
    }

    fn build(&self) -> Result<silences_engine::planner::Plan, String> {
        let request = PlanRequest::from_json(&self.snapshot.to_string())?;
        let mut sources = self.sources.clone();
        let mut lookup = |media: &str| -> Result<Vec<(f64, f64)>, String> {
            Ok(sources.remove(media).unwrap_or_default())
        };
        build_plan(&request, &mut lookup)
    }
}

fn clip(id: &str, start: f64, end: f64, media: &str) -> serde_json::Value {
    clip_with(id, start, end, media, |_value| {})
}

fn clip_with(
    id: &str,
    start: f64,
    end: f64,
    media: &str,
    modify: impl FnOnce(&mut serde_json::Value),
) -> serde_json::Value {
    let mut value = json!({
        "id": id,
        "startTicks": ticks(start).to_string(),
        "endTicks": ticks(end).to_string(),
        "inPointSeconds": 0.0,
        "outPointSeconds": end - start,
        "speed": 1.0,
        "reversed": false,
        "timeRemap": false,
        "nested": false,
        "transitionIn": false,
        "transitionOut": false,
        "mediaPath": media,
        "disabled": false,
        "linked": true,
        "gainDb": 0.0,
        "audioEffects": false,
        "channelMappingChanged": false,
    });
    modify(&mut value);
    value
}

/// P1: video track 0 and audio track 0 share index 0 but are different tracks.
#[test]
fn ripple_driver_distinguishes_video_zero_from_audio_zero() {
    let plan = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "video",
            0,
            "other",
            false,
            false,
            vec![clip("v", 0.0, 10.0, "cam.mov")],
        )
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 10.0, "mic.wav")],
        )
        .source("mic.wav", vec![(2.0, 3.0)])
        .build()
        .unwrap();

    assert_eq!(plan.intervals.len(), 1);
    assert_eq!(plan.removals.len(), 2, "both tracks must be handled");
    let rippling: Vec<(String, i64)> = plan
        .removals
        .iter()
        .filter(|operation| operation.ripple)
        .map(|operation| (operation.track_kind.clone(), operation.track_index))
        .collect();
    assert_eq!(
        rippling,
        vec![("video".to_string(), 0)],
        "video 0 must ripple once"
    );
    let lifting: Vec<(String, i64)> = plan
        .removals
        .iter()
        .filter(|operation| !operation.ripple)
        .map(|operation| (operation.track_kind.clone(), operation.track_index))
        .collect();
    assert_eq!(lifting, vec![("audio".to_string(), 0)]);

    let audio_first = Fixture::new()
        .analysis(&[("audio", 0)])
        .driver("audio_first")
        .track(
            "video",
            0,
            "other",
            false,
            false,
            vec![clip("v", 0.0, 10.0, "cam.mov")],
        )
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 10.0, "mic.wav")],
        )
        .source("mic.wav", vec![(2.0, 3.0)])
        .build()
        .unwrap();
    let rippling: Vec<(String, i64)> = audio_first
        .removals
        .iter()
        .filter(|operation| operation.ripple)
        .map(|operation| (operation.track_kind.clone(), operation.track_index))
        .collect();
    assert_eq!(rippling, vec![("audio".to_string(), 0)]);

    // Exactly one ripple per time range, never two.
    assert_eq!(
        audio_first
            .removals
            .iter()
            .filter(|operation| operation.ripple)
            .count(),
        1
    );
}

/// P1: silence is the intersection over the audible dialogue tracks.
#[test]
fn speech_on_a_second_microphone_prevents_the_cut() {
    let plan = Fixture::new()
        .analysis(&[("audio", 1), ("audio", 2)])
        .track(
            "audio",
            1,
            "dialogue",
            false,
            false,
            vec![clip("a1", 0.0, 10.0, "mic1.wav")],
        )
        .track(
            "audio",
            2,
            "dialogue",
            false,
            false,
            vec![clip("a2", 0.0, 10.0, "mic2.wav")],
        )
        .source("mic1.wav", vec![(2.0, 3.0)])
        .source("mic2.wav", vec![])
        .build()
        .unwrap();
    assert!(
        plan.intervals.is_empty(),
        "speech on mic2 must prevent cutting: {:?}",
        plan.intervals
    );

    let plan = Fixture::new()
        .analysis(&[("audio", 1), ("audio", 2)])
        .track(
            "audio",
            1,
            "dialogue",
            false,
            false,
            vec![clip("a1", 0.0, 10.0, "mic1.wav")],
        )
        .track(
            "audio",
            2,
            "dialogue",
            false,
            false,
            vec![clip("a2", 0.0, 10.0, "mic2.wav")],
        )
        .source("mic1.wav", vec![(2.0, 3.0), (5.0, 6.0)])
        .source("mic2.wav", vec![(2.5, 4.0), (5.0, 6.0)])
        .build()
        .unwrap();
    let intervals: Vec<(f64, f64)> = plan
        .intervals
        .iter()
        .map(|interval| {
            (
                interval.start_ticks as f64 / SECOND as f64,
                interval.end_ticks as f64 / SECOND as f64,
            )
        })
        .collect();
    // 2.5 s is not on the 25 fps grid, so the start snaps to the next frame.
    assert_eq!(intervals, vec![(2.52, 3.0), (5.0, 6.0)]);
}

/// P1: a music track must never drive the dialogue analysis.
#[test]
fn music_track_is_not_used_for_the_analysis() {
    let plan = Fixture::new()
        .analysis(&[("audio", 0), ("audio", 1)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a0", 0.0, 10.0, "mic.wav")],
        )
        .track(
            "audio",
            1,
            "music",
            false,
            false,
            vec![clip("a1", 0.0, 10.0, "music.wav")],
        )
        .source("mic.wav", vec![(2.0, 3.0)])
        .source("music.wav", vec![(0.0, 10.0)])
        .build()
        .unwrap();
    assert_eq!(plan.intervals.len(), 1);
    assert!(
        plan.warnings
            .iter()
            .any(|warning| warning.contains("not dialogue")),
        "the music track must be reported: {:?}",
        plan.warnings
    );
    let starts: Vec<i64> = plan
        .intervals
        .iter()
        .map(|interval| interval.start_ticks)
        .collect();
    assert_eq!(starts, vec![ticks(2.0)]);
}

/// P1: a ripple also moves every later clip, so an unknown state there blocks the range.
#[test]
fn unsupported_clip_blocks_a_ripple_range() {
    let locked_range = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 10.0, "mic.wav")],
        )
        .track(
            "video",
            0,
            "other",
            false,
            false,
            vec![
                clip("v", 0.0, 10.0, "cam.mov"),
                clip_with("nested", 6.0, 7.0, "cam.mov", |value| {
                    value["nested"] = json!(true)
                }),
            ],
        )
        .source("mic.wav", vec![(4.0, 5.0)])
        .build()
        .unwrap();
    assert!(
        locked_range.intervals.is_empty(),
        "a nested clip after the cut blocks the ripple"
    );
    assert!(locked_range
        .warnings
        .iter()
        .any(|warning| warning.contains("nested sequence is not supported")));

    // Without ripple nothing later is moved, so the same range is allowed.
    let lift = Fixture::new()
        .mode("delete_lift")
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 10.0, "mic.wav")],
        )
        .track(
            "video",
            0,
            "other",
            false,
            false,
            vec![
                clip("v", 0.0, 10.0, "cam.mov"),
                clip_with("nested", 6.0, 7.0, "cam.mov", |value| {
                    value["nested"] = json!(true)
                }),
            ],
        )
        .source("mic.wav", vec![(4.0, 5.0)])
        .build()
        .unwrap();
    assert_eq!(lift.intervals.len(), 1, "a lift does not shift later clips");
}

#[test]
fn clip_in_the_range_with_speed_is_rejected() {
    let plan = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip_with("fast", 0.0, 10.0, "mic.wav", |value| {
                value["speed"] = json!(1.5)
            })],
        )
        .source("mic.wav", vec![(2.0, 3.0)])
        .build()
        .unwrap();
    assert!(plan.intervals.is_empty());
    assert!(plan
        .rejections
        .iter()
        .any(|rejection| rejection.reason.contains("speed 1.5")));
}

/// P2: the snapshot protocol is complete. A missing safety flag is an error.
#[test]
fn missing_safety_fields_are_errors() {
    let cases: Vec<MutationCase> = vec![
        (
            "speed",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0]["clips"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("speed");
            }),
        ),
        (
            "reversed",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0]["clips"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("reversed");
            }),
        ),
        (
            "timeRemap",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0]["clips"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("timeRemap");
            }),
        ),
        (
            "nested",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0]["clips"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("nested");
            }),
        ),
        (
            "transitionIn",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0]["clips"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("transitionIn");
            }),
        ),
        (
            "transitionOut",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0]["clips"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("transitionOut");
            }),
        ),
        (
            "mediaPath",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0]["clips"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("mediaPath");
            }),
        ),
        (
            "disabled",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0]["clips"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("disabled");
            }),
        ),
        (
            "locked",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0].as_object_mut().unwrap().remove("locked");
            }),
        ),
        (
            "muted",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0].as_object_mut().unwrap().remove("muted");
            }),
        ),
        (
            "role",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0].as_object_mut().unwrap().remove("role");
            }),
        ),
        (
            "gainDb",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0]["clips"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("gainDb");
            }),
        ),
        (
            "audioEffects",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0]["clips"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("audioEffects");
            }),
        ),
        (
            "channelMappingChanged",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0]["clips"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("channelMappingChanged");
            }),
        ),
        (
            "analysisSource",
            Box::new(|value: &mut serde_json::Value| {
                value.as_object_mut().unwrap().remove("analysisSource");
            }),
        ),
    ];

    for (field, mutate) in cases {
        let fixture = Fixture::new()
            .analysis(&[("audio", 0)])
            .track(
                "audio",
                0,
                "dialogue",
                false,
                false,
                vec![clip("a", 0.0, 10.0, "mic.wav")],
            )
            .source("mic.wav", vec![(2.0, 3.0)]);
        let mut snapshot = fixture.snapshot.clone();
        mutate(&mut snapshot);
        let error = PlanRequest::from_json(&snapshot.to_string()).unwrap_err();
        assert!(
            error.contains(field),
            "missing {field} must be reported, got: {error}"
        );
    }
}

#[test]
fn unknown_fields_and_types_are_errors() {
    let fixture = Fixture::new().analysis(&[("audio", 0)]).track(
        "audio",
        0,
        "dialogue",
        false,
        false,
        vec![clip("a", 0.0, 10.0, "mic.wav")],
    );
    let mut snapshot = fixture.snapshot.clone();
    snapshot["tracks"][0]["clips"][0]["speedUnknown"] = json!(1.0);
    let error = PlanRequest::from_json(&snapshot.to_string()).unwrap_err();
    assert!(
        error.contains("speedUnknown"),
        "unknown field must be rejected: {error}"
    );

    let mut snapshot = fixture.snapshot.clone();
    snapshot["tracks"][0]["locked"] = json!("yes");
    assert!(PlanRequest::from_json(&snapshot.to_string()).is_err());
}

#[test]
fn absent_analysis_track_selection_is_an_error() {
    let fixture = Fixture::new().track(
        "audio",
        0,
        "dialogue",
        false,
        false,
        vec![clip("a", 0.0, 10.0, "mic.wav")],
    );
    let error = PlanRequest::from_json(&fixture.snapshot.to_string()).unwrap_err();
    assert!(error.contains("no analysis track"), "{error}");

    let mut snapshot = fixture.snapshot.clone();
    snapshot["analysisTracks"] = json!([{ "kind": "audio", "index": 9 }]);
    let error = PlanRequest::from_json(&snapshot.to_string()).unwrap_err();
    assert!(error.contains("A9"), "{error}");
}

/// P1: snapping must shrink the cut, never extend it into speech.
#[test]
fn snapping_is_conservative_inside_the_silence() {
    let start = 2.03;
    let end = 2.99;
    let plan = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 10.0, "mic.wav")],
        )
        .source("mic.wav", vec![(start, end)])
        .build()
        .unwrap();
    assert_eq!(plan.intervals.len(), 1);
    let interval = &plan.intervals[0];
    assert!(
        interval.start_ticks >= ticks(start),
        "cut starts before the silence"
    );
    assert!(
        interval.end_ticks <= ticks(end),
        "cut ends after the silence"
    );
    assert_eq!(interval.start_ticks, 51 * FRAME_25);
    assert_eq!(interval.end_ticks, 74 * FRAME_25);
    assert_eq!(interval.start_frame, 51);
    assert_eq!(interval.end_frame, 74);
}

/// P1: the zero point is a display offset only. The internal frame grid stays
/// anchored at tick zero, so the emitted ticks remain absolute and comparable.
#[test]
fn zero_point_is_display_only() {
    // Deliberately not frame aligned: a display offset must not move the grid.
    let zero_point = 3600 * SECOND + 5_000_000;
    let plan = Fixture::new()
        .sequence(zero_point, zero_point, zero_point + 10 * SECOND)
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip_with("a", 0.0, 10.0, "mic.wav", |value| {
                value["startTicks"] = json!(zero_point.to_string());
                value["endTicks"] = json!((zero_point + 10 * SECOND).to_string());
            })],
        )
        .source("mic.wav", vec![(2.0, 3.0)])
        .build()
        .unwrap();
    assert_eq!(plan.intervals.len(), 1);
    let interval = &plan.intervals[0];
    // Absolute timeline coordinates, on the grid anchored at zero.
    assert_eq!(
        interval.start_ticks % FRAME_25,
        0,
        "grid must be anchored at zero"
    );
    assert_eq!(interval.end_ticks % FRAME_25, 0);
    assert!(
        interval.start_ticks >= zero_point + ticks(2.0),
        "cut must not start early"
    );
    assert!(
        interval.end_ticks <= zero_point + ticks(3.0),
        "cut must not end late"
    );
    assert_eq!(
        interval.start_frame,
        interval.start_ticks / FRAME_25,
        "absolute frame index"
    );
    // The display timecode the panel builds subtracts the zero point: because
    // the chosen zero point is deliberately 5 ms off the grid, the cut lands one
    // frame later than exactly 2 s and the relative position is 50 or 51 frames.
    let relative_frames = (interval.start_ticks - zero_point) as f64 / FRAME_25 as f64;
    assert!(
        (50.0..=51.0).contains(&relative_frames),
        "unexpected relative frame position {relative_frames}"
    );
}

/// P1: a ripple must not silently desynchronise tracks it may not write to.
#[test]
fn locked_content_blocks_a_ripple_range() {
    let plan = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "video",
            0,
            "other",
            true,
            false,
            vec![clip("v", 0.0, 10.0, "cam.mov")],
        )
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 10.0, "mic.wav")],
        )
        .source("mic.wav", vec![(2.0, 3.0)])
        .build()
        .unwrap();
    assert!(
        plan.intervals.is_empty(),
        "a locked track with later material must block the ripple"
    );
    assert!(
        plan.warnings
            .iter()
            .any(|warning| warning.contains("locked track V0")),
        "the reason must be reported: {:?}",
        plan.warnings
    );

    // A locked track that ends before the cut does not have to move.
    let plan = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "video",
            0,
            "other",
            true,
            false,
            vec![clip_with("v", 0.0, 1.0, "cam.mov", |value| {
                value["endTicks"] = json!(ticks(1.0).to_string());
            })],
        )
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 10.0, "mic.wav")],
        )
        .source("mic.wav", vec![(4.0, 5.0)])
        .build()
        .unwrap();
    assert_eq!(
        plan.intervals.len(),
        1,
        "locked material before the cut is fine"
    );
    assert!(plan
        .removals
        .iter()
        .all(|operation| operation.track_kind == "audio"));
}

#[test]
fn locked_tracks_and_disabled_clips_are_left_alone() {
    // A locked track whose material ends before the cut does not have to move,
    // so the ripple is allowed and only the writable track is touched.
    let plan = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "video",
            0,
            "other",
            true,
            false,
            vec![clip_with("v", 0.0, 1.0, "cam.mov", |value| {
                value["endTicks"] = json!(ticks(1.0).to_string());
            })],
        )
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 10.0, "mic.wav")],
        )
        .source("mic.wav", vec![(2.0, 3.0)])
        .build()
        .unwrap();
    assert_eq!(plan.intervals.len(), 1);
    assert!(
        plan.removals
            .iter()
            .all(|operation| operation.track_kind == "audio"),
        "a locked track must never be touched"
    );
    assert_eq!(
        plan.removals
            .iter()
            .filter(|operation| operation.ripple)
            .count(),
        1
    );

    // A disabled clip is not evidence and therefore yields no cut.
    let plan = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip_with("a", 0.0, 10.0, "mic.wav", |value| {
                value["disabled"] = json!(true)
            })],
        )
        .source("mic.wav", vec![(2.0, 3.0)])
        .build()
        .unwrap();
    assert!(plan.intervals.is_empty(), "a disabled clip is not analysed");
    assert!(plan.removals.is_empty());
}

#[test]
fn muted_analysis_track_warns_and_yields_no_cut() {
    let plan = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            true,
            vec![clip("a", 0.0, 10.0, "mic.wav")],
        )
        .source("mic.wav", vec![(2.0, 3.0)])
        .build()
        .unwrap();
    assert!(plan.intervals.is_empty());
    assert!(plan
        .warnings
        .iter()
        .any(|warning| warning.contains("no usable analysis track")));
}

#[test]
fn selection_range_clips_the_intervals() {
    let plan = Fixture::new()
        .sequence(0, ticks(2.5), ticks(4.0))
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 10.0, "mic.wav")],
        )
        .source("mic.wav", vec![(2.0, 3.0), (3.5, 4.5)])
        .build()
        .unwrap();
    let intervals: Vec<(f64, f64)> = plan
        .intervals
        .iter()
        .map(|interval| {
            (
                interval.start_ticks as f64 / SECOND as f64,
                interval.end_ticks as f64 / SECOND as f64,
            )
        })
        .collect();
    // Both silences are clipped to the selection (2.5 s to 4.0 s). The first
    // starts at the selection border 2.5 s, which is not on the 25 fps grid, so
    // conservative snapping moves it to the next frame boundary at 2.52 s.
    assert_eq!(intervals, vec![(2.52, 3.0), (3.52, 4.0)]);
}

#[test]
fn plan_mode_flags_are_parsed_and_applied() {
    for (text, expected) in [
        ("delete", PlanMode::DeleteRipple),
        ("delete_lift", PlanMode::DeleteLift),
        ("keep", PlanMode::KeepCuts),
        ("mute", PlanMode::Mute),
    ] {
        assert_eq!(PlanMode::parse(text).unwrap(), expected);
    }
    assert!(PlanMode::parse("explode").is_err());
    assert_eq!(
        RippleDriver::parse("audio_first").unwrap(),
        RippleDriver::AudioFirst
    );

    let mute = Fixture::new()
        .mode("mute")
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 10.0, "mic.wav")],
        )
        .source("mic.wav", vec![(2.0, 3.0)])
        .build()
        .unwrap();
    assert_eq!(mute.mutes.len(), 1);
    assert!(mute.removals.is_empty());
    assert_eq!(mute.expected_duration_delta_ticks, 0);

    let keep = Fixture::new()
        .mode("keep")
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 10.0, "mic.wav")],
        )
        .source("mic.wav", vec![(2.0, 3.0)])
        .build()
        .unwrap();
    assert_eq!(keep.razor_points.len(), 2);
    assert!(keep.removals.is_empty());
    assert!(keep.mutes.is_empty());
}

/// The first supported host subset analyses raw source files. Clip gain, audio
/// effects and channel routing do not appear there, so such clips are rejected
/// instead of being cut on wrong evidence.
#[test]
fn raw_source_analysis_rejects_clip_gain_effects_and_routing() {
    let cases: Vec<MutationCase> = vec![
        (
            "gain",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0]["clips"][0]["gainDb"] = json!(3.0);
            }),
        ),
        (
            "effects",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0]["clips"][0]["audioEffects"] = json!(true);
            }),
        ),
        (
            "routing",
            Box::new(|value: &mut serde_json::Value| {
                value["tracks"][0]["clips"][0]["channelMappingChanged"] = json!(true);
            }),
        ),
    ];
    for (label, mutate) in cases {
        let fixture = Fixture::new()
            .analysis(&[("audio", 0)])
            .track(
                "audio",
                0,
                "dialogue",
                false,
                false,
                vec![clip("a", 0.0, 10.0, "mic.wav")],
            )
            .source("mic.wav", vec![(2.0, 3.0)]);
        let mut snapshot = fixture.snapshot.clone();
        mutate(&mut snapshot);
        let request = PlanRequest::from_json(&snapshot.to_string()).unwrap();
        let mut lookup = |_media: &str| Ok(vec![(2.0, 3.0)]);
        let plan = build_plan(&request, &mut lookup).unwrap();
        assert!(plan.intervals.is_empty(), "{label} must block the analysis");
        assert!(
            !plan.rejections.is_empty(),
            "{label} must be reported as a rejection"
        );
    }
}

/// rendered_mixdown is part of the protocol but not implemented: the engine
/// would still read the raw media files, so it must fail closed.
#[test]
fn rendered_mixdown_is_rejected_until_it_really_renders() {
    let fixture = Fixture::new().analysis(&[("audio", 0)]).track(
        "audio",
        0,
        "dialogue",
        false,
        false,
        vec![clip("a", 0.0, 10.0, "mic.wav")],
    );
    let mut snapshot = fixture.snapshot.clone();
    snapshot["analysisSource"] = json!("rendered_mixdown");
    let error = PlanRequest::from_json(&snapshot.to_string()).unwrap_err();
    assert!(
        error.contains("requires a native timeline render"),
        "unexpected error: {error}"
    );
}

/// A rejected analysis clip must protect its whole range: the remaining tracks
/// must not be allowed to delete speech we have no evidence about.
#[test]
fn unreadable_dialogue_clip_protects_its_range() {
    // A0 speaks and its gain cannot be reproduced from the raw file, A1 is
    // silent. Without protection the intersection would delete A0 speech.
    let fixture = Fixture::new()
        .analysis(&[("audio", 0), ("audio", 1)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip_with("a0", 0.0, 10.0, "mic-gain.wav", |value| {
                value["gainDb"] = json!(20.0);
            })],
        )
        .track(
            "audio",
            1,
            "dialogue",
            false,
            false,
            vec![clip("a1", 0.0, 10.0, "mic2.wav")],
        )
        .source("mic-gain.wav", vec![]) // raw file looks silent
        .source("mic2.wav", vec![(0.0, 10.0)]); // second microphone is silent
    let request = PlanRequest::from_json(&fixture.snapshot.to_string()).unwrap();
    let mut sources = fixture.sources.clone();
    let mut lookup = |media: &str| Ok(sources.remove(media).unwrap_or_default());
    let plan = build_plan(&request, &mut lookup).unwrap();
    assert!(
        plan.intervals.is_empty(),
        "a clip we could not analyse must protect its range: {:?}",
        plan.intervals
    );
    assert!(plan
        .rejections
        .iter()
        .any(|rejection| rejection.clip_id == "a0" && rejection.reason.contains("gain 20")));
}

/// Unknown safety flags are rejected, never treated as false.
#[test]
fn unknown_safety_flags_fail_closed() {
    for (field, value) in [
        ("timeRemap", json!(null)),
        ("reversed", json!(null)),
        ("nested", json!(null)),
        ("audioEffects", json!(null)),
    ] {
        let fixture = Fixture::new()
            .analysis(&[("audio", 0)])
            .track(
                "audio",
                0,
                "dialogue",
                false,
                false,
                vec![clip("a", 0.0, 10.0, "mic.wav")],
            )
            .source("mic.wav", vec![(2.0, 3.0)]);
        let mut snapshot = fixture.snapshot.clone();
        snapshot["tracks"][0]["clips"][0][field] = value;
        let request = PlanRequest::from_json(&snapshot.to_string()).unwrap();
        let mut lookup = |_media: &str| Ok(vec![(2.0, 3.0)]);
        let plan = build_plan(&request, &mut lookup).unwrap();
        assert!(
            plan.intervals.is_empty(),
            "unknown {field} must block the cut"
        );
        assert!(
            plan.rejections
                .iter()
                .any(|rejection| rejection.reason.contains("could not be read")),
            "unknown {field} must be reported: {:?}",
            plan.rejections
        );
    }
}

#[test]
fn native_render_uses_timeline_seconds_and_never_raw_media() {
    let mut fixture = Fixture::new().analysis(&[("audio", 0)]).track(
        "audio",
        0,
        "dialogue",
        false,
        false,
        vec![clip_with("a", 0.0, 10.0, "unreadable-source.wav", |c| {
            c["linked"] = json!(null);
            c["gainDb"] = json!(null);
            c["timeRemap"] = json!(null);
            c["audioEffects"] = json!(true);
            c["channelMappingChanged"] = json!(null);
            c["inPointSeconds"] = json!(50.0);
            c["outPointSeconds"] = json!(70.0);
            c["speed"] = json!(2.0);
        })],
    );
    fixture.snapshot["analysisSource"] = json!("rendered_mixdown");
    fixture.snapshot["renderedMixdown"] =
        json!({"mediaPath":"native.wav","analysisTracks":[{"kind":"audio","index":0}]});
    let request = PlanRequest::from_json(&fixture.snapshot.to_string()).unwrap();
    let mut lookup = |path: &str| {
        assert_eq!(path, "native.wav");
        Ok(vec![(2.0, 3.0)])
    };
    let plan = build_plan(&request, &mut lookup).unwrap();
    assert_eq!(plan.intervals[0].start_ticks, 2 * SECOND);
    assert_eq!(plan.removed_ticks, SECOND);
}

#[test]
fn native_render_partitions_existing_clip_boundaries() {
    let mut fixture = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 10.0, "raw.wav")],
        )
        .track(
            "video",
            0,
            "other",
            false,
            false,
            vec![
                clip("v1", 0.0, 2.5, "v.mov"),
                clip("v2", 2.5, 10.0, "v.mov"),
            ],
        )
        .source("native.wav", vec![(2.0, 3.0)]);
    fixture.snapshot["analysisSource"] = json!("rendered_mixdown");
    fixture.snapshot["renderedMixdown"] =
        json!({"mediaPath":"native.wav","analysisTracks":[{"kind":"audio","index":0}]});
    // 2.5 seconds is not on a 25 fps frame boundary. Use 2.52 seconds.
    fixture.snapshot["tracks"][1]["clips"][0]["endTicks"] = json!(ticks(2.52).to_string());
    fixture.snapshot["tracks"][1]["clips"][1]["startTicks"] = json!(ticks(2.52).to_string());
    let plan = fixture.build().unwrap();
    assert_eq!(plan.intervals.len(), 2);
    assert_eq!(plan.intervals[0].end_ticks, ticks(2.52));
    assert_eq!(plan.intervals[1].start_ticks, ticks(2.52));
    assert_eq!(plan.removed_ticks, SECOND);
    assert_eq!(plan.removals.iter().filter(|r| r.ripple).count(), 2);
}

#[test]
fn native_render_rejects_mismatched_track_selection() {
    let mut fixture = Fixture::new().analysis(&[("audio", 0)]).track(
        "audio",
        0,
        "dialogue",
        false,
        false,
        vec![clip("a", 0.0, 10.0, "raw.wav")],
    );
    fixture.snapshot["analysisSource"] = json!("rendered_mixdown");
    fixture.snapshot["renderedMixdown"] =
        json!({"mediaPath":"native.wav","analysisTracks":[{"kind":"audio","index":1}]});
    assert!(fixture
        .build()
        .unwrap_err()
        .contains("differ from the selected tracks"));
}

#[test]
fn disjoint_sections_never_cut_the_gap_between_selected_clips() {
    let mut fixture = Fixture::new()
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("voice", 0.0, 10.0, "voice")],
        )
        .analysis(&[("audio", 0)])
        .source("voice", vec![(0.0, 10.0)]);
    fixture.snapshot["selectedSections"] = json!([
        {"startTicks":ticks(1.0).to_string(),"endTicks":ticks(2.0).to_string()},
        {"startTicks":ticks(5.0).to_string(),"endTicks":ticks(6.0).to_string()}
    ]);
    let plan = fixture.build().unwrap();
    assert_eq!(plan.intervals.len(), 2);
    assert_eq!(plan.intervals[0].start_ticks, ticks(1.0));
    assert_eq!(plan.intervals[0].end_ticks, ticks(2.0));
    assert_eq!(plan.intervals[1].start_ticks, ticks(5.0));
    assert_eq!(plan.intervals[1].end_ticks, ticks(6.0));
    fixture.snapshot["selectedSections"] = json!([]);
    assert!(fixture.build().is_err());
    fixture.snapshot["selectedSections"] = json!([{"startTicks":"-1","endTicks":"1"}]);
    assert!(fixture.build().is_err());
}

fn rendered(fixture: &mut Fixture) {
    fixture.snapshot["analysisSource"] = json!("rendered_mixdown");
    fixture.snapshot["renderedMixdown"] =
        json!({"mediaPath":"native.wav","analysisTracks":[{"kind":"audio","index":0}]});
}

/// Quiet b-roll after the last dialogue clip is rendered as silence but must
/// never be removed.
#[test]
fn native_render_never_cuts_outside_dialogue_clips() {
    let mut fixture = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 5.0, "raw.wav")],
        )
        .track(
            "video",
            0,
            "other",
            false,
            false,
            vec![clip("v", 0.0, 10.0, "v.mov")],
        )
        .source("native.wav", vec![(2.0, 3.0), (6.0, 8.0)]);
    rendered(&mut fixture);
    let plan = fixture.build().unwrap();
    assert_eq!(plan.intervals.len(), 1, "{:?}", plan.intervals);
    assert_eq!(plan.intervals[0].start_ticks, 2 * SECOND);
    assert_eq!(plan.intervals[0].end_ticks, 3 * SECOND);
}

/// A disabled dialogue clip is not evidence for a pause either.
#[test]
fn native_render_ignores_disabled_dialogue_clips_for_coverage() {
    let mut fixture = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![
                clip("a", 0.0, 5.0, "raw.wav"),
                clip_with("b", 5.0, 10.0, "raw.wav", |c| c["disabled"] = json!(true)),
            ],
        )
        .source("native.wav", vec![(6.0, 8.0)]);
    rendered(&mut fixture);
    let plan = fixture.build().unwrap();
    assert!(plan.intervals.is_empty(), "{:?}", plan.intervals);
}

#[test]
fn minimum_cut_is_two_frames_and_at_least_100_ms() {
    assert_eq!(min_cut_ticks(FRAME_25), TICKS_PER_SECOND / 10);
    assert_eq!(min_cut_ticks(TICKS_PER_SECOND / 60), TICKS_PER_SECOND / 10);
    assert_eq!(min_cut_ticks(TICKS_PER_SECOND / 10), TICKS_PER_SECOND / 5);
}

/// 2.00 to 2.09 snaps to two frames (80 ms) and is dropped, 4.00 to 4.12 is
/// three frames (120 ms) and stays.
#[test]
fn removals_shorter_than_the_minimum_cut_are_dropped() {
    let plan = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 10.0, "mic.wav")],
        )
        .source("mic.wav", vec![(2.0, 2.09), (4.0, 4.12)])
        .build()
        .unwrap();
    assert_eq!(plan.intervals.len(), 1, "{:?}", plan.intervals);
    assert_eq!(plan.intervals[0].start_ticks, 4 * SECOND);
    assert_eq!(plan.intervals[0].end_ticks, ticks(4.12));
}

#[test]
fn intervals_carry_the_cumulative_removed_time() {
    let plan = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![clip("a", 0.0, 10.0, "mic.wav")],
        )
        .source("mic.wav", vec![(2.0, 3.0), (5.0, 6.48)])
        .build()
        .unwrap();
    assert_eq!(plan.intervals.len(), 2);
    assert_eq!(plan.intervals[0].cumulative_removed_ticks, SECOND);
    assert_eq!(
        plan.intervals[1].cumulative_removed_ticks,
        SECOND + ticks(1.48)
    );
    let json = serde_json::to_value(&plan).unwrap();
    assert_eq!(
        json["intervals"][1]["cumulativeRemovedTicks"],
        json!((SECOND + ticks(1.48)).to_string())
    );
}

/// The threshold estimate and the rendered cut path share one notion of
/// dialogue time: enabled clips on the selected dialogue tracks only.
#[test]
fn dialogue_coverage_uses_enabled_clips_of_selected_tracks() {
    let fixture = Fixture::new()
        .analysis(&[("audio", 0)])
        .track(
            "audio",
            0,
            "dialogue",
            false,
            false,
            vec![
                clip("a", 0.0, 2.0, "mic.wav"),
                clip("b", 2.0, 4.0, "mic.wav"),
                clip_with("c", 6.0, 8.0, "mic.wav", |c| c["disabled"] = json!(true)),
            ],
        )
        .track(
            "audio",
            1,
            "other",
            false,
            false,
            vec![clip("music", 0.0, 10.0, "music.wav")],
        );
    let request = PlanRequest::from_json(&fixture.snapshot.to_string()).unwrap();
    assert_eq!(dialogue_coverage(&request), vec![(0, 4 * SECOND)]);
}
