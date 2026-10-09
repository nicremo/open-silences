# Public release checklist

The repository is public since 0.2.0-alpha.1.

## Prepared

- [x] Single initial commit without earlier history.
- [x] Product name: Open Silences.
- [x] Scope limited to silence removal, with accurate alpha status.
- [x] Third-party notices and original SDK license retained.
- [x] CI workflow, contribution instructions and issue templates.
- [x] Changelog for 0.2.0-alpha.1.
- [x] Changelog for 0.2.0-alpha.2.

## Before public release

- [x] Select and apply the project-wide license (MIT).
- [ ] Review Adobe SDK distribution requirements and create a signed end-user package.
- [ ] Finish live acceptance of the installed panel after the JSON startup fix.
- [ ] Confirm the shift assembly on Premiere Pro 26.5.2 with linked clips and several tracks. If it fails, set `assembly` to `'ripple'` in `premiere-plugin/panel/js/workflow.js`.
- [ ] Record UI-driven synthetic cuts for all supported ranges and frame rates, backup equality and final readback.
- [ ] Recheck project naming and host-application trademark wording.
- [ ] Run the provenance gate from the implementation plan before every public push.
- [x] Owner's explicit instruction to make the repository public.

Linux CI validates the engine and source contracts. It is not evidence of a Linux Premiere plugin. Draft releases are preparation, not approved distribution artifacts.
