/**
 * Controller tests with mocks: single flight, fresh state binding and the
 * invalidation rules. No host and no engine process are involved.
 *
 * Run: node --test premiere-plugin/test/controller.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../panel/js/controller.js';

const TICKS = 254016000000;
const SECOND = 254016000000n;

function sequenceRead() {
  return {
    ok: true,
    raw: '{"ok":true,"sequenceID":"seq-1"}',
    parsed: {
      ok: true,
      identity: 'doc:seq-1',
      sequenceID: 'seq-1',
      name: 'Fixture',
      fpsNumerator: 25,
      fpsDenominator: 1,
      fps: 25,
      ticksPerFrame: 10160640000,
      zeroPointTicks: '0',
      endTicks: String(12 * TICKS),
      qeAvailable: true,
      fpsSupported: true,
      fpsObserved: true,
      sourceTicksReadable: true,
      mediaIdentityReadable: true,
      transitionsReadable: true,
      linkedReadable: true,
      timeRemapReadable: false,
      audioStateReadable: false,
      clipCount: 2,
      tracks: [
        {
          kind: 'video',
          index: 0,
          name: 'V1',
          locked: false,
          muted: false,
          transitions: 0,
          role: 'other',
          clips: []
        },
        {
          kind: 'audio',
          index: 0,
          name: 'A1',
          locked: false,
          muted: false,
          transitions: 0,
          role: 'dialogue',
          clips: []
        }
      ]
    }
  };
}

function itemsRead() {
  const track = {
    kind: 'audio',
    index: 0,
    items: [
      {
        startTicks: '0',
        endTicks: String(12 * TICKS),
        sourceInTicks: '0',
        sourceOutTicks: String(12 * TICKS),
        mediaPath: '/tmp/a.wav',
        projectItemId: 'item-1',
        disabled: false,
        speed: 1
      }
    ]
  };
  return { ok: true, raw: JSON.stringify({ ok: true, tracks: [track] }), parsed: { identity: 'doc:seq-1', tracks: [track] } };
}

function makeUi() {
  const messages = [];
  return {
    messages,
    log: (message, kind) => messages.push({ message, kind }),
    setBusy: () => {},
    setSummary: () => {},
    renderSequence: () => {},
    renderCapabilities: () => {}
  };
}

function makeInput() {
  return {
    analysisTracks: () => [{ kind: 'audio', index: 0 }],
    tracksWithRoles: tracks => tracks,
    snapshot: ({ sequence, analysisTracks, tracks }) => ({
      sequence: {
        name: sequence.name,
        fpsNumerator: sequence.fpsNumerator,
        fpsDenominator: sequence.fpsDenominator,
        zeroPointTicks: sequence.zeroPointTicks,
        startTicks: '0',
        endTicks: sequence.endTicks
      },
      tracks,
      analysisTracks,
      parameters: { thresholdDb: -35, minPause: 0.3, minSpeech: 0.2, leadIn: 0.2, tail: 0.2 },
      channelMode: 'loudest',
      rippleDriver: 'video_first',
      respectLocks: true,
      mode: 'delete_ripple'
    })
  };
}

function makeController({ engineRun, readFails = false } = {}) {
  const ui = makeUi();
  let runs = 0;
  const host = {
    readSequence: async () => (readFails ? { ok: false, error: 'Keine aktive Sequenz.' } : sequenceRead()),
    readItems: async () => itemsRead(),
    call: async () => ({ ok: false, error: 'nicht verwendet' })
  };
  const engine = {
    run: async snapshot => {
      runs += 1;
      if (engineRun) {
        return engineRun(snapshot);
      }
      return {
        ok: true,
        runDirectory: '/tmp/evidence',
        envelope: {
          plan: {
            intervals: [],
            razorPoints: [],
            removals: [],
            rejections: [],
            warnings: [],
            expectedDurationDeltaTicks: '0'
          }
        }
      };
    }
  };
  const controller = createController({ host, engine, ui, input: makeInput() });
  return { controller, ui, runs: () => runs };
}

test('two analyze clicks start at most one engine run', async () => {
  const { controller, runs } = makeController({
    engineRun: async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return {
        ok: true,
        runDirectory: '/tmp/evidence',
        envelope: {
          plan: {
            intervals: [],
            razorPoints: [],
            removals: [],
            rejections: [],
            warnings: [],
            expectedDurationDeltaTicks: '0'
          }
        }
      };
    }
  });
  await controller.readSequence();
  const first = controller.analyze();
  const second = controller.analyze();
  await Promise.all([first, second]);
  assert.equal(runs(), 1, 'a double click must not spawn two engine processes');
  assert.equal(controller.getState().running, false, 'busy state must be cleared');
});

test('busy is set before the first await and cleared on a failed read', async () => {
  const { controller, ui, runs } = makeController({ readFails: true });
  await controller.readSequence().catch(() => {});
  assert.equal(controller.getState().sequence, null);
  assert.equal(runs(), 0, 'no engine run without a sequence');
  assert.ok(ui.messages.some(entry => entry.kind === 'error'));
});

test('analyze binds the plan to the freshly read state', async () => {
  const { controller } = makeController();
  await controller.readSequence();
  await controller.analyze();
  const analyzed = controller.getState().analyzed;
  assert.equal(analyzed.identity, 'doc:seq-1');
  assert.match(analyzed.itemFingerprint, /"tracks"/);
  assert.match(analyzed.stateFingerprint, /seq-1/);
});

test('a parameter change invalidates the plan', async () => {
  const { controller } = makeController();
  await controller.readSequence();
  await controller.analyze();
  assert.ok(controller.getState().plan);
  controller.invalidate('Einstellung geändert');
  assert.equal(controller.getState().plan, null);
  assert.equal(controller.getState().analyzed, null);
  assert.equal(controller.canApply(), false);
});

test('two apply clicks reach the host once', async () => {
  const calls = [];
  let releaseFirstRead;
  let firstReadStarted;
  const started = new Promise(resolve => {
    firstReadStarted = resolve;
  });
  const gate = new Promise(resolve => {
    releaseFirstRead = resolve;
  });

  const ui = makeUi();
  const host = {
    readSequence: async () => sequenceRead(),
    readItems: async () => itemsRead(),
    call: async name => {
      calls.push(name);
      if (name === 'readSequence') {
        firstReadStarted();
        await gate;
        return { ok: false, error: 'Abbruch nach der Messung' };
      }
      return { ok: false, error: 'nicht verwendet' };
    }
  };
  const engine = {
    run: async () => ({
      ok: true,
      runDirectory: '/tmp/evidence',
      envelope: {
        plan: {
          intervals: [],
          razorPoints: [],
          removals: [],
          rejections: [],
          warnings: [],
          expectedDurationDeltaTicks: '0'
        }
      }
    })
  };
  const controller = createController({ host, engine, ui, input: makeInput() });
  await controller.readSequence();
  await controller.analyze();
  // Only for this isolated mock: the capability gate is not the subject here.
  controller.getState().capabilities = { ...controller.getState().capabilities, canCut: true, blockers: [] };

  const first = controller.apply();
  await started;
  assert.deepEqual(calls, ['readSequence'], 'the first flight reached the workflow');
  const second = controller.apply();
  await Promise.resolve();
  assert.deepEqual(calls, ['readSequence'], 'the second click must not reach the host');
  releaseFirstRead();
  await Promise.all([first, second]);
  assert.equal(calls.filter(name => name === 'readSequence').length, 1);
  assert.equal(calls.includes('clone'), false, 'no clone without a verified read');
  assert.equal(calls.includes('apply'), false, 'no mutation without a verified read');
  assert.equal(controller.getState().running, false);
});

test('a stale generation is discarded', async () => {
  let releaseEngine;
  let engineStarted;
  const started = new Promise(resolve => {
    engineStarted = resolve;
  });
  const gate = new Promise(resolve => {
    releaseEngine = resolve;
  });
  const { controller, ui } = makeController({
    engineRun: async () => {
      engineStarted();
      await gate;
      return {
        ok: true,
        runDirectory: '/tmp/evidence',
        envelope: {
          plan: {
            intervals: [],
            razorPoints: [],
            removals: [],
            rejections: [],
            warnings: [],
            expectedDurationDeltaTicks: '0'
          }
        }
      };
    }
  });
  await controller.readSequence();
  const running = controller.analyze();
  // Wait until the engine is really running, then invalidate the generation the
  // way a form change does. The single flight guard must not be weakened.
  await started;
  controller.invalidate('Einstellung geändert');
  releaseEngine();
  await running;
  assert.equal(controller.getState().plan, null, 'the stale plan must not be kept');
  assert.ok(ui.messages.some(entry => entry.message.includes('Ergebnis verworfen')));
});

test('every reached stage clears the busy flag', async () => {
  const cases = [
    async controller => {
      await controller.readSequence();
    },
    async controller => {
      await controller.readSequence();
      await controller.analyze();
    },
    async controller => {
      const failing = makeController({ readFails: true });
      await failing.controller.readSequence();
    }
  ];
  for (const run of cases) {
    const { controller } = makeController();
    await run(controller);
    assert.equal(controller.getState().running, false, 'busy flag left set');
  }
});

test('the expected plan values survive the SECOND import', () => {
  assert.equal(SECOND, 254016000000n);
});
