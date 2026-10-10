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

import {parseCliArgs, UsageError, CLI_DEFAULTS} from '../panel/cli/args.mjs';

test('defaults are entire timeline, A1, -46 dB and the Standard pacing',()=>{
  const parsed = parseCliArgs(['preview']);
  assert.equal(parsed.command, 'preview');
  assert.deepEqual(parsed.config, {scope:'entire', analysisTracks:[{kind:'audio', index:0}],
    settings:{threshold:-46, minPause:160, minSpeech:160, leadIn:160, tail:160}});
  assert.equal(parsed.autoThreshold, false);
  assert.equal(parsed.yes, false);
  assert.equal(CLI_DEFAULTS.threshold, -46);
});
test('presets, single timing overrides, tracks, scope and auto threshold',()=>{
  const parsed = parseCliArgs(['cut','--yes','--preset','calm','--tail','90','--tracks','A1,a3','--scope','inout','--threshold','auto','--json']);
  assert.deepEqual(parsed.config.settings, {threshold:-46, minPause:600, minSpeech:160, leadIn:220, tail:90});
  assert.deepEqual(parsed.config.analysisTracks, [{kind:'audio', index:0}, {kind:'audio', index:2}]);
  assert.equal(parsed.config.scope, 'inout');
  assert.equal(parsed.autoThreshold, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.yes, true);
});
test('explicit threshold and timeout',()=>{
  const parsed = parseCliArgs(['preview','--threshold','-50','--timeout','90']);
  assert.equal(parsed.config.settings.threshold, -50);
  assert.equal(parsed.timeoutMs, 90000);
});
test('invalid input is a usage error',()=>{
  for (const argv of [[], ['dance'], ['preview','--scope','all'], ['preview','--tracks','V1'], ['preview','--preset','fast'],
    ['preview','--threshold','-61'], ['preview','--threshold','loud'], ['preview','--tail','-1'], ['preview','--unknown']]) {
    assert.throws(() => parseCliArgs(argv), UsageError, argv.join(' '));
  }
});
test('cut without --yes is refused',()=>{
  assert.throws(() => parseCliArgs(['cut']), /--yes/);
});

import {main, EXIT} from '../panel/cli/open-silences.mjs';
import {BridgeUnavailable} from '../panel/cli/bridge-client.mjs';

const END = '2540160000000', SECOND = '254016000000';
function fakeHost({noSilence = false} = {}) {
  const calls = [];
  const tracks = [{kind:'audio',index:0,name:'Voice',locked:false,muted:false,transitions:0,clips:[{id:'clip',startTicks:'0',endTicks:END,sourceInTicks:'0',sourceOutTicks:END,inPointSeconds:0,outPointSeconds:10,speed:1,mediaPath:'/test.mov',projectItemId:'clip',disabled:false,linked:null}]}];
  const sequence = {ok:true,name:'Rohschnitt',identity:'doc:target',endTicks:END,fps:25,sections:{readable:true,inTicks:null,outTicks:null,selectedSections:[]},
    tracks,qeAvailable:true,fpsSupported:true,fpsObserved:true,fpsNumerator:25,fpsDenominator:1,zeroPointTicks:'0',sourceTicksReadable:true,mediaIdentityReadable:true,transitionsReadable:true,nativeTimelineAvailable:true};
  const items = {identity:'doc:target', tracks:tracks.map(t => ({kind:t.kind,index:t.index,items:[]}))};
  const client = {lastUnknown:() => null, call:async name => {
    calls.push(name);
    if (name === 'readSequence') return {ok:true, parsed:sequence, raw:'state'};
    if (name === 'readItems') return {ok:true, parsed:items, raw:'original'};
    if (name === 'prepareCut') return {ok:true, parsed:{backupId:'backup', backupItems:'protected', backupName:'Rohschnitt BACKUP'}};
    if (name === 'readItemsOfSequence') return {ok:true, parsed:{...items, identity:'doc:backup'}, raw:'protected'};
    if (name === 'renderAudio') return {ok:true, parsed:{mediaPath:'/render.wav'}};
    throw Error(`unexpected ${name}`);
  }};
  const plan = noSilence ? {intervals:[],removals:[],razorPoints:[],rejections:[],expectedDurationDeltaTicks:'0',ticksPerFrame:10160640000,frameRate:25}
    : {intervals:[{startTicks:'0',endTicks:SECOND,startFrame:0,endFrame:25}],removals:[{trackKind:'audio',trackIndex:0,startTicks:'0',endTicks:SECOND,ripple:true}],
      razorPoints:[{ticks:'0',frame:0},{ticks:SECOND,frame:25}],rejections:[],warnings:[],expectedDurationDeltaTicks:'-'+SECOND,ticksPerFrame:10160640000,frameRate:25};
  const snapshots = [];
  const engine = {renderPath:() => '/render.wav', cancel(){}, run:async (snapshot, options) => {
    snapshots.push({snapshot, options}); return {ok:true, envelope:{plan, noiseEstimate:-48.5}};
  }};
  return {client, engine, calls, snapshots};
}
function sink() { let text = ''; return {write:chunk => { text += chunk; }, text:() => text}; }
async function runCli(argv, fake) {
  const stdout = sink(), stderr = sink();
  const code = await main(argv, {stdout, stderr, client:fake?.client, engine:fake?.engine, lock:() => () => {}});
  return {code, stdout:stdout.text(), stderr:stderr.text(), json:() => JSON.parse(stdout.text())};
}

test('preview reports the cuts with the standard settings and changes nothing',async()=>{
  const fake = fakeHost();
  const out = await runCli(['preview','--json'], fake);
  assert.equal(out.code, EXIT.ok, out.stderr);
  assert.deepEqual(out.json(), {ok:true, cutCount:1, removedSeconds:1, rangeSeconds:10, noiseFloorEstimated:false,
    settings:{threshold:-46, minPause:160, minSpeech:160, leadIn:160, tail:160}});
  assert.equal(fake.calls.includes('prepareCut'), false);
  assert.equal(fake.snapshots[0].snapshot.parameters.thresholdDb, -46);
});
test('threshold auto estimates first and uses the estimate',async()=>{
  const fake = fakeHost();
  const out = await runCli(['preview','--threshold','auto','--json'], fake);
  assert.equal(out.code, EXIT.ok, out.stderr);
  assert.equal(fake.snapshots[0].options.estimate, true);
  assert.equal(fake.snapshots.at(-1).snapshot.parameters.thresholdDb, -48.5);
  assert.equal(out.json().settings.threshold, -48.5);
  assert.equal(out.json().noiseFloorEstimated, true);
});
test('cut --yes runs the full protected workflow up to apply',async()=>{
  const fake = fakeHost();
  // The fake host has no apply reply, so the run stops right at apply: proof that it got there.
  const out = await runCli(['cut','--yes','--json'], fake);
  assert.equal(out.code, EXIT.failed);
  assert.deepEqual(fake.calls.filter(c => ['prepareCut','renderAudio','apply'].includes(c)), ['prepareCut','renderAudio','renderAudio','apply']);
  assert.equal(out.json().backupName, 'Rohschnitt BACKUP');
});
test('cut with no silences succeeds without apply',async()=>{
  const fake = fakeHost({noSilence:true});
  const out = await runCli(['cut','--yes','--json'], fake);
  assert.equal(out.code, EXIT.ok, out.stderr);
  assert.deepEqual({cutCount:out.json().cutCount, backupName:out.json().backupName}, {cutCount:0, backupName:'Rohschnitt BACKUP'});
  assert.equal(fake.calls.includes('apply'), false);
});
test('cut without --yes is a usage error before any host call',async()=>{
  const fake = fakeHost();
  const out = await runCli(['cut'], fake);
  assert.equal(out.code, EXIT.usage);
  assert.deepEqual(fake.calls, []);
});
test('sequence lists the audio tracks as A1, A2',async()=>{
  const out = await runCli(['sequence','--json'], fakeHost());
  assert.equal(out.code, EXIT.ok, out.stderr);
  assert.deepEqual(out.json().audioTracks, [{track:'A1', name:'Voice', clips:1, muted:false, locked:false}]);
  assert.equal(out.json().durationSeconds, 10);
});
test('a missing bridge exits with code 3',async()=>{
  const fake = fakeHost();
  fake.client.call = async () => { throw new BridgeUnavailable('The Open Silences bridge is not running.'); };
  const out = await runCli(['sequence','--json'], fake);
  assert.equal(out.code, EXIT.bridge);
  assert.match(out.json().error, /not running/);
});
test('a missing bridge during a workflow command also exits with code 3',async()=>{
  const fake = fakeHost();
  fake.client.call = async () => { throw new BridgeUnavailable('The Open Silences bridge is not running.'); };
  const out = await runCli(['preview','--json'], fake);
  assert.equal(out.code, EXIT.bridge);
});
