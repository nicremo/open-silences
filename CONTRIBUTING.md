# Contributing

Open Silences is an MIT licensed development alpha. By contributing you agree that your contribution is released under the same license.

Keep changes focused. Use English commit messages such as `fix: handle missing host JSON`. Preserve exact tick strings, backup verification, source-range checks and fail-closed behavior. Run the checks documented in the README before proposing changes.

For host changes, test only synthetic media in dedicated sequences. Record the Premiere version, frame rate, selected range, expected cuts, actual clip readback and backup equality. Unit tests and CI cannot replace live Premiere tests.

Issue reports should include the extension version, operating system, Premiere version, frame rate, reproduction steps, expected behavior and exact error message. Share a minimal synthetic fixture rather than an original project or recording. Evidence folders can contain rendered audio and local file paths.

Never commit recordings, project files, third-party binaries, credentials or runtime evidence. See `docs/PROVENANCE.md` for the source boundary.
