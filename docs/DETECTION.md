# Pause detection

This document specifies how Open Silences decides which parts of the timeline are pauses. It is the only source for the detector in `premiere-plugin/engine/src/level.rs` and `premiere-plugin/engine/src/detect.rs`. Change this document first when the behavior changes.

## Goals

1. Never remove speech. When in doubt, keep audio.
2. Keep short, clearly audible words such as "ja" or "und", even when they are shorter than the minimum speech duration.
3. Ignore short, quiet noises such as breaths, clicks and chair sounds inside a pause.
4. Produce cuts that are worth a jump cut: no removal shorter than 100 ms or two frames.
5. Be deterministic. The same audio and settings always produce the same plan.

## Input

Premiere renders the selected dialogue tracks to a PCM16 WAV file that starts at timeline tick zero. The engine reads it natively.

## Stage 1: block levels

The audio is split into consecutive blocks of `floor(sampleRate / 100)` sample frames, about 10 ms. For every block and every channel the mean square of the samples is computed. The loudest channel wins, so out of phase stereo never looks like silence.

The level of a block is `20 * log10(rms)` in dBFS, unrounded. Digital silence, non finite and non positive values map to the floor of **-100 dBFS**. A trailing partial block is analysed like a full block.

## Stage 2: audible regions

A block is **audible** when its level is greater than or equal to the threshold (`thresholdDb`). Consecutive audible blocks form a region. Every region remembers its peak level.

## Stage 3: bridge short pauses

When the gap between two neighbouring regions is shorter than `minPause`, both regions become one. The peak is the higher of both peaks. Gaps are measured in whole blocks: `round(seconds / blockSeconds)`.

## Stage 4: drop quiet blips

A region is removed when it is shorter than `minSpeech` **and** its peak stays below `thresholdDb + 10 dB`. Short regions with a clear peak are speech and stay.

Bridging runs before blip removal. A soft word that dips below the threshold for a few milliseconds is therefore judged as one region, not as several blips.

## Stage 5: pauses

The pauses are the gaps between the remaining regions, including the gap before the first region and after the last one. A pause shorter than `minPause` is kept as material.

Each pause is then shortened so speech keeps some air:

- `tail` is kept after the preceding speech. It moves the pause start later. A pause at the very start of the audio keeps its start.
- `leadIn` is kept before the following speech. It moves the pause end earlier. A pause at the very end of the audio keeps its end.

A pause that becomes empty is dropped. All times are clamped to the audio duration. Audio without any region is one pause from zero to the duration.

## Settings

| Setting | Protocol name | Panel default | Meaning |
| --- | --- | --- | --- |
| Threshold | `thresholdDb` | -45 dB | Blocks below this level count as quiet. Valid from -90 to 0 dB. |
| Minimum pause | `minPause` | 0.16 s | Shorter pauses stay. |
| Minimum speech | `minSpeech` | 0.16 s | Shorter regions without a clear peak count as noise. |
| Lead-in | `leadIn` | 0.16 s | Air kept before speech. Panel label: "Air before speech". |
| Tail | `tail` | 0.16 s | Air kept after speech. Panel label: "Air after speech". |

All durations are seconds from 0 to 60.

## Planner rules

The planner turns pauses into an integer tick plan. In addition to its safety rules:

- On a rendered timeline, only time covered by an enabled clip on a selected dialogue track can be removed. Quiet b-roll or gaps without dialogue are never cut.
- Pause starts snap to the next frame boundary and ends to the previous one, so a cut never reaches into kept material.
- After snapping, a removal shorter than `max(2 frames, 100 ms)` is dropped.

## Threshold suggestion

"Estimate level automatically" uses only blocks inside the selected range that are covered by an enabled clip on a selected dialogue track.

1. Blocks at or below -90 dBFS are digital silence from gaps, noise gates or denoisers. They are not room tone and are set aside. Their share of all blocks is the gated share.
2. Without at least one second of remaining blocks there is no suggestion.
3. The speech level is the 90th percentile of the remaining blocks. Below -50 dBFS there is no suggestion.
4. The quiet level is the lowest clear peak of the level histogram: 1 dB bins from -90 to 0 dBFS, smoothed over three bins, the first local maximum from below that holds at least 2 percent of the blocks and lies below the median. Without such a peak the 5th percentile is used.
5. A recording has a usable quiet level when speech is at least 12 dB above it. Without a usable quiet level but with a gated share of at least 5 percent, the pauses are digital silence and the quiet level is taken as -72 dBFS. Otherwise there is no suggestion.
6. The lower edge of speech is the 10th percentile of the blocks at least 12 dB above the quiet level.
7. The suggestion lies halfway between the quiet level and the lower edge of speech, so breaths, reverb tails and mouth noise near the room tone fall below it while soft syllables stay above it. It is at least 6 dB above the quiet level and never above the speech level minus 16 dB (the margin of ITU-T P.56 between active speech and its threshold).
8. The result is limited to -60 to -20 dB and rounded to 0.1 dB.

This replaces a fixed percentile, which drifts into speech when pauses are rare and into digital silence when pauses are gated.
