#!/usr/bin/env bash
# Builds the Open Silences package inside the workspace.
#
# Important: this script only creates premiere-plugin/dist/open-silences/.
# It does not install anything, does not copy into the Adobe CEP folder and does
# not change any preference such as PlayerDebugMode. The installation steps are
# printed at the end for the user to run by hand.
set -euo pipefail

cd "$(dirname "$0")/.."
root="$PWD"
package="$root/dist/open-silences"

echo "1/3 Building the Rust engine"
cargo build --release --locked --manifest-path "$root/engine/Cargo.toml"

echo "2/3 Assembling the package"
mkdir -p "$package/engine"
cp "$root/panel/index.html" "$package/index.html"
cp "$root/panel/bridge.html" "$package/bridge.html"
mkdir -p "$package/CSXS" "$package/js" "$package/jsx"
cp "$root/panel/CSXS/manifest.xml" "$package/CSXS/manifest.xml"
cp "$root/panel/js/CSInterface.js" "$package/js/CSInterface.js"
cp "$root/panel/js/core.js" "$package/js/core.js"
cp "$root/panel/js/controller.js" "$package/js/controller.js"
cp "$root/panel/js/workflow.js" "$package/js/workflow.js"
cp "$root/panel/js/i18n.js" "$package/js/i18n.js"
cp "$root/panel/js/main.js" "$package/js/main.js"
cp "$root/panel/js/bridge.js" "$package/js/bridge.js"
cp "$root/panel/js/bridge-main.js" "$package/js/bridge-main.js"
cp "$root/panel/js/bridge-protocol.js" "$package/js/bridge-protocol.js"
cp "$root/panel/jsx/silences.jsx" "$package/jsx/silences.jsx"
cp "$root/panel/jsx/JSON2.NOTICE.md" "$package/jsx/JSON2.NOTICE.md"
cp "$root/panel/js/CSInterface.NOTICE.md" "$package/js/CSInterface.NOTICE.md"
mkdir -p "$package/licenses"
cp "$root/licenses/GenSDK_IHC-en_US-20120323_1224.pdf" "$package/licenses/"
cp "$root/engine/target/release/silences-engine" "$package/engine/silences-engine"
chmod +x "$package/engine/silences-engine"

echo "3/3 Package ready: $package"
cat <<'HINT'

This script installs nothing and changes no system setting.
The manual installation steps are in the README.

The native timeline analysis uses the Rust engine without external decoders.
HINT
