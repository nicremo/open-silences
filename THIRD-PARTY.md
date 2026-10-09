# Third-party components

| Component | Source and terms | Shipped material |
| --- | --- | --- |
| Adobe CSInterface | Official Adobe CEP Resources, Adobe General SDK License Agreement | `premiere-plugin/panel/js/CSInterface.js`, its notice, and the original SDK license PDF |
| JSON2 | Douglas Crockford JSON-js, Public Domain according to its original header | Unmodified code embedded in `silences.jsx`, with source hash and notice |
| Rust dependencies | Crates locked in `Cargo.lock`; each retains its own license | Build dependencies, not copied application bundles |
| FFmpeg and FFprobe | Installed separately; terms vary by build | Not bundled; used by development fixtures and the optional source-audio CLI |

The Adobe notice and JSON2 notice record source URLs and SHA256 values. Package tests verify these hashes.

- [Adobe SDK notice](premiere-plugin/panel/js/CSInterface.NOTICE.md)
- [Adobe SDK license](premiere-plugin/licenses/GenSDK_IHC-en_US-20120323_1224.pdf)
- [JSON2 notice](premiere-plugin/panel/jsx/JSON2.NOTICE.md)

No application bundle, recording, Premiere project or private runtime evidence is included. The project's own code is MIT licensed, see `LICENSE`.
