# Security policy

## Supported versions

Only the latest alpha release is maintained. No stable release is available yet.

## Reporting an issue

Report security concerns privately through GitHub private vulnerability reporting in the Security tab of this repository. Do not attach credentials, original projects, private recordings or rendered WAV evidence to an issue.

The extension runs a local binary through CEP Node integration and edits the active Premiere sequence. It validates snapshots and preserves a sequence backup. Native exports and cuts are not interruptible. An interrupted or failed mutation may require restoring the named backup.

No network service is required by the analysis workflow. Local evidence may include audio, media paths and timeline metadata. Preserve it only as long as needed for debugging.
