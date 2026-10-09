# Source inventory

Open Silences is written and maintained by Fabian Bitzer.

## Project files

- Rust block level analysis, pause detector, PCM reader, cut planner, process handling, CLI and tests.
- CEP interface, workflow, controller, ExtendScript host adapter and package builder.
- Specification of the pause detector in `docs/DETECTION.md`. The detector is implemented from this specification.
- Build, contribution and release documentation.

## Third-party files

The Adobe CSInterface bridge and the original SDK license are distributed with their source notice. The embedded JSON2 implementation keeps its original Public Domain header and hash notice. See `THIRD-PARTY.md`.

## Repository boundary

Runtime packages use an explicit file allowlist. Local research, recordings, Premiere projects, runtime evidence and credentials are never tracked.
