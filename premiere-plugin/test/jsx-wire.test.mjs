/**
 * Real wire test: the ACTUAL panel/jsx/silences.jsx is loaded into a VM with an
 * app mock, and the scripts the controller emits are executed against it.
 *
 * This proves the wire contract itself: argument encoding, the readback
 * envelope, the identity rules and the fail closed guards. It needs no host.
 *
 * Run: node --test premiere-plugin/test/jsx-wire.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { hostScriptFor } from '../panel/js/core.js';

const source = readFileSync(fileURLToPath(new URL('../panel/jsx/silences.jsx', import.meta.url)), 'utf8');
const TICKS = 254016000000;

function makeClip(id, start, end, sourceIn, sourceOut, mediaPath) {
  return {
    name: id,
    start: { ticks: String(start) },
    end: { ticks: String(end) },
    inPoint: { ticks: String(sourceIn), seconds: sourceIn / TICKS },
    outPoint: { ticks: String(sourceOut), seconds: sourceOut / TICKS },
    projectItem: {
      getMediaPath: () => mediaPath,
      nodeId: id,
      isSequence: () => false
    },
    getSpeed: () => 1,
    isSpeedReversed: () => false,
    isLinked: () => 1,
    disabled: false,
    components: { numItems: 0, length: 0 }
  };
}

function makeTrack(clips) {
  const container = { numItems: clips.length };
  clips.forEach((clip, index) => {
    container[index] = clip;
  });
  return { name: 'track', clips: container, isLocked: () => false, isMuted: () => false };
}

/**
 * The adapter enumerates sequences with `numSequences` and indexed access, so
 * the mock mirrors that collection shape instead of a plain array.
 */
function createSequenceCollection() {
  const items = [];
  const collection = {
    numSequences: 0,
    add(sequence) {
      collection[items.length] = sequence;
      items.push(sequence);
      collection.numSequences = items.length;
      return sequence;
    },
    find(id) {
      return items.find(sequence => sequence.sequenceID === id);
    },
    count() {
      return items.length;
    }
  };
  return collection;
}

function makeSequence({ sequenceID, documentID, clipSpecs }) {
  // Each sequence builds its own clip objects, exactly like a native clone does
  // not share them with the original.
  const tracks = clipSpecs.map(spec =>
    makeClip(spec.id, spec.start, spec.end, spec.sourceIn, spec.sourceOut, spec.mediaPath)
  );
  const videoTrack = makeTrack(tracks);
  const sequence = {
    sequenceID,
    name: sequenceID,
    zeroPoint: '0',
    end: String(12 * TICKS),
    getSettings: () => ({ videoFrameRate: { seconds: 1 / 25 } }),
    videoTracks: { numTracks: 1, 0: videoTrack },
    audioTracks: { numTracks: 0 }
  };
  sequence.clone = () => {
    const copy = makeSequence({ sequenceID: 'copy', documentID, clipSpecs });
    project.sequences.add(copy);
    return copy;
  };
  sequence.__documentID = documentID;
  return sequence;
}

let project;
let mutations;

function createHost({ withoutJSON = false } = {}) {
  mutations = { razors: [], removes: [] };
  const clipSpecs = [
    { id: 'clip-original', start: 0, end: 12 * TICKS, sourceIn: 0, sourceOut: 12 * TICKS, mediaPath: '/tmp/original.mov' }
  ];
  const original = makeSequence({ sequenceID: 'original', documentID: 'doc', clipSpecs });

  const sequences = createSequenceCollection();
  sequences.add(original);
  project = {
    documentID: 'doc',
    activeSequence: original,
    sequences,
    openSequence: id => {
      const found = project.sequences.find(id);
      if (!found) {
        return false;
      }
      project.activeSequence = found;
      return true;
    },
    rootItem: { children: { numItems: 0 } }
  };

  const qeTrack = {
    razor: (timecode, first, second) => {
      mutations.razors.push({ timecode, first, second });
    },
    isLocked: () => false,
    isMuted: () => false,
    numTransitions: 0
  };
  const qeSequence = {
    getVideoTrackAt: () => qeTrack,
    getAudioTrackAt: () => qeTrack
  };
  const app = {
    project,
    enableQE: () => {},
    properties: {}
  };
  const qe = { project: { getActiveSequence: () => qeSequence } };

  // Item removal is tracked for the negative apply cases, also on the copy.
  const instrumentRemoval = sequence => {
    const track = sequence.videoTracks[0];
    for (let index = 0; index < track.clips.numItems; index++) {
      track.clips[index].remove = (ripple, align) => {
        mutations.removes.push({ ripple, align });
      };
    }
  };
  const originalClone = original.clone;
  original.clone = () => {
    const copy = originalClone();
    instrumentRemoval(copy);
    return copy;
  };
  instrumentRemoval(original);

  const sandbox = vm.createContext({ app, qe });
  if (withoutJSON) vm.runInContext('JSON = undefined;', sandbox);
  vm.runInContext(source, sandbox, { filename: 'silences.jsx' });
  return sandbox;
}

function evalHost(sandbox, script) {
  return JSON.parse(vm.runInContext(script, sandbox));
}

test('the emitted clone script reaches the adapter with plain arguments', () => {
  const sandbox = createHost();
  const originalEnvelope = evalHost(sandbox, hostScriptFor('readItems'));
  assert.equal(originalEnvelope.ok, true);
  assert.equal(originalEnvelope.identity, 'doc:original');
  assert.equal(originalEnvelope.sequenceID, 'original');

  const script = hostScriptFor('clone', {
    expectedIdentity: originalEnvelope.identity,
    expectedItemFingerprint: JSON.stringify(originalEnvelope)
  });
  const clone = evalHost(sandbox, script);
  assert.equal(clone.ok, true, clone.error);
  assert.equal(clone.originalIdentity, 'doc:original');
  assert.equal(clone.cloneIdentity, 'doc:copy');
  assert.equal(clone.originalId, 'original');

  // The original envelope is returned byte for byte: same helper, same shape.
  assert.equal(clone.originalItems, JSON.stringify(originalEnvelope));

  // Content equality is proved through the parsed tracks, identity must differ.
  const originalItems = JSON.parse(clone.originalItems);
  const cloneItems = JSON.parse(clone.cloneItems);
  assert.notEqual(originalItems.identity, cloneItems.identity);
  assert.deepEqual(cloneItems.tracks, originalItems.tracks);
  assert.equal(project.activeSequence.sequenceID, 'copy');
});

test('a stale original fingerprint stops the clone before it is created', () => {
  const sandbox = createHost();
  const originalEnvelope = JSON.parse(vm.runInContext('OS_readItems()', sandbox));
  const stale = JSON.stringify({ ...originalEnvelope, tracks: [] });
  const clone = evalHost(
    sandbox,
    hostScriptFor('clone', { expectedIdentity: originalEnvelope.identity, expectedItemFingerprint: stale })
  );
  assert.equal(clone.ok, false);
  assert.match(clone.error, /changed/);
  assert.equal(project.sequences.count(), 1, 'no copy was created');
  assert.deepEqual(mutations.razors, []);
  assert.deepEqual(mutations.removes, []);
});

test('apply refuses an incomplete payload and never touches the timeline', () => {
  const sandbox = createHost();
  const empty = evalHost(sandbox, hostScriptFor('apply', { plan: { intervals: [] } }));
  assert.equal(empty.ok, false);
  assert.match(empty.error, /identities and fingerprints/);

  const withPlan = evalHost(
    sandbox,
    hostScriptFor('apply', {
      plan: { intervals: [{ startTicks: '1', endTicks: '2' }], removals: [], razorPoints: [] },
      expectedOriginalId: 'original'
    })
  );
  assert.equal(withPlan.ok, false);
  assert.deepEqual(mutations.razors, []);
  assert.deepEqual(mutations.removes, []);
});

test('apply refuses when original and target are the same sequence', () => {
  const sandbox = createHost();
  const envelope = evalHost(sandbox, 'OS_readItems()');
  const clone = evalHost(
    sandbox,
    hostScriptFor('clone', {
      expectedIdentity: envelope.identity,
      expectedItemFingerprint: JSON.stringify(envelope)
    })
  );
  // Point the target back at the original while keeping the clone identity.
  project.activeSequence = project.sequences[0];
  const applied = evalHost(
    sandbox,
    hostScriptFor('apply', {
      plan: { intervals: [{ startTicks: '1', endTicks: '2' }], removals: [], razorPoints: [] },
      expectedOriginalId: 'original',
      expectedCloneIdentity: clone.cloneIdentity,
      expectedOriginalFingerprint: clone.originalItems,
      expectedCloneFingerprint: clone.cloneItems
    })
  );
  assert.equal(applied.ok, false);
  assert.match(applied.error, /not the expected copy|same sequence/);
  assert.deepEqual(mutations.razors, []);
  assert.deepEqual(mutations.removes, []);
});

test('apply refuses when the clone was changed after the clone call', () => {
  const sandbox = createHost();
  const envelope = evalHost(sandbox, 'OS_readItems()');
  const clone = evalHost(
    sandbox,
    hostScriptFor('clone', {
      expectedIdentity: envelope.identity,
      expectedItemFingerprint: JSON.stringify(envelope)
    })
  );
  const copy = project.sequences.find('copy');
  copy.end = String(6 * TICKS);
  copy.videoTracks[0].clips[0].end.ticks = String(6 * TICKS);

  const applied = evalHost(
    sandbox,
    hostScriptFor('apply', {
      plan: { intervals: [{ startTicks: '1', endTicks: '2' }], removals: [], razorPoints: [] },
      expectedOriginalId: 'original',
      expectedCloneIdentity: clone.cloneIdentity,
      expectedOriginalFingerprint: clone.originalItems,
      expectedCloneFingerprint: clone.cloneItems
    })
  );
  assert.equal(applied.ok, false);
  assert.match(applied.error, /copy has changed since it was read/);
  assert.deepEqual(mutations.razors, []);
  assert.deepEqual(mutations.removes, []);
});

test('tick comparison stays exact beyond 2^53 and linkage stays unknown', () => {
  const sandbox = createHost();
  const compare = vm.runInContext('os_compareTicks', sandbox);
  assert.equal(compare('10000000000000001', '10000000000000002'), -1);
  assert.equal(compare('10000000000000002', '10000000000000001'), 1);
  assert.equal(compare('100000000000000020000', '100000000000000019999'), 1);
  assert.equal(compare('00042', '42'), 0);
  assert.throws(() => compare('-1', '0'), /non negative decimal/);
  assert.throws(() => compare('abc', '0'), /non negative decimal/);

  // The preflight reads the same comparison from the plain clone snapshot.
  const items = [{ startTicks: '10000000000000000', endTicks: '10000000000000100' }];
  const covering = vm.runInContext('os_coveringSnapshot', sandbox);
  assert.equal(
    covering(items, { startTicks: '10000000000000020', endTicks: '10000000000000040' }).length,
    1
  );
  assert.equal(
    covering(items, { startTicks: '10000000000000200', endTicks: '10000000000000300' }).length,
    0
  );

  // A throwing disabled getter must stay unknown, not become false.
  const clip = makeClip('clip-x', 0, 10, 0, 10, '/tmp/x.mov');
  Object.defineProperty(clip, 'disabled', {
    get() {
      throw new Error('unreadable');
    }
  });
  const sequence = { sequenceID: 'seq-x', name: 'x' };
  const readItemsOf = vm.runInContext('os_readItemsOf', sandbox);
  const tracks = readItemsOf({
    ...sequence,
    videoTracks: { numTracks: 1, 0: makeTrack([clip]) },
    audioTracks: { numTracks: 0 }
  });
  assert.equal(tracks[0].items[0].disabled, null, 'an unreadable disabled state stays unknown');
  const readableClip = makeClip('clip-y', 0, 10, 0, 10, '/tmp/y.mov');
  const readableTracks = readItemsOf({
    ...sequence,
    videoTracks: { numTracks: 1, 0: makeTrack([readableClip]) },
    audioTracks: { numTracks: 0 }
  });
  assert.equal(readableTracks[0].items[0].disabled, false);
});

test('changed host state stops the cut before any razor even when positions match', () => {
 const sandbox=createHost();
 const envelope=evalHost(sandbox,'OS_readItems()');
 const copy=evalHost(sandbox,hostScriptFor('clone',{expectedIdentity:envelope.identity,expectedItemFingerprint:JSON.stringify(envelope)}));
 const reply=evalHost(sandbox,hostScriptFor('apply',{
  plan:{intervals:[{startTicks:'1',endTicks:'2'}],removals:[],razorPoints:[]},
  expectedOriginalId:'original',expectedCloneIdentity:copy.cloneIdentity,
  expectedOriginalFingerprint:copy.originalItems,expectedCloneFingerprint:copy.cloneItems,
  expectedStateFingerprint:'old state',nativeTimeline:true
 }));
 assert.equal(reply.ok,false);assert.match(reply.error,/tracks or settings/);
 assert.deepEqual(mutations.razors,[]);assert.deepEqual(mutations.removes,[]);
});

test('protected readback does not steal the active edited timeline', () => {
 const sandbox=createHost();const envelope=evalHost(sandbox,'OS_readItems()');
 const copy=evalHost(sandbox,hostScriptFor('clone',{expectedIdentity:envelope.identity,expectedItemFingerprint:JSON.stringify(envelope)}));
 const protectedItems=evalHost(sandbox,hostScriptFor('readItemsOfSequence',{sequenceId:'original'}));
 assert.equal(protectedItems.identity,'doc:original');assert.equal(project.activeSequence.sequenceID,copy.cloneId);
});


test('a fresh ExtendScript context without JSON can read the sequence and parse payloads', () => {
  const sandbox = createHost({ withoutJSON: true });
  const sequence = evalHost(sandbox, hostScriptFor('readSequence'));
  assert.equal(sequence.ok, true);
  assert.equal(sequence.identity, 'doc:original');
  const original = evalHost(sandbox, hostScriptFor('readItems'));
  assert.equal(original.ok, true);
  const clone = evalHost(sandbox, hostScriptFor('clone', {
    expectedIdentity: original.identity,
    expectedItemFingerprint: JSON.stringify(original)
  }));
  assert.equal(clone.ok, true);
  assert.equal(clone.cloneId, 'copy');
  const payload = { ticks: '900719925474099312345', name: 'Sätze: "Hallo"\nC:\\Videos', tracks: [1, null, false] };
  sandbox.payload = payload;
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(JSON.parse(JSON.stringify(payload)))', sandbox)), payload);
  assert.throws(() => vm.runInContext('JSON.parse("{broken}")', sandbox));
});


test('loading the adapter preserves existing native JSON functions', () => {
  const sandbox = createHost();
  vm.runInContext('var existingParse = JSON.parse; var existingStringify = JSON.stringify;', sandbox);
  vm.runInContext(source, sandbox);
  assert.equal(vm.runInContext('JSON.parse === existingParse && JSON.stringify === existingStringify', sandbox), true);
});

test('plan index groups removals per interval and razor tick', () => {
  const sandbox = createHost();
  sandbox.plan = {
    intervals: [{ startTicks: '10', endTicks: '20' }, { startTicks: '20', endTicks: '30' }],
    removals: [
      { trackKind: 'audio', trackIndex: 0, startTicks: '10', endTicks: '20', ripple: false },
      { trackKind: 'video', trackIndex: 0, startTicks: '10', endTicks: '20', ripple: true },
      { trackKind: 'video', trackIndex: 0, startTicks: '20', endTicks: '30', ripple: true }
    ],
    razorPoints: []
  };
  const result = JSON.parse(vm.runInContext(`(function () {
    var index = os_indexPlan(plan);
    var keys = function (object) { var list = []; for (var key in object) { if (object.hasOwnProperty(key)) list.push(key); } return list; };
    return JSON.stringify({
      first: index.tracksOf(plan.intervals[0]),
      second: index.tracksOf(plan.intervals[1]),
      missing: index.tracksOf({ startTicks: '1', endTicks: '2' }),
      at10: keys(index.tracksAt('10')),
      at20: keys(index.tracksAt('20')),
      at99: keys(index.tracksAt('99'))
    });
  })()`, sandbox));
  assert.deepEqual(result.first.map(track => track.key), ['audio0', 'video0']);
  assert.deepEqual(result.first.map(track => track.ripple), [false, true]);
  assert.deepEqual(result.second.map(track => track.key), ['video0']);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.at10, ['audio0', 'video0']);
  assert.deepEqual(result.at20, ['audio0', 'video0']);
  assert.deepEqual(result.at99, []);
});

test('item slots are read once and a stale slot falls back to a scan', () => {
  const sandbox = createHost();
  sandbox.tracks = [{ kind: 'video', index: 0, items: [{ startTicks: '0', endTicks: '10' }, { startTicks: '10', endTicks: '20' }] }];
  assert.deepEqual(
    JSON.parse(vm.runInContext('JSON.stringify(os_itemSlots(tracks))', sandbox)),
    { video0: { '0-10': 0, '10-20': 1 } }
  );
  sandbox.track = makeTrack([makeClip('a', 0, 10, 0, 10, '/a'), makeClip('b', 10, 20, 10, 20, '/b')]);
  assert.equal(vm.runInContext("os_itemAt(track, 1, {startTicks:'10', endTicks:'20'}).name", sandbox), 'b');
  assert.equal(vm.runInContext("os_itemAt(track, 0, {startTicks:'10', endTicks:'20'}).name", sandbox), 'b');
  assert.equal(vm.runInContext("os_itemAt(track, 7, {startTicks:'10', endTicks:'20'}).name", sandbox), 'b');
  assert.equal(vm.runInContext("os_itemAt(track, undefined, {startTicks:'10', endTicks:'20'}).name", sandbox), 'b');
  assert.equal(vm.runInContext("os_itemAt(track, 0, {startTicks:'5', endTicks:'6'})", sandbox), null);
});

test('shift planning moves every later item by the time removed before it', () => {
  const sandbox = createHost();
  sandbox.tracks = [
    { kind: 'video', index: 0, items: [{ startTicks: '0', endTicks: '10' }, { startTicks: '20', endTicks: '30' }, { startTicks: '40', endTicks: '50' }] },
    { kind: 'audio', index: 0, items: [{ startTicks: '0', endTicks: '10' }, { startTicks: '20', endTicks: '30' }] }
  ];
  sandbox.intervals = [
    { startTicks: '10', endTicks: '20', cumulativeRemovedTicks: '10' },
    { startTicks: '30', endTicks: '40', cumulativeRemovedTicks: '20' }
  ];
  const shifts = JSON.parse(vm.runInContext('JSON.stringify(os_planShifts(tracks, intervals))', sandbox));
  assert.deepEqual(shifts.map(s => [s.key, s.slot, s.startTicks, s.offsetTicks]).sort(), [
    ['audio0', 1, '20', '10'],
    ['video0', 1, '20', '10'],
    ['video0', 2, '40', '20']
  ]);
  assert.deepEqual(shifts.map(s => s.startTicks), ['20', '20', '40']);
  sandbox.tracks = [{ kind: 'video', index: 0, items: [{ startTicks: '20', endTicks: '30' }, { startTicks: '0', endTicks: '10' }] }];
  assert.throws(() => vm.runInContext('os_planShifts(tracks, intervals)', sandbox), /sorted by time/);
});

test('shift moves skip items a linked partner already moved and stop on a failed move', () => {
  const sandbox = createHost();
  sandbox.Time = function Time() { this.ticks = '0'; };
  const clip = (start, end) => ({
    start: { ticks: String(start) },
    end: { ticks: String(end) },
    partner: null,
    move(delta) {
      const by = Number(delta.ticks);
      for (const target of [this, this.partner]) {
        if (!target) continue;
        target.start.ticks = String(Number(target.start.ticks) + by);
        target.end.ticks = String(Number(target.end.ticks) + by);
      }
      return 0;
    }
  });
  const video = clip(20, 30);
  const audio = clip(20, 30);
  video.partner = audio;
  sandbox.sequence = {
    videoTracks: { 0: { clips: { numItems: 2, 0: clip(0, 10), 1: video } } },
    audioTracks: { 0: { clips: { numItems: 2, 0: clip(0, 10), 1: audio } } }
  };
  sandbox.shifts = [
    { key: 'video0', kind: 'video', index: 0, slot: 1, startTicks: '20', offsetTicks: '10' },
    { key: 'audio0', kind: 'audio', index: 0, slot: 1, startTicks: '20', offsetTicks: '10' }
  ];
  const result = JSON.parse(vm.runInContext('JSON.stringify(os_applyShifts(sequence, shifts))', sandbox));
  assert.deepEqual(result, { ok: true, moved: 1 });
  assert.equal(video.start.ticks, '10');
  assert.equal(audio.start.ticks, '10');

  const stuck = clip(20, 30);
  stuck.move = () => 0;
  sandbox.sequence = { videoTracks: { 0: { clips: { numItems: 1, 0: stuck } } }, audioTracks: {} };
  sandbox.shifts = [{ key: 'video0', kind: 'video', index: 0, slot: 0, startTicks: '20', offsetTicks: '10' }];
  const failed = JSON.parse(vm.runInContext('JSON.stringify(os_applyShifts(sequence, shifts))', sandbox));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /moved/);
});

/** Two clips meeting at 6 s on the active sequence, optional transition list. */
function twoClipTimeline(sandbox, transitions) {
  const track = project.activeSequence.videoTracks[0];
  const first = makeClip('first', 0, 6 * TICKS, 0, 6 * TICKS, '/tmp/a.mov');
  const second = makeClip('second', 6 * TICKS, 12 * TICKS, 0, 6 * TICKS, '/tmp/b.mov');
  track.clips = { numItems: 2, 0: first, 1: second };
  if (transitions === 'throws') {
    Object.defineProperty(track, 'transitions', { get() { throw new Error('no reader'); } });
  } else if (transitions) {
    track.transitions = transitions;
  }
  return JSON.parse(vm.runInContext('OS_readSequence()', sandbox));
}

test('only the clips whose edge lies inside a transition are flagged', () => {
  const sandbox = createHost();
  const read = twoClipTimeline(sandbox, {
    numItems: 1,
    0: { start: { ticks: String(5.5 * TICKS) }, end: { ticks: String(6.5 * TICKS) } }
  });
  assert.equal(read.ok, true, read.error);
  const track = read.tracks[0];
  assert.deepEqual(track.transitionSpans, [{ startTicks: String(5.5 * TICKS), endTicks: String(6.5 * TICKS) }]);
  assert.deepEqual(track.clips.map(clip => [clip.transitionIn, clip.transitionOut]), [[false, true], [true, false]]);
  assert.equal(read.transitionsReadable, true);
});

test('a track without a transition list relies on a QE count of zero, never on a guess', () => {
  const sandbox = createHost();
  const proven = twoClipTimeline(sandbox, 'throws');
  assert.deepEqual(proven.tracks[0].transitionSpans, []);
  assert.deepEqual(proven.tracks[0].clips.map(clip => clip.transitionIn), [false, false]);

  const unknown = createHost();
  vm.runInContext('qe.project.getActiveSequence().getVideoTrackAt(0).numTransitions = 2;', unknown);
  const read = twoClipTimeline(unknown, 'throws');
  assert.equal(read.tracks[0].transitionSpans, null);
  assert.deepEqual(read.tracks[0].clips.map(clip => clip.transitionIn), [null, null]);
  assert.equal(read.transitionsReadable, false);
});

/** A minimal host for OS_applyBatch: one video track with three clips at 25 fps. */
function batchHost({ syncLocked = false, failRemove = false } = {}) {
  const frame = TICKS / 25;
  const log = [];
  const clips = [[0, 4], [4, 6], [6, 12]].map(([start, end], index) => {
    const clip = makeClip(`c${index}`, start * TICKS, end * TICKS, 0, (end - start) * TICKS, '/tmp/c.mov');
    clip.remove = (ripple, align) => {
      if (failRemove) throw new Error('remove failed');
      log.push(['remove', clip.name, ripple, align]);
    };
    return clip;
  });
  const track = makeTrack(clips);
  const sequence = {
    sequenceID: 'seq',
    name: 'seq',
    videoDisplayFormat: 106,
    getSettings: () => ({ videoFrameRate: { seconds: 1 / 25 } }),
    videoTracks: { numTracks: 1, 0: track },
    audioTracks: { numTracks: 0 }
  };
  const qeTrack = {
    synced: syncLocked,
    isLocked: () => false,
    isSyncLocked() { return this.synced; },
    setSyncLock(value) { this.synced = value; log.push(['sync', value]); },
    razor: timecode => log.push(['razor', timecode, sequence.videoDisplayFormat])
  };
  const app = {
    project: { documentID: 'doc', activeSequence: sequence },
    enableQE: () => {}
  };
  const qe = { project: { getActiveSequence: () => ({ getVideoTrackAt: () => qeTrack, getAudioTrackAt: () => qeTrack }) } };
  function Time() { this.ticks = '0'; }
  Time.prototype.getFormatted = function (rate, format) {
    return format === 109 ? String(Number(this.ticks) / frame) : '00:00:00:00';
  };
  const sandbox = vm.createContext({ app, qe, Time });
  vm.runInContext(source, sandbox, { filename: 'silences.jsx' });
  return { sandbox, log, sequence, qeTrack };
}

const batchPayload = extra => JSON.stringify({
  expectedIdentity: 'doc:seq',
  intervals: [{ startTicks: String(4 * TICKS), endTicks: String(6 * TICKS), cut: 0 }],
  removals: [{ trackKind: 'video', trackIndex: 0, startTicks: String(4 * TICKS), endTicks: String(6 * TICKS), ripple: true }],
  ...extra
});

test('a batch cuts in frames, ripples once and restores display format and sync lock', () => {
  const { sandbox, log, sequence, qeTrack } = batchHost();
  const reply = JSON.parse(vm.runInContext(`OS_applyBatch(${JSON.stringify(batchPayload())})`, sandbox));
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual({ removed: reply.removed, applied: reply.applied, framesShown: reply.framesShown }, { removed: 1, applied: 1, framesShown: true });
  assert.deepEqual(log, [
    ['sync', true],
    ['razor', '150', 109],
    ['razor', '100', 109],
    ['remove', 'c1', true, true],
    ['sync', false]
  ]);
  assert.equal(sequence.videoDisplayFormat, 106);
  assert.equal(qeTrack.synced, false);
});

test('a batch leaves a sync lock the user had alone and restores after a failure', () => {
  const kept = batchHost({ syncLocked: true });
  assert.equal(JSON.parse(vm.runInContext(`OS_applyBatch(${JSON.stringify(batchPayload())})`, kept.sandbox)).ok, true);
  assert.equal(kept.log.some(entry => entry[0] === 'sync'), false);

  const failing = batchHost({ failRemove: true });
  const reply = JSON.parse(vm.runInContext(`OS_applyBatch(${JSON.stringify(batchPayload())})`, failing.sandbox));
  assert.equal(reply.ok, false);
  assert.match(reply.error, /remove failed/);
  assert.equal(failing.sequence.videoDisplayFormat, 106);
  assert.equal(failing.qeTrack.synced, false);
});

test('a batch for another sequence or with a stale fingerprint touches nothing', () => {
  const other = batchHost();
  const wrong = JSON.parse(vm.runInContext(`OS_applyBatch(${JSON.stringify(batchPayload({ expectedIdentity: 'doc:other' }))})`, other.sandbox));
  assert.equal(wrong.ok, false);
  const stale = JSON.parse(vm.runInContext(`OS_applyBatch(${JSON.stringify(batchPayload({ expectedItemFingerprint: 'old' }))})`, other.sandbox));
  assert.equal(stale.ok, false);
  assert.deepEqual(other.log, []);
  assert.equal(other.sequence.videoDisplayFormat, 106);
});

const PRESET_XML = [
  '<ExporterParam><ParamIdentifier>ADBEAudioRatePerSecond</ParamIdentifier><ParamType>2</ParamType><ParamValue>48000</ParamValue></ExporterParam>',
  '<ExporterParam><ParamIdentifier>ADBEAudioNumChannels</ParamIdentifier><ParamOrdinalValue>1</ParamOrdinalValue><ParamValue>2</ParamValue></ExporterParam>',
  '<ExporterParam><ParamIdentifier>ADBEAudioSampleType</ParamIdentifier><ParamValue>1</ParamValue></ExporterParam>'
].join('\n');

/** Active sequence with two audio tracks, a file system and an exporter. */
function renderHost({ refuseMono = false, rateTicks = '5292000' } = {}) {
  const files = new Map();
  const presetPath = '/Premiere.app/Contents/MediaIO/systempresets/3F3F3F3F_57415645/Waveform Audio 48kHz 16-bit.epr';
  files.set(presetPath, PRESET_XML);
  function File(path) { this.fsName = path; }
  Object.defineProperty(File.prototype, 'exists', { get() { return files.has(this.fsName); } });
  Object.defineProperty(File.prototype, 'length', { get() { return (files.get(this.fsName) || '').length; } });
  Object.defineProperty(File.prototype, 'parent', { get() { return { exists: true }; } });
  File.prototype.open = function (mode) { if (mode === 'w') files.set(this.fsName, ''); return files.has(this.fsName); };
  File.prototype.read = function () { return files.get(this.fsName); };
  File.prototype.write = function (text) { files.set(this.fsName, text); };
  File.prototype.close = () => {};
  const audioTrack = (name, muted) => ({ ...makeTrack([]), name, muted, isMuted() { return this.muted; },
    setMute(value) { this.muted = value === 1; }, isLocked: () => false });
  const sequence = {
    sequenceID: 'seq', name: 'seq',
    videoTracks: { numTracks: 0 },
    audioTracks: { numTracks: 2, 0: audioTrack('Voice', false), 1: audioTrack('Music', false) },
    getSettings: () => ({ audioSampleRate: { ticks: rateTicks } })
  };
  const exports = [];
  sequence.exportAsMediaDirect = (out, preset) => {
    exports.push({ out, preset: files.get(preset), musicMuted: sequence.audioTracks[1].muted });
    if (refuseMono && preset.includes('analysis-mono')) return false;
    files.set(out, 'RIFF'.padEnd(64, 'x'));
    return true;
  };
  const app = { path: '/Premiere.app', project: { documentID: 'doc', activeSequence: sequence } };
  const sandbox = vm.createContext({ app, qe: {}, File, Folder: { temp: { fsName: '/tmp/os' } } });
  vm.runInContext(source, sandbox, { filename: 'silences.jsx' });
  const items = vm.runInContext('OS_readItems()', sandbox);
  const payload = JSON.stringify({ expectedIdentity: 'doc:seq', expectedItemFingerprint: items,
    outputPath: '/tmp/os/timeline.wav', analysisTracks: [{ kind: 'audio', index: 0 }] });
  return { sandbox, sequence, exports, payload };
}

test('the analysis render is mono 32 bit float at the sequence rate and other tracks are muted only during the export', () => {
  const { sandbox, sequence, exports, payload } = renderHost();
  const reply = JSON.parse(vm.runInContext(`OS_renderAudio(${JSON.stringify(payload)})`, sandbox));
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.mono, true);
  assert.equal(reply.mediaPath, '/tmp/os/timeline.wav');
  assert.equal(exports.length, 1);
  assert.match(exports[0].preset, /ADBEAudioRatePerSecond<\/ParamIdentifier><ParamType>2<\/ParamType><ParamValue>48000<\/ParamValue>/);
  assert.match(exports[0].preset, /ADBEAudioNumChannels<\/ParamIdentifier><ParamOrdinalValue>1<\/ParamOrdinalValue><ParamValue>1<\/ParamValue>/);
  assert.match(exports[0].preset, /ADBEAudioSampleType<\/ParamIdentifier><ParamValue>4<\/ParamValue>/);
  assert.equal(exports[0].musicMuted, true);
  assert.equal(sequence.audioTracks[1].muted, false, 'the mute state is restored');
});

test('the analysis render keeps a 44.1 kHz sequence at its own rate', () => {
  const { sandbox, exports, payload } = renderHost({ rateTicks: '5760000' });
  const reply = JSON.parse(vm.runInContext(`OS_renderAudio(${JSON.stringify(payload)})`, sandbox));
  assert.equal(reply.ok, true, reply.error);
  assert.match(exports[0].preset, /ADBEAudioRatePerSecond<\/ParamIdentifier><ParamType>2<\/ParamType><ParamValue>44100<\/ParamValue>/);
});

test('a render with a stale state fingerprint exports and mutes nothing', () => {
  const { sandbox, sequence, exports, payload } = renderHost();
  const stale = JSON.stringify({ ...JSON.parse(payload), expectedStateFingerprint: 'stale' });
  const reply = JSON.parse(vm.runInContext(`OS_renderAudio(${JSON.stringify(stale)})`, sandbox));
  assert.equal(reply.ok, false);
  assert.equal(reply.error, 'The sequence changed before the audio export.');
  assert.equal(exports.length, 0);
  assert.equal(sequence.audioTracks[1].muted, false);
});

test('a refused mono preset falls back to the stereo preset of Premiere', () => {
  const { sandbox, exports, payload } = renderHost({ refuseMono: true });
  const reply = JSON.parse(vm.runInContext(`OS_renderAudio(${JSON.stringify(payload)})`, sandbox));
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.mono, false);
  assert.equal(reply.mediaPath, '/tmp/os/timeline-48k.wav');
  assert.equal(exports.length, 2);
  assert.match(exports[1].preset, /<ParamValue>48000<\/ParamValue>/);
});

test('preset parameters are found in either order inside their block', () => {
  const sandbox = vm.createContext({});
  vm.runInContext(source, sandbox, { filename: 'silences.jsx' });
  const swapped = '<ExporterParam><ParamValue>2</ParamValue><ParamIdentifier>ADBEAudioNumChannels</ParamIdentifier></ExporterParam>';
  assert.equal(sandbox.os_setPresetParam(swapped, 'ADBEAudioNumChannels', '1'),
    '<ExporterParam><ParamValue>1</ParamValue><ParamIdentifier>ADBEAudioNumChannels</ParamIdentifier></ExporterParam>');
  assert.equal(sandbox.os_setPresetParam(PRESET_XML, 'ADBEMissing', '1'), null);
});
