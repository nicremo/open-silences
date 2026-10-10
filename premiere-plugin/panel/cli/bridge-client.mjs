/**
 * CLI side of the Open Silences bridge: one command file per host call.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {PROTOCOL_VERSION, BRIDGE_SUBPATH, commandFile, responseFile, isHeartbeatFresh} from '../js/bridge-protocol.js';
import {interpretHostReply} from '../js/core.js';

export class BridgeUnavailable extends Error {}
export class OutcomeUnknown extends Error {
  constructor(requestId, call) {
    super(`No reply to ${call} (request ${requestId}) within the timeout. The call may still run in Premiere. Read the sequence before doing anything else.`);
    this.requestId = requestId;
    this.call = call;
  }
}

export const defaultBridgeDirectory = () => path.join(os.homedir(), ...BRIDGE_SUBPATH);

export function readHeartbeat(directory) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, 'heartbeat.json'), 'utf8')); } catch (_) { return null; }
}

export function createBridgeClient({directory = defaultBridgeDirectory(), timeoutMs = 1800000, pollMs = 100, now = () => Date.now()} = {}) {
  let unknown = null;
  async function call(name, payload) {
    if (!isHeartbeatFresh(readHeartbeat(directory), now())) {
      throw new BridgeUnavailable('The Open Silences bridge is not running. Start Premiere Pro with Open Silences installed.');
    }
    const id = randomUUID();
    const target = path.join(directory, commandFile(id));
    fs.writeFileSync(`${target}.part`, JSON.stringify({protocol:PROTOCOL_VERSION, id, name, payload, createdAt:now()}), {mode:0o600});
    fs.renameSync(`${target}.part`, target);
    const answer = path.join(directory, responseFile(id));
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (fs.existsSync(answer)) {
        const response = JSON.parse(fs.readFileSync(answer, 'utf8'));
        fs.unlinkSync(answer);
        return response.ok ? interpretHostReply(response.reply) : {ok:false, error:response.error};
      }
      await sleep(pollMs);
    }
    // The command stays queued on purpose: removing it could race the bridge.
    unknown = new OutcomeUnknown(id, name);
    throw unknown;
  }
  return {call, lastUnknown:() => unknown};
}

export function acquireLock(directory) {
  const lock = path.join(directory, 'cli.lock');
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), {flag:'wx', mode:0o600});
      return () => { try { fs.unlinkSync(lock); } catch (_) {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(fs.readFileSync(lock, 'utf8'));
      let alive = false;
      try { process.kill(owner, 0); alive = true; } catch (_) {}
      if (alive) throw Error(`Another open-silences command is running (pid ${owner}).`);
      fs.unlinkSync(lock);
    }
  }
  throw Error('The CLI lock could not be acquired.');
}
