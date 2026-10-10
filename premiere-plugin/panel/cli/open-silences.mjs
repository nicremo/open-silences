#!/usr/bin/env node
/**
 * open-silences: the panel workflow for agents and terminals.
 *
 * Talks to the invisible bridge extension inside Premiere and runs the same
 * createWorkflow as the panel, with --yes in place of the confirm click.
 */
import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {createWorkflow, seconds} from '../js/workflow.js';
import {isHeartbeatFresh} from '../js/bridge-protocol.js';
import {parseCliArgs, UsageError, USAGE} from './args.mjs';
import {createBridgeClient, BridgeUnavailable, OutcomeUnknown, acquireLock, readHeartbeat, defaultBridgeDirectory} from './bridge-client.mjs';
import {createEngineRunner, resolveEnginePath} from './engine-runner.mjs';

export const EXIT = Object.freeze({ok:0, failed:1, usage:2, bridge:3, unknown:4});

export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const directory = deps.directory ?? defaultBridgeDirectory();
  const now = deps.now ?? (() => Date.now());
  let options;
  try { options = parseCliArgs(argv); }
  catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr.write(`${error.message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (options.command === 'help') { stdout.write(USAGE); return EXIT.ok; }

  const report = (result, lines) => {
    stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${lines.join('\n')}\n`);
  };
  const progress = text => { if (text) stderr.write(`${text}\n`); };

  if (options.command === 'status') {
    const heartbeat = readHeartbeat(directory);
    let engine = null;
    try { engine = resolveEnginePath({flag:options.engine}); } catch (_) {}
    const running = isHeartbeatFresh(heartbeat, now());
    const result = {ok:running && Boolean(engine), bridge:running ? 'running' : 'not running',
      heartbeatAgeMs:heartbeat ? now() - heartbeat.t : null, busy:Boolean(heartbeat?.busy), engine};
    report(result, [`Bridge: ${result.bridge}`, `Engine: ${engine ?? 'not found'}`]);
    return result.ok ? EXIT.ok : running ? EXIT.failed : EXIT.bridge;
  }

  const client = deps.client ?? createBridgeClient({directory, timeoutMs:options.timeoutMs});
  // The workflow turns thrown errors into messages; the last transport error
  // keeps its type so the exit code can tell a missing bridge from a failure.
  let transportError = null;
  const host = async (name, payload) => {
    try { return await client.call(name, payload); }
    catch (error) { transportError = error; throw error; }
  };
  const fail = (error, extra = {}) => {
    const cause = transportError ?? error;
    const unknown = cause instanceof OutcomeUnknown ? cause : client.lastUnknown?.();
    const result = {ok:false, error:error.message, ...extra, ...(unknown ? {requestId:unknown.requestId} : {})};
    report(result, [`Error: ${result.error}`]);
    if (cause instanceof BridgeUnavailable) return EXIT.bridge;
    return unknown ? EXIT.unknown : EXIT.failed;
  };

  if (options.command === 'sequence') {
    try {
      const reply = await host('readSequence');
      if (!reply.ok) throw Error(reply.error);
      const s = reply.parsed;
      const audioTracks = s.tracks.filter(track => track.kind === 'audio').map(track => ({
        track:`A${track.index + 1}`, name:track.name, clips:track.clips.length, muted:track.muted, locked:track.locked
      }));
      const result = {ok:true, name:s.name, identity:s.identity, durationSeconds:seconds(s.endTicks), fps:s.fps, audioTracks};
      report(result, [`${s.name} · ${result.durationSeconds.toFixed(2)} s · ${s.fps} fps`,
        ...audioTracks.map(t => `${t.track} ${t.name}: ${t.clips} clips${t.muted ? ', muted' : ''}${t.locked ? ', locked' : ''}`)]);
      return EXIT.ok;
    } catch (error) { return fail(error); }
  }

  let release = () => {};
  try { release = (deps.lock ?? acquireLock)(directory); }
  catch (error) { return fail(error); }
  let engine;
  try { engine = deps.engine ?? createEngineRunner({enginePath:resolveEnginePath({flag:options.engine})}); }
  catch (error) { release(); return fail(error); }

  let lastError = null, backupName = null;
  const ui = {
    busy:(running, text) => { if (running) progress(text); },
    backup:name => { backupName = name; progress(`Backup: ${name}`); },
    error:message => { lastError = message; },
    estimate:() => {},
    confirm:async () => options.yes,
    complete:() => {}
  };
  const workflow = createWorkflow({host, engine, ui});
  const onSignal = () => { progress('Cancel requested. A running Premiere step finishes first.'); workflow.cancel(); };
  process.once('SIGINT', onSignal);
  try {
    await workflow.refresh();
    const config = structuredClone(options.config);
    let noiseFloorEstimated = false;
    if (options.command === 'estimate' || options.autoThreshold) {
      const estimated = await workflow.run(config, 'estimate');
      if (!estimated?.ok) throw Error(lastError ?? 'The noise floor could not be estimated.');
      if (options.command === 'estimate') {
        report({ok:true, noiseFloorDb:estimated.noiseEstimate}, [`Noise floor: ${estimated.noiseEstimate} dB`]);
        return EXIT.ok;
      }
      config.settings.threshold = estimated.noiseEstimate;
      noiseFloorEstimated = true;
    }
    if (options.command === 'preview') {
      const result = await workflow.run(config, 'preview');
      if (!result?.ok) throw Error(lastError ?? 'The preview failed.');
      const out = {ok:true, ...result.preview, settings:config.settings, noiseFloorEstimated};
      report(out, [`${out.cutCount} cuts, ${out.removedSeconds.toFixed(2)} s of ${out.rangeSeconds.toFixed(2)} s would be removed.`]);
      return EXIT.ok;
    }
    const result = await workflow.run(config, 'full');
    if (!result?.ok) return fail(Error(lastError ?? 'The cut failed.'), backupName ? {backupName} : {});
    const summary = result.summary ?? {cutCount:0, removedSeconds:0};
    const out = {ok:true, cutCount:summary.cutCount, removedSeconds:summary.removedSeconds, backupName:result.backup.backupName,
      settings:config.settings, noiseFloorEstimated};
    report(out, [`${out.cutCount} cuts, ${out.removedSeconds.toFixed(2)} s removed.`, `Backup: ${out.backupName}`]);
    return EXIT.ok;
  } catch (error) {
    return fail(error, backupName ? {backupName} : {});
  } finally {
    process.removeListener('SIGINT', onSignal);
    release();
  }
}

// Run only when executed directly, also through a symlink such as ~/.local/bin/open-silences.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
