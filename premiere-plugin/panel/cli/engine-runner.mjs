/**
 * Runs the bundled Rust engine for the CLI, mirroring runEngine in main.js.
 * Evidence files are kept on purpose, as in the panel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const STDOUT_LIMIT_BYTES = 32 * 1024 * 1024;
const STDERR_LIMIT_BYTES = 8192;

export function resolveEnginePath({flag, env = process.env} = {}) {
  // An explicit choice must exist; it never falls back silently.
  if (flag) {
    if (fs.existsSync(flag)) return flag;
    throw Error(`The engine was not found at ${flag}. Pass --engine <path>.`);
  }
  const candidates = [
    env.OPEN_SILENCES_ENGINE,
    // Installed package: open-silences/cli/ next to open-silences/engine/.
    fileURLToPath(new URL('../engine/silences-engine', import.meta.url)),
    // Repository: premiere-plugin/panel/cli/ next to premiere-plugin/dist/.
    fileURLToPath(new URL('../../dist/open-silences/engine/silences-engine', import.meta.url)),
    fileURLToPath(new URL('../../engine/target/release/silences-engine', import.meta.url))
  ].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw Error('The engine was not found. Pass --engine <path>.');
  return found;
}

export function createEngineRunner({enginePath, evidenceRoot = path.join(os.tmpdir(), 'open-silences-evidence'), timeoutSeconds = 1800}) {
  let child = null, cancelled = false;
  const newRunDirectory = () => {
    const directory = path.join(evidenceRoot, randomUUID());
    fs.mkdirSync(directory, {recursive:true});
    return directory;
  };
  function run(snapshot, {estimate = false} = {}) {
    const runDirectory = newRunDirectory();
    const snapshotPath = path.join(runDirectory, 'snapshot.json');
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    const args = ['plan', '--input', snapshotPath, '--watch-stdin', '--timeout-seconds', String(timeoutSeconds)];
    if (estimate) args.push('--with-db-values');
    cancelled = false;
    return new Promise(resolve => {
      child = spawn(enginePath, args, {stdio:['pipe','pipe','pipe']});
      const out = []; let outBytes = 0; let errTail = Buffer.alloc(0);
      child.stdout.on('data', chunk => { outBytes += chunk.length; if (outBytes <= STDOUT_LIMIT_BYTES) out.push(chunk); else cancel(); });
      child.stderr.on('data', chunk => { const all = Buffer.concat([errTail, chunk]); errTail = all.subarray(Math.max(0, all.length - STDERR_LIMIT_BYTES)); });
      let settled = false;
      const finish = outcome => {
        if (settled) return;
        settled = true;
        child = null;
        try {
          fs.writeFileSync(path.join(runDirectory, 'stdout.json'), Buffer.concat(out));
          fs.writeFileSync(path.join(runDirectory, 'stderr.txt'), errTail);
        } catch (_) {}
        resolve({...outcome, runDirectory});
      };
      child.on('error', error => finish({ok:false, error:`The engine could not start: ${error.message}`}));
      child.on('close', code => {
        if (outBytes > STDOUT_LIMIT_BYTES) return finish({ok:false, error:'The engine output was too large and was discarded.'});
        if (cancelled) return finish({ok:false, error:'The engine run was cancelled.'});
        if (code !== 0) return finish({ok:false, error:errTail.toString('utf8').trim() || `The engine exited with code ${code}.`});
        try { finish({ok:true, envelope:JSON.parse(Buffer.concat(out).toString('utf8'))}); }
        catch (error) { finish({ok:false, error:`The engine output is not readable: ${error.message}`}); }
      });
    });
  }
  function cancel() {
    const running = child;
    if (!running) return;
    cancelled = true;
    try { running.stdin.end(); } catch (_) {}
    setTimeout(() => { if (child === running) running.kill('SIGTERM'); }, 1500).unref();
    setTimeout(() => { if (child === running) running.kill('SIGKILL'); }, 4000).unref();
  }
  return {renderPath:() => path.join(newRunDirectory(), 'timeline.wav'), run, cancel};
}
