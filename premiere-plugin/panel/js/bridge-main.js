/**
 * Entry of the invisible Open Silences bridge extension.
 *
 * Starts with Premiere, loads the same silences.jsx as the panel and serves
 * the agent CLI through the file queue in the user's Application Support.
 */
import {startBridge} from './bridge.js';
import {BRIDGE_SUBPATH} from './bridge-protocol.js';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const csInterface = new CSInterface();

startBridge({
  fs,
  path,
  directory: path.join(os.homedir(), ...BRIDGE_SUBPATH),
  evalScript: script => new Promise(resolve => csInterface.evalScript(script, resolve)),
  log: error => console.error('Open Silences bridge:', error)
});
