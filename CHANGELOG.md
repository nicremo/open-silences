# Changelog

## Unreleased

- Agent CLI `open-silences` with `status`, `sequence`, `estimate`, `preview` and `cut --yes`, driven through an invisible bridge extension that starts with Premiere. See `docs/CLI.md`.
- New pause detection: 20 ms levels with a -60 dBFS floor, pause edges refined between the level values, the air removed before the minimum pause is checked, short speech between two cuts joined with them and an optional spacing between cuts. See `docs/DETECTION.md`.
- "Estimate level automatically" splits the levels into room tone and speech and suggests the top of the room tone in whole dB.
- Cuts are rounded inwards to whole frames from the detected seconds; a single frame is a valid cut. A pause across clip boundaries counts as one cut.
- New cut scope: the whole selection on every track (default) or only under speech clips.
- Cutting runs in batches of 50 cuts from the end of the timeline while the sequence shows frame numbers. Every frame rate can be cut.
- Backup, the second render of the mix and the readback are optional. A cancel takes effect between two batches.
- The analysis render is mono with 32 bit float samples at the sequence rate, without a copy of the sequence; the other audio tracks are muted only during the export. Levels are measured at 16 kHz on every n-th sample, so no resampling filter softens them. The engine reads PCM16, PCM24 and float32 WAV natively.
- A transition only stops the pause it lies in, and the panel, the preview and the CLI name the reason when a range stays uncut.
- Pacing presets set all four timing values to the same value.
- The CLI starts with -45 dB as noise floor, the same value as the panel.
- Each cut is one extract between in and out points instead of razors and removals per clip piece; in and out points the user had set are restored.
- The backup no longer opens the copy and reads the sequence three times instead of nine; the analysis preset is rewritten by plain string search instead of a slow regular expression.
- A cut run makes 11 host calls instead of 17 and reads the timeline 7 times instead of 15. The first batch checks items and state right before its first cut; fingerprints are passed as separate strings, and the adapter writes JSON with its own, faster serializer.

## 0.2.0-alpha.2

- The panel speaks English, Spanish and German. English is the default; the language is chosen on first open and can be changed any time from the header.
- Host and engine diagnostics are written in English.
- Analysis copies are filed in the project bin **Open Silences Analysis**.
- The launch film is in English and shows the result inside the timeline: the removed time stays at the end of the track and is measured.

## 0.2.0-alpha.1

First tracked snapshot.

- Two-step panel for range selection and pause settings.
- Whole timeline, In/Out and selected-clip ranges.
- Pause detector on 10 ms block levels: short loud words stay, short quiet noises are ignored, lead-in and tail keep air around speech.
- Only time under an enabled dialogue clip is cut. Removals under 100 ms or two frames are skipped.
- Native sequence backup before analysis or cutting, frame-aligned planning and native readback.
- Faster cut application: plan and timeline are indexed once per run.
- Faster assembly: pauses are lifted and each remaining clip moves once, instead of one ripple delete per pause.
- Cleaner panel: run progress, cut preview with confirmation, result card and compact settings rows.
- Guarded integration coverage for 25 and 59.94 fps on Premiere Pro 26.5.2.

Installed-panel acceptance, signing, distribution licensing, Windows support and additional frame rates remain pending. The engine is numbered 2.0.0, the CEP manifest uses 0.2.0.
