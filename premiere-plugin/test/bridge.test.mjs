import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_CALLS, PROTOCOL_VERSION, COMMAND_MAX_AGE_MS, HEARTBEAT_STALE_MS,
  commandFile, responseFile, validateCommand, isHeartbeatFresh
} from '../panel/js/bridge-protocol.js';
import {createBridgeServer} from '../panel/js/bridge.js';

const ID = '0f6c2a1e-7b7a-4c55-9a43-2f1d6c9e0a11';
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'os-bridge-'));
const command = (overrides = {}) => ({protocol:PROTOCOL_VERSION, id:ID, name:'readSequence', createdAt:1000, ...overrides});
const put = (dir, value, id = ID) => fs.writeFileSync(path.join(dir, commandFile(id)), JSON.stringify(value));
const response = (dir, id = ID) => JSON.parse(fs.readFileSync(path.join(dir, responseFile(id)), 'utf8'));

test('only the six named host calls are allowed',()=>{
  assert.deepEqual([...ALLOWED_CALLS].sort(), ['apply','prepareCut','readItems','readItemsOfSequence','readSequence','renderAudio']);
  assert.equal(validateCommand(command({name:'evalRaw'}), 1000).ok, false);
  assert.equal(validateCommand(command({name:'clone'}), 1000).ok, false);
});
test('commands need protocol, a safe id, an object payload and must be fresh',()=>{
  assert.equal(validateCommand(command(), 1000).ok, true);
  assert.equal(validateCommand(command({protocol:2}), 1000).ok, false);
  assert.equal(validateCommand(command({id:'../x'}), 1000).ok, false);
  assert.equal(validateCommand(command({payload:'text'}), 1000).ok, false);
  assert.equal(validateCommand(command(), 1000 + COMMAND_MAX_AGE_MS + 1).ok, false);
  assert.equal(validateCommand(null, 1000).ok, false);
});
test('heartbeat freshness',()=>{
  assert.equal(isHeartbeatFresh({protocol:PROTOCOL_VERSION, t:1000}, 1000 + HEARTBEAT_STALE_MS), true);
  assert.equal(isHeartbeatFresh({protocol:PROTOCOL_VERSION, t:1000}, 1001 + HEARTBEAT_STALE_MS), false);
  assert.equal(isHeartbeatFresh({protocol:9, t:1000}, 1000), false);
  assert.equal(isHeartbeatFresh(null, 1000), false);
});
test('the server evaluates exactly the script of the named call and removes the command',async()=>{
  const dir = tempDir(); const scripts = [];
  const server = createBridgeServer({fs, path, directory:dir, now:()=>1000, evalScript:async s => { scripts.push(s); return '{"ok":true}'; }});
  put(dir, command({name:'readItemsOfSequence', payload:{sequenceId:'abc'}}));
  assert.equal(await server.tick(), 1);
  assert.deepEqual(scripts, ['OS_readItemsOfSequence("abc")']);
  assert.deepEqual(response(dir), {protocol:PROTOCOL_VERSION, id:ID, ok:true, reply:'{"ok":true}', finishedAt:1000});
  assert.deepEqual(fs.readdirSync(dir).sort(), [responseFile(ID)]);
});
test('a rejected command is answered without evaluating anything',async()=>{
  const dir = tempDir(); let evaluated = 0;
  const server = createBridgeServer({fs, path, directory:dir, now:()=>1000, evalScript:async()=>{ evaluated++; return ''; }});
  put(dir, command({name:'evalRaw'}));
  await server.tick();
  assert.equal(evaluated, 0);
  assert.equal(response(dir).ok, false);
  assert.match(response(dir).error, /not allowed/);
});
test('an id that differs from the file name is rejected',async()=>{
  const dir = tempDir(); let evaluated = 0;
  const server = createBridgeServer({fs, path, directory:dir, now:()=>1000, evalScript:async()=>{ evaluated++; return ''; }});
  put(dir, command({id:'aaaaaaaa-bbbb'}));
  await server.tick();
  assert.equal(evaluated, 0);
  assert.match(response(dir).error, /file name/);
});
test('one command at a time: a second tick during evaluation does nothing',async()=>{
  const dir = tempDir(); let release;
  const server = createBridgeServer({fs, path, directory:dir, now:()=>1000, evalScript:()=>new Promise(r => { release = r; })});
  put(dir, command()); put(dir, command({id:'1f6c2a1e-7b7a-4c55-9a43-2f1d6c9e0a11'}), '1f6c2a1e-7b7a-4c55-9a43-2f1d6c9e0a11');
  const first = server.tick();
  await new Promise(r => setImmediate(r));
  assert.equal(server.isBusy(), true);
  assert.equal(await server.tick(), 0);
  release('{"ok":true}'); await first;
  assert.equal(server.isBusy(), false);
});
test('an evalScript failure becomes an error response',async()=>{
  const dir = tempDir();
  const server = createBridgeServer({fs, path, directory:dir, now:()=>1000, evalScript:async()=>{ throw Error('host gone'); }});
  put(dir, command()); await server.tick();
  assert.deepEqual({ok:response(dir).ok, error:response(dir).error}, {ok:false, error:'host gone'});
});
test('heartbeat is written atomically with protocol, time and busy flag',()=>{
  const dir = tempDir();
  createBridgeServer({fs, path, directory:dir, now:()=>4242, evalScript:async()=>''}).heartbeat();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'heartbeat.json'),'utf8')), {protocol:PROTOCOL_VERSION, t:4242, busy:false});
  assert.deepEqual(fs.readdirSync(dir), ['heartbeat.json']);
});

import {createBridgeClient, BridgeUnavailable, OutcomeUnknown, acquireLock} from '../panel/cli/bridge-client.mjs';

const beat = (dir, t = Date.now()) => fs.writeFileSync(path.join(dir,'heartbeat.json'), JSON.stringify({protocol:PROTOCOL_VERSION, t, busy:false}));

test('client and server round trip through the directory',async()=>{
  const dir = tempDir(); beat(dir);
  const server = createBridgeServer({fs, path, directory:dir, evalScript:async()=>'{"ok":true,"name":"Seq"}'});
  const client = createBridgeClient({directory:dir, pollMs:5});
  const pending = client.call('readSequence');
  while (!(await server.tick())) await new Promise(r => setTimeout(r, 5));
  const reply = await pending;
  assert.equal(reply.ok, true);
  assert.equal(reply.parsed.name, 'Seq');
  assert.equal(reply.raw, '{"ok":true,"name":"Seq"}');
  assert.deepEqual(fs.readdirSync(dir), ['heartbeat.json']);
});
test('a stale heartbeat means the bridge is not running and nothing is queued',async()=>{
  const dir = tempDir(); beat(dir, Date.now() - 60000);
  await assert.rejects(createBridgeClient({directory:dir}).call('readSequence'), BridgeUnavailable);
  assert.deepEqual(fs.readdirSync(dir), ['heartbeat.json']);
});
test('no reply within the timeout is an unknown outcome, never a retry',async()=>{
  const dir = tempDir(); beat(dir);
  const client = createBridgeClient({directory:dir, timeoutMs:30, pollMs:5});
  await assert.rejects(client.call('apply', {}), error => error instanceof OutcomeUnknown && error.call === 'apply');
  assert.equal(fs.readdirSync(dir).filter(n => n.startsWith('command-')).length, 1, 'exactly one command was written');
  assert.ok(client.lastUnknown() instanceof OutcomeUnknown);
});
test('a bridge error response becomes a failed host reply',async()=>{
  const dir = tempDir(); beat(dir);
  const server = createBridgeServer({fs, path, directory:dir, evalScript:async()=>{ throw Error('host gone'); }});
  const pending = createBridgeClient({directory:dir, pollMs:5}).call('readItems');
  while (!(await server.tick())) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(await pending, {ok:false, error:'host gone'});
});
test('the lock admits one command at a time and frees a dead owner',()=>{
  const dir = tempDir();
  const release = acquireLock(dir);
  assert.throws(() => acquireLock(dir), /Another open-silences command is running/);
  release();
  fs.writeFileSync(path.join(dir,'cli.lock'), '999999999');
  acquireLock(dir)();
});
test('a bridge that dies before claiming the call withdraws it and reports the bridge as gone',async()=>{
  const dir = tempDir(); let t = 100000; beat(dir, t);
  const client = createBridgeClient({directory:dir, pollMs:1, now:()=>t});
  const pending = client.call('apply', {});
  await new Promise(r => setTimeout(r, 5));
  t += 20000;
  await assert.rejects(pending, BridgeUnavailable);
  assert.deepEqual(fs.readdirSync(dir), ['heartbeat.json'], 'the unclaimed command is withdrawn');
});
test('a bridge that dies after claiming the call gives an unknown outcome, not a hang',async()=>{
  const dir = tempDir(); let t = 100000; beat(dir, t);
  const client = createBridgeClient({directory:dir, pollMs:1, now:()=>t});
  const pending = client.call('apply', {});
  await new Promise(r => setTimeout(r, 5));
  const name = fs.readdirSync(dir).find(n => n.startsWith('command-'));
  fs.renameSync(path.join(dir, name), path.join(dir, `${name}.claimed`));
  t += 20000;
  await new Promise(r => setTimeout(r, 5));
  t += 60000;
  await assert.rejects(pending, OutcomeUnknown);
});
