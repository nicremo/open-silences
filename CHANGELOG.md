# Changelog

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
