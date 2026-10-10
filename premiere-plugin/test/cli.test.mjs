import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createEngineRunner, resolveEnginePath} from '../panel/cli/engine-runner.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'os-cli-'));
function fakeEngine(body) {
  const file = path.join(tempDir(), 'fake-engine.mjs');
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, {mode:0o755});
  return file;
}
const ECHO = `import fs from 'node:fs';
const args = process.argv.slice(2);
const snapshot = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));
process.stdout.write(JSON.stringify({plan:{intervals:[]}, args, threshold:snapshot.parameters.thresholdDb}));`;

test('the runner passes the snapshot file and the estimate flag and parses stdout',async()=>{
  const runner = createEngineRunner({enginePath:fakeEngine(ECHO), evidenceRoot:tempDir()});
  const result = await runner.run({parameters:{thresholdDb:-46}}, {estimate:true});
  assert.equal(result.ok, true, result.error);
  assert.equal(result.envelope.threshold, -46);
  assert.deepEqual(result.envelope.args.filter(a => a.startsWith('--')), ['--input','--watch-stdin','--timeout-seconds','--with-db-values']);
  assert.ok(fs.existsSync(path.join(result.runDirectory, 'snapshot.json')));
  assert.ok(fs.existsSync(path.join(result.runDirectory, 'stdout.json')));
});
test('a failing engine reports its stderr',async()=>{
  const runner = createEngineRunner({enginePath:fakeEngine(`process.stderr.write('bad snapshot'); process.exit(3);`), evidenceRoot:tempDir()});
  assert.deepEqual((await runner.run({})).error, 'bad snapshot');
});
test('render paths are fresh files inside new evidence directories',()=>{
  const runner = createEngineRunner({enginePath:'/x', evidenceRoot:tempDir()});
  const first = runner.renderPath(), second = runner.renderPath();
  assert.notEqual(path.dirname(first), path.dirname(second));
  assert.equal(path.basename(first), 'timeline.wav');
});
test('engine path: flag first, then environment, else an error',()=>{
  const engine = fakeEngine('');
  assert.equal(resolveEnginePath({flag:engine, env:{}}), engine);
  assert.equal(resolveEnginePath({env:{OPEN_SILENCES_ENGINE:engine}}), engine);
  assert.throws(() => resolveEnginePath({flag:'/missing/engine', env:{}}), /not found/);
});
