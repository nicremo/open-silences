# Pause detection

This document specifies how Open Silences decides which parts of the timeline are pauses. It is the only source for the detector in `premiere-plugin/engine/src/level.rs` and `premiere-plugin/engine/src/detect.rs`. Change this document first when the behavior changes.

## Goals

1. Cut wherever the level stays below the threshold, and keep a defined amount of air around speech.
2. Place every cut edge as close to the real end and start of speech as the level grid allows.
3. Produce exactly the cuts the settings describe: every cut is at least the minimum pause long.
4. Be deterministic. The same audio and settings always produce the same plan.

## Input

Premiere renders the selected dialogue tracks as a mono WAV. The analysed range runs from the start of the first selected section to the end of the last one. The engine reads the PCM natively.

## Stage 1: levels

The analysed range is split into consecutive windows of `max(1, floor(sampleRate / 50))` sample frames, 20 ms at the usual rates. The grid starts at the first sample of the analysed range. A trailing partial window is a value of its own, computed from its own number of frames.

For every window the RMS is the square root of the mean of the squared samples. With several channels the loudest channel wins; a mono render has one channel.

The level of a window is `20 * log10(rms)` in dBFS. A non finite, zero or negative RMS and every level below -60 dBFS map to **-60 dBFS**. The level is stored as a 32 bit float and then rounded to two decimals: the exact decimal value of the float is rounded, halves away from zero.

Value `i` starts at `i / 50` seconds. The analysed duration is `count / 50` seconds.

## Stage 2: raw pauses

A value is **quiet** when its level is strictly below the threshold. A level equal to the threshold counts as speech. Every maximal run of quiet values is a raw pause from `first * d` to `next * d` seconds, where `d = 1 / 50`, `first` is the first quiet value and `next` is the first value after the run, or the number of values.

## Stage 3: edge refinement

Each edge of a raw pause moves by at most one value towards the side where the energy of the neighbouring values points, so it lands between the grid points where speech fades into quiet.

The power of a level is `P(x) = 10^(x / 10)`. The speech share of a level `x` between a loud reference `L` and a quiet reference `Q` is:

- `1` when `x > Q`, else `0`, if `P(L) <= P(Q)`,
- otherwise `(P(x) - P(Q)) / (P(L) - P(Q))`, limited to 0 and 1.

Let `a = round(start / d)` and `b = round(end / d)` be the value indices of the raw pause and `v[k]` the level of value `k`, with `k` limited to the valid indices.

- **Start**, only when `a > 0`: `L = v[a - 2]`, `Q = v[min(b, a + 1)]`, `r = share(v[a - 1]) + share(v[a])`, new start `(a - 1 + r) * d`.
- **End**, only when `b` is below the number of values: `L = v[b + 1]`, `Q = v[max(a, b - 2)]`, `r = share(v[b]) + share(v[b - 1])`, new end `(b + 1 - r) * d`.

When a result is not finite or the new start is not before the new end, both edges keep their raw values.

## Stage 4: air

Every pause keeps air around speech:

- `tail` is kept after the preceding speech: the start moves later by `tail`, but at most to the analysed duration. A start within 5 ms of 0 stays where it is.
- `leadIn` is kept before the following speech: the end moves earlier by `leadIn`, but at most to 0. An end within 5 ms of the analysed duration stays where it is.

The pauses are then sorted by start and merged in order: a pause that starts at or before the end of the current merged pause joins it, and the merged end is the later of both ends.

## Stage 5: minimum pause

A pause stays only if its length is at least `max(minPause, 0.05)` seconds. This also drops every pause that the air made empty or negative.

## Stage 6: short speech

Walking from the first pause, as long as the gap between the current pause and the next one is shorter than `max(minSpeech, 0.05)` seconds, the next pause joins the current one: the current end becomes the end of the next pause. Then the minimum pause rule of stage 5 runs once more.

The gap already contains the air of both pauses. A short piece of speech is therefore only cut when the air on both sides together is shorter than `minSpeech`.

## Stage 7: cut spacing

This stage runs only when `minCutSpacing` is greater than 0. Neighbouring pauses whose gap is at most `minCutSpacing` form groups; a group is a chain of neighbours. In every group the longest pause stays uncut and leaves the list; on a tie it is the first of them. The groups are formed again on the shorter list until no group is left.

## Stage 8: sections

The pauses are relative to the start of the analysed range. Every pause is intersected with every selected section: the start is the later of both starts, the end the earlier of both ends, and the piece is kept when its start is not after its end. The pieces are shifted to timeline seconds and sorted by start.

## Planner rules

The planner turns pauses into an integer tick plan:

- A pause start becomes the frame `ceil(start * fps - 0.0001)`, a pause end the frame `floor(end * fps + 0.0001)`. The tolerance is a ten thousandth of a frame. Only pieces whose start frame is before their end frame are cut. There is no further minimum: stage 5 already decides.
- With the cut scope **selection** every track is cut inside the selected sections, gaps between clips included. With the cut scope **dialogue** only time covered by an enabled clip on a selected dialogue track can be removed.

## Settings

| Setting | Protocol name | Panel default | Meaning |
| --- | --- | --- | --- |
| Threshold | `thresholdDb` | -45 dB | Values strictly below this level are quiet. Valid from -90 to 0 dB. At -60 dB or below no pause is found, because levels end at -60 dB. |
| Minimum pause | `minPause` | 0.16 s | Shortest cut after the air is removed, never under 0.05 s. |
| Minimum speech | `minSpeech` | 0.16 s | Two cuts whose gap, air included, is shorter than this become one, never under 0.05 s. |
| Lead-in | `leadIn` | 0.16 s | Air kept before speech. Panel label: "Air before speech". |
| Tail | `tail` | 0.16 s | Air kept after speech. Panel label: "Air after speech". |
| Cut spacing | `minCutSpacing` | 0 s (off) | Neighbouring cuts at most this far apart are thinned out, see stage 7. |

All durations are seconds from 0 to 60.

## Threshold suggestion

"Estimate level automatically" uses the levels of stage 1 whose start time lies inside a selected section, measured from the start of the analysed range. A section ends at the analysed duration at the latest. The levels are split into a quiet and a loud group with two cluster k-means:

1. The start centres are the lowest and the highest level.
2. Every level joins the nearer centre; on a tie the quiet one.
3. Every centre moves to the mean of its group. An empty group keeps its centre.
4. Steps 2 and 3 repeat until every centre moved by less than 0.0001 of its previous value, at most 50 times. A previous centre of exactly 0 never counts as settled.
5. The suggestion is the highest level of the quiet group from the last assignment, rounded to whole dB with halves rounded up.

When all levels are equal, the suggestion is that level. Without levels there is no suggestion.
