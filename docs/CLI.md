# Agent CLI

`open-silences` runs the complete panel workflow from a terminal or an agent. It talks to Premiere Pro through a small invisible extension that starts with Premiere and only accepts the Open Silences host calls.

## Setup

1. Install the extension as described in the README and restart Premiere Pro once. The bridge starts with Premiere, the panel does not need to be open. After an update of the extension folder, restart Premiere so the bridge loads the new version.
2. Link the CLI into your path:

   ```bash
   mkdir -p ~/.local/bin
   ln -s "$HOME/Library/Application Support/Adobe/CEP/extensions/open-silences/cli/open-silences.mjs" ~/.local/bin/open-silences
   ```

3. Check the connection: `open-silences status`

Node.js 22 or newer is required.

## Commands

| Command | Changes the project | What it does |
| --- | --- | --- |
| `status` | no | Bridge heartbeat and engine path |
| `sequence` | no | Active sequence, length, frame rate, audio tracks A1, A2 |
| `estimate` | no | Estimates the noise floor of the chosen tracks |
| `preview` | no | Analyses and reports cuts and removed seconds, no backup |
| `cut --yes` | yes | Verified backup, analysis, second mix check, cut, readback |

All commands work on the active sequence in Premiere.

## Defaults

The defaults are the panel's Standard settings: entire timeline, track A1, noise floor -46 dB, pacing Standard (pauses from 160 ms, speech from 160 ms, 160 ms before and after speech).

| Option | Default | Values |
| --- | --- | --- |
| `--scope` | `entire` | `entire`, `inout`, `selected` |
| `--tracks` | `A1` | comma separated, e.g. `A1,A2` |
| `--threshold` | `-46` | -60 to 0, or `auto` |
| `--preset` | `standard` | `standard`, `calm`, `relaxed`, `fluid`, `energetic`, `tight` |
| `--min-pause`, `--min-speech`, `--lead-in`, `--tail` | from preset | 0 to 10000 ms |
| `--timeout` | `1800` | seconds per Premiere call |
| `--engine` | bundled engine | path to `silences-engine` |

`--threshold auto` estimates the noise floor first, like **Estimate level automatically** in the panel, and uses the result.

## For agents

Use `--json`: stdout carries exactly one JSON object, progress goes to stderr.

Recommended order:

```bash
open-silences status --json
open-silences sequence --json
open-silences preview --json
open-silences cut --yes --json
```

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | Failed. Read `error`. A `backupName` means the original is safe in that sequence |
| 2 | Wrong usage, nothing was sent to Premiere |
| 3 | Premiere or the bridge is not running |
| 4 | Outcome unknown |

Exit code 4 means a Premiere call did not answer in time and may still run. Do not repeat the command. Run `open-silences sequence --json` and compare the timeline first.

Only one command runs at a time. Premiere does not respond while it renders or cuts; on a long timeline that takes a while.

## How it connects

The bridge reads command files from `~/Library/Application Support/open-silences/bridge/` (only readable by your user) and answers with response files. It accepts the six Open Silences host calls only, never raw ExtendScript, and refuses commands that waited longer than two minutes.
