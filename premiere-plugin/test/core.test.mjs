/**
 * Tests for the pure panel logic. No host and no engine are required.
 *
 * Run: node --test premiere-plugin/test/core.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TICKS_PER_SECOND,
  applyWorkflow,
  findExactItemIndex,
  hostScriptFor,
  interpretHostReply,
  fingerprintTracks,
  preflightPlan,
  addTicks,
  assessCapabilities,
  buildSnapshot,
  compareTicks,
  describeRejection,
  expectedKeptItems,
  expectedAfterNativeCuts,
  verifyNativePartitions,
  framesFromTicks,
  normalizeTicks,
  requiredBoolean,
  safetyFlagFromHost,
  subtractTicks,
  summarizePlan,
  ticksPerFrameFor,
  ticksToSeconds,
  timeRemapFlagFromComponents,
  timecodeFromFrames,
  timecodeFromTicks,
  validatePlan,
  verifyOriginalUnchanged,
  verifyReadback
} from '../panel/js/core.js';

test('tick strings stay exact beyond the safe number range', () => {
  const huge = '10000000000000001';
  assert.equal(normalizeTicks(huge), huge);
  assert.notEqual(normalizeTicks('10000000000000002'), normalizeTicks(huge));
  assert.equal(compareTicks('10000000000000002', huge), 1);
  assert.equal(addTicks(huge, '1'), '10000000000000002');
  assert.equal(subtractTicks('10000000000000002', huge), '1');
  assert.equal(normalizeTicks(1234), '1234');
  assert.equal(normalizeTicks('  42 '), '42');
  assert.throws(() => normalizeTicks('12.5'), /Ungültiger Tickwert/);
  assert.throws(() => normalizeTicks('abc'), /Ungültiger Tickwert/);
  assert.throws(() => normalizeTicks(Number.MAX_SAFE_INTEGER + 2), /sichere Zahlengrenze/);
});

test('frame arithmetic uses exact integers', () => {
  const ticksPerFrame = ticksPerFrameFor(25, 1);
  assert.equal(ticksPerFrame, 10160640000);
  assert.equal(framesFromTicks('812851200000', ticksPerFrame), 80);
  const expectedFrames = Number(BigInt('10000000000000001') / BigInt(ticksPerFrame));
  assert.equal(framesFromTicks('10000000000000001', ticksPerFrame), expectedFrames);
  assert.ok(expectedFrames > 900000, 'the long position must stay in a plausible frame range');
  assert.equal(ticksToSeconds(TICKS_PER_SECOND), 1);
  assert.throws(() => ticksPerFrameFor(0, 1), /positiv/);
  assert.throws(() => ticksPerFrameFor(25.5, 1), /ganzzahliger/);
});

test('timecode is relative, exactly as the QE razor expects it', () => {
  const ticksPerFrame = ticksPerFrameFor(25, 1);
  assert.equal(timecodeFromFrames(80, 25), '00:00:03:05');
  assert.equal(timecodeFromTicks('812851200000', ticksPerFrame, 25), '00:00:03:05');
  assert.equal(timecodeFromTicks('1219276800000', ticksPerFrame, 25), '00:00:04:20');
  assert.equal(timecodeFromFrames(0, 25), '00:00:00:00');
  assert.equal(timecodeFromFrames(25 * 3661 + 7, 25), '01:01:01:07');
});

test('drop frame rates are refused instead of guessed', () => {
  assert.equal(timecodeFromFrames(80, 30000 / 1001), null);
  assert.equal(timecodeFromFrames(80, 60000 / 1001), null);
  assert.equal(timecodeFromFrames(-1, 25), null);
  assert.equal(timecodeFromFrames(80, 0), null);
});

test('unreadable booleans abort, they never become false', () => {
  assert.equal(requiredBoolean(() => true, 'locked'), true);
  assert.equal(requiredBoolean(() => 0, 'locked'), false);
  assert.throws(() => requiredBoolean(() => undefined, 'locked'), /nicht lesbar/);
  assert.throws(() => requiredBoolean(() => null, 'locked'), /nicht lesbar/);
  assert.throws(
    () =>
      requiredBoolean(() => {
        throw new Error('EvalScript error.');
      }, 'locked'),
    /EvalScript error/
  );
  assert.throws(() => requiredBoolean(() => 'true', 'locked'), /ungültig/);
  assert.throws(() => requiredBoolean(() => 2, 'locked'), /ungültig/);
});

test('tri-state flags keep unknown unknown', () => {
  assert.equal(safetyFlagFromHost(() => true), true);
  assert.equal(safetyFlagFromHost(() => false), false);
  assert.equal(safetyFlagFromHost(() => 1), true);
  assert.equal(safetyFlagFromHost(() => 0), false);
  assert.equal(
    safetyFlagFromHost(() => {
      throw new Error('EvalScript error.');
    }),
    null
  );
  assert.equal(safetyFlagFromHost(() => undefined), null);
  assert.equal(safetyFlagFromHost(() => 'yes'), null);
});

test('time remapping can only be proven true, never false by absence', () => {
  assert.equal(timeRemapFlagFromComponents([{ displayName: 'Time Remapping' }]), true);
  assert.equal(timeRemapFlagFromComponents([{ matchName: 'ADBE Time Remapping' }]), true);
  // Absence from the public component list is not a supported reader.
  assert.equal(timeRemapFlagFromComponents([]), null);
  assert.equal(timeRemapFlagFromComponents(undefined), null);
});

const baseSequence = {
  name: 'Test',
  fpsNumerator: 25,
  fpsDenominator: 1,
  zeroPointTicks: '914457600000000',
  startTicks: '0',
  endTicks: String(12 * 254016000000)
};

function baseTracks() {
  return [
    {
      kind: 'video',
      index: 0,
      name: 'V1',
      locked: false,
      muted: false,
      role: 'other',
      clips: [
        {
          id: 'v0',
          startTicks: '0',
          endTicks: String(12 * 254016000000),
          inPointSeconds: 0,
          outPointSeconds: 12,
          speed: 1,
          reversed: false,
          timeRemap: true,
          nested: false,
          transitionIn: false,
          transitionOut: false,
          mediaPath: '/tmp/fixture.mov',
          disabled: false,
          linked: true,
          gainDb: null,
          audioEffects: null,
          channelMappingChanged: null
        }
      ]
    }
  ];
}

test('snapshot keeps exact ticks and refuses unreadable state', () => {
  const snapshot = buildSnapshot({
    sequence: baseSequence,
    tracks: baseTracks(),
    analysisTracks: [{ kind: 'audio', index: 0 }],
    parameters: { thresholdDb: -35, minPause: 0.3, minSpeech: 0.2, leadIn: 0.2, tail: 0.2 },
    channelMode: 'loudest'
  });
  assert.equal(snapshot.analysisSource, 'raw_sources');
  assert.equal(snapshot.sequence.zeroPointTicks, '914457600000000');
  assert.equal(snapshot.tracks[0].clips[0].startTicks, '0');
  assert.deepEqual(snapshot.parameters, { thresholdDb: -35, minPause: 0.3, minSpeech: 0.2, leadIn: 0.2, tail: 0.2 });

  const longSequence = buildSnapshot({
    sequence: { ...baseSequence, zeroPointTicks: '10000000000000001' },
    tracks: baseTracks(),
    analysisTracks: [{ kind: 'audio', index: 0 }],
    parameters: { thresholdDb: -35, minPause: 0.3, minSpeech: 0.2, leadIn: 0.2, tail: 0.2 },
    channelMode: 'loudest'
  });
  assert.equal(longSequence.sequence.zeroPointTicks, '10000000000000001');

  const unreadableLock = baseTracks();
  unreadableLock[0].locked = null;
  assert.throws(
    () =>
      buildSnapshot({
        sequence: baseSequence,
        tracks: unreadableLock,
        analysisTracks: [{ kind: 'audio', index: 0 }],
        parameters: { thresholdDb: -35, minPause: 0.3, minSpeech: 0.2, leadIn: 0.2, tail: 0.2 },
        channelMode: 'loudest'
      }),
    /Sperrstatus/
  );

  const unreadableDisabled = baseTracks();
  unreadableDisabled[0].clips[0].disabled = undefined;
  assert.throws(
    () =>
      buildSnapshot({
        sequence: baseSequence,
        tracks: unreadableDisabled,
        analysisTracks: [{ kind: 'audio', index: 0 }],
        parameters: { thresholdDb: -35, minPause: 0.3, minSpeech: 0.2, leadIn: 0.2, tail: 0.2 },
        channelMode: 'loudest'
      }),
    /Deaktiviert-Status/
  );
});

test('capabilities name every missing reader and block the cut', () => {
  const hostReality = {
    ok: true,
    qeAvailable: true,
    fpsSupported: true,
    sourceTicksReadable: true,
    mediaIdentityReadable: true,
    timeRemapReadable: false,
    audioStateReadable: false
  };
  const assessment = assessCapabilities(hostReality);
  assert.equal(assessment.canCut, false);
  assert.equal(assessment.readable.length, 4);
  assert.ok(assessment.blockers.some(message => message.includes('Remap')));
  assert.ok(assessment.blockers.some(message => message.includes('Kanalzuordnung')));

  const complete = { ...hostReality, timeRemapReadable: true, audioStateReadable: true };
  assert.equal(assessCapabilities(complete).canCut, true);
  assert.equal(assessCapabilities(undefined).canCut, false);
});

test('plan validation catches double ripple and duplicate razors', () => {
  const good = {
    intervals: [{ startTicks: '100', endTicks: '200' }],
    razorPoints: [{ ticks: '100' }, { ticks: '200' }],
    removals: [
      { trackKind: 'video', trackIndex: 0, startTicks: '100', endTicks: '200', ripple: true },
      { trackKind: 'audio', trackIndex: 0, startTicks: '100', endTicks: '200', ripple: false }
    ],
    expectedDurationDeltaTicks: '-100'
  };
  assert.deepEqual(validatePlan(good), []);

  const doubleRipple = JSON.parse(JSON.stringify(good));
  doubleRipple.removals[1].ripple = true;
  assert.ok(validatePlan(doubleRipple).some(message => message.includes('rippeln')));

  const duplicates = JSON.parse(JSON.stringify(good));
  duplicates.razorPoints.push({ ticks: '200' });
  assert.ok(validatePlan(duplicates).some(message => message.includes('doppelte')));

  const longer = JSON.parse(JSON.stringify(good));
  longer.expectedDurationDeltaTicks = '100';
  assert.ok(validatePlan(longer).some(message => message.includes('verlängern')));
});

const SECOND = 254016000000n;

function item(startTicks, endTicks, sourceInTicks, mediaPath = '/tmp/fixture.mov', projectItemId = 'item-1') {
  return {
    startTicks: startTicks.toString(),
    endTicks: endTicks.toString(),
    sourceInTicks: sourceInTicks.toString(),
    sourceOutTicks: (sourceInTicks + (BigInt(endTicks) - BigInt(startTicks))).toString(),
    mediaPath,
    projectItemId,
    disabled: false
  };
}

test('expected kept items are derived independently from the plan', () => {
  const tracks = [
    { kind: 'video', index: 0, items: [item(0n, 12n * SECOND, 0n)] },
    { kind: 'audio', index: 0, items: [item(0n, 12n * SECOND, 0n)] }
  ];
  const intervals = [
    { startTicks: (2n * SECOND).toString(), endTicks: (4n * SECOND).toString() },
    { startTicks: (8n * SECOND).toString(), endTicks: (9n * SECOND).toString() }
  ];
  const expected = expectedKeptItems({ tracks, intervals });
  assert.equal(expected.length, 2);
  // Timeline: [0,2] kept, [2,4] cut, [4,8] kept, [8,9] cut, [9,12] kept.
  // After the ripple the kept pieces sit at [0,2], [2,6], [6,9] and keep their
  // original source ranges [0,2], [4,8], [9,12].
  assert.deepEqual(
    expected[0].items.map(entry => [entry.startTicks, entry.endTicks, entry.sourceInTicks, entry.sourceOutTicks]),
    [
      ['0', (2n * SECOND).toString(), '0', (2n * SECOND).toString()],
      [(2n * SECOND).toString(), (6n * SECOND).toString(), (4n * SECOND).toString(), (8n * SECOND).toString()],
      [(6n * SECOND).toString(), (9n * SECOND).toString(), (9n * SECOND).toString(), (12n * SECOND).toString()]
    ]
  );
});

test('readback verification detects every wrong result', () => {
  const tracks = [
    { kind: 'video', index: 0, items: [item(0n, 12n * SECOND, 0n)] },
    { kind: 'audio', index: 0, items: [item(0n, 12n * SECOND, 0n)] }
  ];
  const intervals = [{ startTicks: (4n * SECOND).toString(), endTicks: (6n * SECOND).toString() }];
  const expected = expectedKeptItems({ tracks, intervals });
  const correct = expected.map(track => ({ ...track, items: track.items.map(entry => ({ ...entry })) }));
  assert.deepEqual(verifyReadback({ expected, actual: correct }), []);

  const changedSourceIn = JSON.parse(JSON.stringify(correct));
  changedSourceIn[0].items[1].sourceInTicks = (99n * SECOND).toString();
  assert.ok(
    verifyReadback({ expected, actual: changedSourceIn }).some(message => message.includes('Quellstart')),
    'a changed source in point must fail'
  );

  const shiftedTrack = JSON.parse(JSON.stringify(correct));
  shiftedTrack[1].items[1].endTicks = (9n * SECOND).toString();
  assert.ok(
    verifyReadback({ expected, actual: shiftedTrack }).some(
      message => message.includes('Spur A0') && message.includes('Endposition')
    ),
    'a drifting audio track must fail even when video controls the duration'
  );

  const unexpected = JSON.parse(JSON.stringify(correct));
  unexpected[0].items.push({ ...unexpected[0].items[0] });
  assert.ok(verifyReadback({ expected, actual: unexpected }).some(message => message.includes('Elemente')));

  const missing = JSON.parse(JSON.stringify(correct));
  missing[0].items.pop();
  assert.ok(verifyReadback({ expected, actual: missing }).some(message => message.includes('Elemente')));

  const wrongMedia = JSON.parse(JSON.stringify(correct));
  wrongMedia[0].items[0].mediaPath = '/tmp/other.mov';
  assert.ok(verifyReadback({ expected, actual: wrongMedia }).some(message => message.includes('anderes Medium')));

  const wrongIdentity = JSON.parse(JSON.stringify(correct));
  wrongIdentity[0].items[0].projectItemId = 'item-9';
  assert.ok(
    verifyReadback({ expected, actual: wrongIdentity }).some(message => message.includes('anderes Projektelement'))
  );

  const wrongDisabled = JSON.parse(JSON.stringify(correct));
  wrongDisabled[0].items[0].disabled = true;
  assert.ok(verifyReadback({ expected, actual: wrongDisabled }).some(message => message.includes('Deaktiviert-Status')));
});

test('original comparison and plan summary', () => {
  const before = [{ kind: 'video', index: 0, items: [item(0n, 12n * SECOND, 0n)] }];
  assert.deepEqual(verifyOriginalUnchanged(before, JSON.parse(JSON.stringify(before))), []);
  const after = JSON.parse(JSON.stringify(before));
  after[0].items[0].startTicks = '1';
  assert.ok(verifyOriginalUnchanged(before, after).some(message => message.includes('Originalsequenz')));

  const summary = summarizePlan({
    intervals: [{ startTicks: '0', endTicks: (2n * SECOND).toString() }],
    razorPoints: [{ ticks: '0' }, { ticks: (2n * SECOND).toString() }],
    rejections: [{ clipId: 'a', track: 'A0', reason: 'clip gain 3 dB' }],
    warnings: ['x']
  });
  assert.equal(summary.cutCount, 1);
  assert.equal(summary.razorCount, 2);
  assert.equal(summary.removedSeconds, 2);
  assert.ok(describeRejection({ clipId: 'a', track: 'A0', reason: 'clip gain 3 dB' }).includes('A0'));
});

test('fingerprints capture exact provenance, not names', () => {
  const tracks = [
    {
      kind: 'video',
      index: 0,
      items: [
        {
          startTicks: '0',
          endTicks: (4n * SECOND).toString(),
          sourceInTicks: '0',
          sourceOutTicks: (4n * SECOND).toString(),
          mediaPath: '/tmp/a.mov',
          projectItemId: 'item-1',
          disabled: false,
          speed: 1
        }
      ]
    }
  ];
  const first = fingerprintTracks(tracks);
  const copy = JSON.parse(JSON.stringify(tracks));
  assert.equal(fingerprintTracks(copy), first);

  copy[0].items[0].sourceInTicks = '1';
  assert.notEqual(fingerprintTracks(copy), first, 'a changed source in point must change the fingerprint');

  const other = JSON.parse(JSON.stringify(tracks));
  other[0].items[0].projectItemId = 'item-2';
  assert.notEqual(fingerprintTracks(other), first, 'a different project item must change the fingerprint');

  const disabled = JSON.parse(JSON.stringify(tracks));
  disabled[0].items[0].disabled = true;
  assert.notEqual(fingerprintTracks(disabled), first);
});

test('preflight rejects multi item spans and gaps before any mutation', () => {
  const tracks = [
    {
      kind: 'video',
      index: 0,
      items: [
        {
          startTicks: '0',
          endTicks: (2n * SECOND).toString(),
          sourceInTicks: '0',
          sourceOutTicks: (2n * SECOND).toString(),
          mediaPath: '/tmp/a.mov',
          projectItemId: 'item-1',
          disabled: false
        },
        {
          startTicks: (2n * SECOND).toString(),
          endTicks: (6n * SECOND).toString(),
          sourceInTicks: (2n * SECOND).toString(),
          sourceOutTicks: (6n * SECOND).toString(),
          mediaPath: '/tmp/b.mov',
          projectItemId: 'item-2',
          disabled: false
        }
      ]
    }
  ];
  const inside = [{ startTicks: (3n * SECOND).toString(), endTicks: (4n * SECOND).toString() }];
  assert.deepEqual(preflightPlan({ tracks, intervals: inside }), []);

  const spanning = [{ startTicks: (1n * SECOND).toString(), endTicks: (5n * SECOND).toString() }];
  assert.ok(preflightPlan({ tracks, intervals: spanning }).some(message => message.includes('mehrere Clipstücke')));

  const inGap = [
    {
      kind: 'video',
      index: 0,
      items: [
        {
          startTicks: '0',
          endTicks: (1n * SECOND).toString(),
          sourceInTicks: '0',
          sourceOutTicks: (1n * SECOND).toString(),
          mediaPath: '/tmp/a.mov',
          projectItemId: 'item-1',
          disabled: false
        },
        {
          startTicks: (2n * SECOND).toString(),
          endTicks: (3n * SECOND).toString(),
          sourceInTicks: (2n * SECOND).toString(),
          sourceOutTicks: (3n * SECOND).toString(),
          mediaPath: '/tmp/a.mov',
          projectItemId: 'item-1',
          disabled: false
        }
      ]
    }
  ];
  const gapInterval = [{ startTicks: (1n * SECOND).toString(), endTicks: (2n * SECOND).toString() }];
  assert.equal(preflightPlan({ tracks: inGap, intervals: gapInterval }).length, 0, 'a range that only covers a gap is nothing to do');

  const crossing = [{ startTicks: (1n * SECOND).toString(), endTicks: (3n * SECOND).toString() }];
  assert.ok(
    preflightPlan({ tracks: inGap, intervals: crossing }).some(message => message.includes('Lücke')),
    'a range crossing a gap must be rejected'
  );

  const afterRazor = {
    kind: 'video',
    index: 0,
    items: [
      { startTicks: '0', endTicks: (2n * SECOND).toString() },
      { startTicks: (2n * SECOND).toString(), endTicks: (4n * SECOND).toString() },
      { startTicks: (4n * SECOND).toString(), endTicks: (6n * SECOND).toString() }
    ]
  };
  assert.equal(
    findExactItemIndex(afterRazor, { startTicks: (2n * SECOND).toString(), endTicks: (4n * SECOND).toString() }),
    1
  );
  assert.equal(
    findExactItemIndex(afterRazor, { startTicks: (2n * SECOND).toString(), endTicks: (5n * SECOND).toString() }),
    -1
  );
});

test('global ripple shifts later clips even when the cut does not overlap them', () => {
  const tracks = [
    {
      kind: 'video',
      index: 0,
      items: [
        {
          startTicks: (6n * SECOND).toString(),
          endTicks: (12n * SECOND).toString(),
          sourceInTicks: (100n * SECOND).toString(),
          sourceOutTicks: (106n * SECOND).toString(),
          mediaPath: '/tmp/a.mov',
          projectItemId: 'item-1',
          disabled: false,
          speed: 1
        }
      ]
    }
  ];
  const intervals = [{ startTicks: (3n * SECOND).toString(), endTicks: (4n * SECOND).toString() }];
  const expected = expectedKeptItems({ tracks, intervals });
  assert.deepEqual(
    expected[0].items.map(entry => [
      entry.startTicks,
      entry.endTicks,
      entry.sourceInTicks,
      entry.sourceOutTicks
    ]),
    [
      [
        (5n * SECOND).toString(),
        (11n * SECOND).toString(),
        (100n * SECOND).toString(),
        (106n * SECOND).toString()
      ]
    ],
    'a preceding cut moves the whole later clip, the source range stays'
  );
});

test('a cut that begins before a clip removes only the overlapping part', () => {
  const tracks = [
    {
      kind: 'video',
      index: 0,
      items: [
        {
          startTicks: (3n * SECOND).toString(),
          endTicks: (6n * SECOND).toString(),
          sourceInTicks: (10n * SECOND).toString(),
          sourceOutTicks: (13n * SECOND).toString(),
          mediaPath: '/tmp/a.mov',
          projectItemId: 'item-1',
          disabled: false,
          speed: 1
        }
      ]
    }
  ];
  const intervals = [{ startTicks: (2n * SECOND).toString(), endTicks: (5n * SECOND).toString() }];
  const expected = expectedKeptItems({ tracks, intervals });
  assert.deepEqual(
    expected[0].items.map(entry => [
      entry.startTicks,
      entry.endTicks,
      entry.sourceInTicks,
      entry.sourceOutTicks
    ]),
    [
      [
        (2n * SECOND).toString(),
        (3n * SECOND).toString(),
        (12n * SECOND).toString(),
        (13n * SECOND).toString()
      ]
    ],
    'the surviving head keeps its source offset and shifts by the whole cut'
  );
});

test('readback rejects extra tracks and changed speed', () => {
  const tracks = [
    {
      kind: 'video',
      index: 0,
      items: [
        {
          startTicks: '0',
          endTicks: (4n * SECOND).toString(),
          sourceInTicks: '0',
          sourceOutTicks: (4n * SECOND).toString(),
          mediaPath: '/tmp/a.mov',
          projectItemId: 'item-1',
          disabled: false,
          speed: 1
        }
      ]
    }
  ];
  const expected = expectedKeptItems({ tracks, intervals: [] });
  const withExtra = JSON.parse(JSON.stringify(expected));
  withExtra.push({ kind: 'audio', index: 3, items: [] });
  assert.ok(verifyReadback({ expected, actual: withExtra }).some(message => message.includes('nicht erwartet')));

  const changedSpeed = JSON.parse(JSON.stringify(expected));
  changedSpeed[0].items[0].speed = 2;
  assert.ok(verifyReadback({ expected, actual: changedSpeed }).some(message => message.includes('Geschwindigkeit')));
});

test('a host error envelope is a failure, not a success', () => {
  assert.equal(interpretHostReply('{"ok":false,"error":"Keine aktive Sequenz."}').ok, false);
  assert.match(interpretHostReply('{"ok":false,"error":"Keine aktive Sequenz."}').error, /Keine aktive Sequenz/);
  assert.equal(interpretHostReply('{"ok":true,"tracks":[]}').ok, true);
  assert.equal(interpretHostReply('EvalScript error.').ok, false);
  assert.equal(interpretHostReply('not json').ok, false);
});

function hostMocks({ readFails = false } = {}) {
  const calls = [];
  const beforeTracks = [
    {
      kind: 'video',
      index: 0,
      items: [
        {
          startTicks: '0',
          endTicks: (12n * SECOND).toString(),
          sourceInTicks: '0',
          sourceOutTicks: (12n * SECOND).toString(),
          mediaPath: '/tmp/a.mov',
          projectItemId: 'item-1',
          disabled: false,
          speed: 1
        }
      ]
    }
  ];
  const afterTracks = [
    {
      kind: 'video',
      index: 0,
      items: [
        {
          startTicks: '0',
          endTicks: (4n * SECOND).toString(),
          sourceInTicks: '0',
          sourceOutTicks: (4n * SECOND).toString(),
          mediaPath: '/tmp/a.mov',
          projectItemId: 'item-1',
          disabled: false,
          speed: 1
        },
        {
          startTicks: (4n * SECOND).toString(),
          endTicks: (11n * SECOND).toString(),
          sourceInTicks: (5n * SECOND).toString(),
          sourceOutTicks: (12n * SECOND).toString(),
          mediaPath: '/tmp/a.mov',
          projectItemId: 'item-1',
          disabled: false,
          speed: 1
        }
      ]
    }
  ];
  // The JSX produces this shape, so the mock produces the same shape.
  const rawBefore = JSON.stringify({ ok: true, tracks: beforeTracks });
  const rawAfter = JSON.stringify({ ok: true, tracks: afterTracks });
  const rawState = JSON.stringify({ ok: true, sequenceID: 'seq-1' });
  const plan = {
    intervals: [{ startTicks: (4n * SECOND).toString(), endTicks: (5n * SECOND).toString() }],
    razorPoints: [
      { ticks: (4n * SECOND).toString(), frame: 100 },
      { ticks: (5n * SECOND).toString(), frame: 125 }
    ],
    removals: [
      {
        trackKind: 'video',
        trackIndex: 0,
        startTicks: (4n * SECOND).toString(),
        endTicks: (5n * SECOND).toString(),
        ripple: true
      }
    ],
    expectedDurationDeltaTicks: (-1n * SECOND).toString()
  };
  const analyzed = {
    identity: 'doc-1:seq-1',
    itemFingerprint: rawBefore,
    stateFingerprint: rawState
  };
  const callHost = async (name, payload) => {
    calls.push(name);
    if (name === 'readSequence') {
      return { ok: true, raw: rawState, parsed: { identity: 'doc-1:seq-1' } };
    }
    if (name === 'readItems') {
      if (readFails) {
        return { ok: false, error: 'Keine aktive Sequenz.' };
      }
      const cloned = calls.includes('clone');
      const isAfterApply = calls.includes('apply');
      const raw = isAfterApply ? rawAfter : rawBefore;
      return {
        ok: true,
        raw,
        parsed: {
          identity: cloned ? 'doc-1:seq-2' : 'doc-1:seq-1',
          tracks: isAfterApply ? afterTracks : beforeTracks
        }
      };
    }
    if (name === 'clone') {
      return {
        ok: true,
        raw: null,
        parsed: {
          cloneIdentity: 'doc-1:seq-2',
          originalId: 'seq-1',
          cloneId: 'seq-2',
          originalItems: rawBefore
        }
      };
    }
    if (name === 'apply') {
      return { ok: true, raw: null, parsed: { removed: 1, applied: 1 } };
    }
    if (name === 'readItemsOfSequence') {
      return { ok: true, raw: rawBefore, parsed: { identity: 'doc-1:seq-1', tracks: beforeTracks } };
    }
    throw new Error(`unexpected call ${name}`);
  };
  return { callHost, calls, plan, analyzed, capabilities: { canCut: true, blockers: [] } };
}

test('host scripts encode string arguments exactly once', () => {
  assert.equal(hostScriptFor('readItems'), 'OS_readItems()');
  assert.equal(hostScriptFor('readSequence'), 'OS_readSequence()');
  const identity = 'document-1:sequence-1';
  const fingerprint = '{"ok":true,"tracks":[]}';
  const cloneScript = hostScriptFor('clone', { expectedIdentity: identity, expectedItemFingerprint: fingerprint });
  // The argument must be the plain string, so a vm can evaluate it back.
  const cloneArgs = JSON.parse(`[${cloneScript.slice(cloneScript.indexOf('(') + 1, -1)}]`);
  assert.deepEqual(cloneArgs, [identity, fingerprint]);

  const sequenceId = 'sequence-1';
  const readScript = hostScriptFor('readItemsOfSequence', { sequenceId });
  const readArgs = JSON.parse(`[${readScript.slice(readScript.indexOf('(') + 1, -1)}]`);
  assert.deepEqual(readArgs, [sequenceId]);

  const payload = { plan: { intervals: [] }, expectedCloneIdentity: identity };
  const applyScript = hostScriptFor('apply', payload);
  const applyArgs = JSON.parse(`[${applyScript.slice(applyScript.indexOf('(') + 1, -1)}]`);
  assert.equal(typeof applyArgs[0], 'string', 'the apply payload is JSON text');
  assert.deepEqual(JSON.parse(applyArgs[0]), payload);
  assert.throws(() => hostScriptFor('unknown', {}), /Unbekannter Hostaufruf/);
});

test('workflow stops before cloning when the read fails', async () => {
  const mocks = hostMocks({ readFails: true });
  const result = await applyWorkflow({ ...mocks });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Keine aktive Sequenz.');
  assert.deepEqual(mocks.calls, ['readSequence', 'readItems'], 'no clone and no apply after a failed read');
});

test('workflow stops when the active sequence is not the analysed one', async () => {
  const mocks = hostMocks();
  const analyzed = { ...mocks.analyzed, identity: 'doc-1:seq-9' };
  const result = await applyWorkflow({ ...mocks, analyzed });
  assert.equal(result.ok, false);
  assert.match(result.error, /nicht die analysierte Sequenz/);
  assert.deepEqual(mocks.calls, ['readSequence', 'readItems']);
});

test('workflow stops when the original changed since the analysis', async () => {
  const mocks = hostMocks();
  const analyzed = { ...mocks.analyzed, itemFingerprint: '{"ok":true,"tracks":[]}' };
  const result = await applyWorkflow({ ...mocks, analyzed });
  assert.equal(result.ok, false);
  assert.match(result.error, /seit der Analyse geändert/);
  assert.deepEqual(mocks.calls, ['readSequence', 'readItems']);
});

test('workflow stops when the sequence state changed since the analysis', async () => {
  const mocks = hostMocks();
  const analyzed = { ...mocks.analyzed, stateFingerprint: '{"ok":true,"sequenceID":"other"}' };
  const result = await applyWorkflow({ ...mocks, analyzed });
  assert.equal(result.ok, false);
  assert.match(result.error, /Sequenz hat sich seit der Analyse/);
  assert.deepEqual(mocks.calls, ['readSequence']);
});

test('workflow refuses to cut without readable capabilities', async () => {
  const mocks = hostMocks();
  const result = await applyWorkflow({ ...mocks, capabilities: { canCut: false, blockers: ['x'] } });
  assert.equal(result.ok, false);
  assert.match(result.error, /gesperrt/);
  assert.deepEqual(mocks.calls, []);
});

test('workflow runs the verified order and verifies both sequences', async () => {
  const mocks = hostMocks();
  const result = await applyWorkflow({ ...mocks });
  assert.equal(result.ok, true, result.error || '');
  assert.deepEqual(mocks.calls, [
    'readSequence',
    'readItems',
    'clone',
    'readItems',
    'apply',
    'readItems',
    'readItemsOfSequence'
  ]);
  assert.equal(result.applied.removed, 1);
});

test('malformed host replies are failures', () => {
  for (const text of ['null', '42', '[]', '{}', '{"ok":false}', '"ok"', '']) {
    const reply = interpretHostReply(text);
    assert.equal(reply.ok, false, `${text} must not be a success`);
  }
  assert.equal(interpretHostReply('{"ok":true}').ok, true);
});

test('unreadable linkage is reported as a limit, not as silence', () => {
  const assessment = assessCapabilities({
    ok: true,
    qeAvailable: true,
    fpsSupported: true,
    fpsObserved: true,
    sourceTicksReadable: true,
    mediaIdentityReadable: true,
    linkedReadable: false,
    timeRemapReadable: false,
    audioStateReadable: false
  });
  assert.ok(assessment.warnings.some(message => message.includes('Verknüpfungsstatus')));
  assert.equal(assessment.canCut, false);
});

test('native partitions preserve speed-dependent source ranges and reject missing material', () => {
  const clip = (start, end, sourceIn, sourceOut) => ({startTicks:String(start),endTicks:String(end),sourceInTicks:String(sourceIn),sourceOutTicks:String(sourceOut),mediaPath:'/tmp/own.mov',projectItemId:'own',disabled:false,speed:2});
  const original = [{kind:'video',index:0,items:[clip(0,100,1000,1200)]}];
  const split = [{kind:'video',index:0,items:[clip(0,20,1000,1040),clip(20,40,1040,1080),clip(40,100,1080,1200)]}];
  assert.deepEqual(verifyNativePartitions(original,split),[]);
  const expected=expectedAfterNativeCuts({tracks:split,intervals:[{startTicks:'20',endTicks:'40'}]});
  assert.equal(expected[0].items[1].startTicks,'20');
  assert.equal(expected[0].items[1].endTicks,'80');
  assert.equal(expected[0].items[1].sourceInTicks,'1080');
  assert.equal(expected[0].items[1].sourceOutTicks,'1200');
  const broken=structuredClone(split);broken[0].items.splice(1,1);
  assert.ok(verifyNativePartitions(original,broken).length);
  const wrong=structuredClone(split);wrong[0].items[1].projectItemId='other';
  assert.ok(verifyNativePartitions(original,wrong).length);
  assert.throws(()=>expectedAfterNativeCuts({tracks:original,intervals:[{startTicks:'20',endTicks:'40'}]}),/überlappt/);
});
