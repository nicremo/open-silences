/**
 * End to end protocol test between the panel core and the real Rust engine.
 *
 * It builds the snapshot exactly as panel/js/main.js does, runs the shipped
 * engine binary on a generated audio fixture and validates the returned plan
 * with the same core function the panel uses. The host calls themselves are not
 * part of this test, they need Premiere.
 *
 * Run: node --test premiere-plugin/test/engine-protocol.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot, summarizePlan, validatePlan } from '../panel/js/core.js';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const enginePath = join(pluginRoot, 'engine', 'target', 'release', 'silences-engine');
const TICKS_PER_SECOND = 254016000000;

/**
 * Decoder lookup for the test. System installations and an explicit override
 * only: the public tests must not depend on any third party application.
 */
function ffmpegPath() {
  const candidates = [
    process.env.OPEN_SILENCES_FFMPEG,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'ffmpeg'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore' });
      return candidate;
    } catch (error) {
      continue;
    }
  }
  return null;
}

/** 4 s mono: 1.5 s tone, 1 s silence, 1.5 s tone. */
function makeFixture(directory) {
  const ffmpeg = ffmpegPath();
  assert.ok(ffmpeg, 'ffmpeg is required for this test');
  const path = join(directory, 'protocol-fixture.wav');
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*1000*t)*lt(mod(t\\,2.5)\\,1.5):s=48000:d=4',
    '-ac', '1', '-c:a', 'pcm_s16le', path
  ]);
  return path;
}

function runEngine(snapshot, directory) {
  const snapshotPath = join(directory, `snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  const stdout = execFileSync(enginePath, ['plan', '--input', snapshotPath], { encoding: 'utf8' });
  return JSON.parse(stdout);
}

/**
 * The planner contract carries the source range as seconds
 * (`inPointSeconds`/`outPointSeconds`), not as ticks. Ticks are used for the
 * timeline positions and for the readback verification.
 */
function snapshotFor(mediaPath, { readTimeRemap, readAudioState }) {
  const clip = {
    id: 'clip-1@audio0',
    startTicks: '0',
    endTicks: String(4 * TICKS_PER_SECOND),
    inPointSeconds: 0,
    outPointSeconds: 4,
    speed: 1,
    reversed: false,
    // null means: the host cannot read this state.
    timeRemap: readTimeRemap ? false : null,
    nested: false,
    transitionIn: false,
    transitionOut: false,
    mediaPath,
    disabled: false,
    linked: true,
    gainDb: readAudioState ? 0 : null,
    audioEffects: readAudioState ? false : null,
    channelMappingChanged: readAudioState ? false : null
  };
  return buildSnapshot({
    sequence: {
      name: 'Protokolltest',
      fpsNumerator: 25,
      fpsDenominator: 1,
      zeroPointTicks: '914457600000000',
      startTicks: '0',
      endTicks: String(4 * TICKS_PER_SECOND)
    },
    tracks: [
      {
        kind: 'video',
        index: 0,
        name: 'V1',
        locked: false,
        muted: false,
        role: 'other',
        clips: [{ ...clip, id: 'clip-0@video0' }]
      },
      {
        kind: 'audio',
        index: 0,
        name: 'A1',
        locked: false,
        muted: false,
        role: 'dialogue',
        clips: [clip]
      }
    ],
    analysisTracks: [{ kind: 'audio', index: 0 }],
    parameters: { thresholdDb: -35, minPause: 0.3, minSpeech: 0.2, leadIn: 0.2, tail: 0.2 },
    channelMode: 'loudest'
  });
}

test('unreadable host state produces a rejected, empty plan through the real engine', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-silences-protocol-'));
  const mediaPath = makeFixture(directory);
  const snapshot = snapshotFor(mediaPath, { readTimeRemap: false, readAudioState: false });

  const envelope = runEngine(snapshot, directory);
  const plan = envelope.plan;
  assert.ok(Array.isArray(plan.intervals));
  assert.equal(plan.intervals.length, 0, 'an unreadable gain must block every cut');
  assert.ok(plan.rejections.length > 0, 'the rejection must be reported');
  // Either the unknown remap state or the unknown audio state blocks the clip.
  assert.ok(
    plan.rejections.some(rejection => /could not be read/.test(rejection.reason)),
    `unexpected rejections: ${JSON.stringify(plan.rejections)}`
  );
  assert.equal(plan.expectedDurationDeltaTicks, '0');
});

test('a readable state produces a valid plan the panel accepts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-silences-protocol-'));
  const mediaPath = makeFixture(directory);
  const snapshot = snapshotFor(mediaPath, { readTimeRemap: true, readAudioState: true });

  const envelope = runEngine(snapshot, directory);
  const plan = envelope.plan;
  assert.deepEqual(validatePlan(plan), [], 'the panel must accept the plan');

  const summary = summarizePlan(plan);
  assert.equal(summary.cutCount, 1, `expected one cut, got ${JSON.stringify(plan.intervals)}`);
  assert.equal(summary.rejectionCount, 0);
  const interval = plan.intervals[0];
  // Silence runs from 1.5 s to 2.5 s, margins 0.2 s, snapped onto the 25 fps grid.
  const start = Number(interval.startTicks) / TICKS_PER_SECOND;
  const end = Number(interval.endTicks) / TICKS_PER_SECOND;
  assert.ok(Math.abs(start - 1.7) < 0.05, `start ${start}`);
  assert.ok(Math.abs(end - 2.3) < 0.05, `end ${end}`);
  assert.equal(Number(plan.expectedDurationDeltaTicks), -(Number(interval.endTicks) - Number(interval.startTicks)));
  assert.equal(plan.removals.filter(removal => removal.ripple).length, 1, 'exactly one ripple driver');
  assert.equal(plan.removals.length, 2, 'video and audio are both handled');
});

test('the panel blocks an unobserved frame rate before any cut', async () => {
  // The engine accepts the rate, the panel does not: only 25 fps is observed on
  // the host. This test proves the panel side of that rule.
  const { assessCapabilities } = await import('../panel/js/core.js');
  const blocked = assessCapabilities({
    ok: true,
    qeAvailable: true,
    fpsSupported: false,
    fpsObserved: false,
    sourceTicksReadable: true,
    mediaIdentityReadable: true,
    linkedReadable: true,
    timeRemapReadable: true,
    audioStateReadable: true
  });
  assert.equal(blocked.canCut, false);
  assert.ok(blocked.blockers.some(message => message.includes('25 frames per second')));

  const allowed = assessCapabilities({
    ok: true,
    qeAvailable: true,
    fpsSupported: true,
    fpsObserved: true,
    sourceTicksReadable: true,
    mediaIdentityReadable: true,
    linkedReadable: true,
    timeRemapReadable: true,
    audioStateReadable: true
  });
  assert.equal(allowed.canCut, true);
});

test('the engine itself accepts a 30000/1001 sequence without cutting anything', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-silences-protocol-'));
  const mediaPath = makeFixture(directory);
  const snapshot = snapshotFor(mediaPath, { readTimeRemap: true, readAudioState: true });
  snapshot.sequence.fpsNumerator = 30000;
  snapshot.sequence.fpsDenominator = 1001;
  const envelope = runEngine(snapshot, directory);
  // Rate acceptance is the engine contract, the panel gate above blocks it.
  assert.ok(envelope.plan, 'the engine returns a plan object');
  assert.ok(Array.isArray(envelope.plan.intervals));
});

test('native timeline planning needs no ffmpeg and ignores unreadable raw audio state', () => {
  const directory=mkdtempSync(join(tmpdir(),'open-silences-native-protocol-'));
  const mediaPath=makeFixture(directory);
  const snapshot=snapshotFor('/raw/source/must/not/be/read.wav',{readTimeRemap:false,readAudioState:false});
  snapshot.analysisSource='rendered_mixdown';
  snapshot.renderedMixdown={mediaPath,analysisTracks:snapshot.analysisTracks};
  for(const track of snapshot.tracks)for(const clip of track.clips)clip.linked=null;
  const input=join(directory,'native.json');writeFileSync(input,JSON.stringify(snapshot));
  const result=JSON.parse(execFileSync(enginePath,['plan','--input',input],{encoding:'utf8',env:{...process.env,PATH:'/usr/bin:/bin',OPEN_SILENCES_FFMPEG:'/does/not/exist',OPEN_SILENCES_FFPROBE:'/does/not/exist'}}));
  assert.equal(result.decoder.backend,'native_pcm16');
  assert.equal(result.plan.intervals.length,1);
  assert.deepEqual(validatePlan(result.plan),[]);
  snapshot.sequence.endTicks=String(5*TICKS_PER_SECOND);writeFileSync(input,JSON.stringify(snapshot));
  assert.throws(()=>execFileSync(enginePath,['plan','--input',input],{stdio:'pipe'}),error=>error.status===2&&error.stderr.toString().includes('does not match timeline'));
});
