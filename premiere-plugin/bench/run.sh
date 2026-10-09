#!/usr/bin/env bash
# Source audio benchmark for the silence engine.
#
# Creates a deterministic 600 s fixture with speech-like bursts and measures
# wall time and peak memory of `silences-engine analyze`. Everything stays
# inside the workspace: fixture and results are written to bench/.
set -euo pipefail

cd "$(dirname "$0")/.."
engine="$PWD/engine/target/release/silences-engine"
fixture="$PWD/bench/fixture-600s.wav"
results="$PWD/bench/results.txt"

if [ ! -x "$engine" ]; then
  echo "engine binary missing, run: cargo build --release --manifest-path engine/Cargo.toml" >&2
  exit 1
fi

ffmpeg="$(command -v ffmpeg || true)"
if [ -z "$ffmpeg" ]; then
  echo "ffmpeg is required to build the fixture" >&2
  exit 1
fi

if [ ! -f "$fixture" ]; then
  "$ffmpeg" -v error -y \
    -f lavfi -i "aevalsrc=0.5*sin(2*PI*440*t)*lt(mod(t\\,4)\\,3):s=48000:d=600" \
    -ac 1 -c:a pcm_s16le "$fixture"
fi

{
  echo "fixture: $fixture"
  echo "engine:  $engine ($(stat -f%z "$engine") bytes)"
  echo
  for run in 1 2 3; do
    /usr/bin/time -l "$engine" analyze "$fixture" >/dev/null 2>"$PWD/bench/.time-$run"
    wall=$(awk '/real/ {print $1}' "$PWD/bench/.time-$run" | head -1)
    rss=$(awk '/maximum resident set size/ {print $1}' "$PWD/bench/.time-$run" | head -1)
    echo "run $run: wall ${wall}s, peak RSS $((rss / 1024 / 1024)) MB"
  done
  echo
  echo "pause summary:"
  "$engine" analyze "$fixture" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  duration", d["durationSec"], "s"); print("  blocks", d["valueCount"]); print("  pauses", len(d["pauses"])); print("  removed", round(d["removedSeconds"], 2), "s")'
} | tee "$results"

# Keep the timing reports as local evidence. They are excluded from Git.
