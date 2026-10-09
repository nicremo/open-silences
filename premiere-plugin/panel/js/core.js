/**
 * Pure panel logic: exact tick strings, frame arithmetic, capability reporting,
 * snapshot creation and full readback verification.
 *
 * Host facts this file depends on (verified on Premiere Pro 26.5.2, 25 fps,
 * sequence zero point 01:00:00:00):
 * * QE `razor` expects a timecode RELATIVE to the sequence start. Adding the
 *   display offset makes the call a silent no-op.
 * * `razor(timecode, true, true)` also cuts the linked audio of that boundary,
 *   so boundaries are deduplicated.
 * * `isTimeRemapped` does not exist on the public clip or on the QE clip, and
 *   there is no readable source channel getter. Those states therefore stay
 *   UNKNOWN and general cutting stays unavailable. A user confirmation may
 *   explain a limitation, it never turns an unknown state into a verified one.
 *
 * Tick values are decimal strings and are never routed through `Number` unless
 * the value is a frame count or a display approximation.
 */

export const TICKS_PER_SECOND = 254016000000n;
export const TICKS_PER_SECOND_NUMBER = 254016000000;

/** Safety state of an unreadable or unverifiable host property. */
export const UNKNOWN = null;

/** Premiere frame rates that need drop frame timecode, which is not supported. */
const DROP_FRAME_FPS = [29.97, 30000 / 1001, 59.94, 60000 / 1001];

/**
 * Frame rates actually observed on the host. Only 25 fps was measured on
 * Premiere Pro 26.5.2, every other rate stays unproven and blocks a cut.
 */
export const OBSERVED_FRAME_RATES = [25];

/* ------------------------------------------------------------ tick algebra */

const TICK_PATTERN = /^-?\d+$/;

/**
 * Canonical decimal tick string. Numbers are accepted only while they are safe
 * integers, everything else must arrive as a string so no precision is lost.
 */
export function normalizeTicks(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!TICK_PATTERN.test(trimmed)) {
      throw new Error(`Ungültiger Tickwert: ${value}`);
    }
    return BigInt(trimmed).toString();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`Ungültiger Tickwert: ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `Tickwert ${value} überschreitet die sichere Zahlengrenze, bitte als Zeichenkette übergeben.`
      );
    }
    return BigInt(value).toString();
  }
  throw new Error(`Ungültiger Tickwert: ${String(value)}`);
}

export function toBigIntTicks(value) {
  return BigInt(normalizeTicks(value));
}

export function compareTicks(first, second) {
  const a = toBigIntTicks(first);
  const b = toBigIntTicks(second);
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export function addTicks(first, second) {
  return (toBigIntTicks(first) + toBigIntTicks(second)).toString();
}

export function subtractTicks(first, second) {
  return (toBigIntTicks(first) - toBigIntTicks(second)).toString();
}

/** Display only: seconds as a bounded number. */
export function ticksToSeconds(ticks) {
  return Number(toBigIntTicks(ticks)) / TICKS_PER_SECOND_NUMBER;
}

/* --------------------------------------------------------------- frame grid */

export function ticksPerFrameFor(fpsNumerator, fpsDenominator) {
  if (!Number.isInteger(fpsNumerator) || !Number.isInteger(fpsDenominator)) {
    throw new Error('Die Bildrate muss als ganzzahliger Zähler und Nenner vorliegen.');
  }
  if (fpsNumerator <= 0 || fpsDenominator <= 0) {
    throw new Error('Die Bildrate muss positiv sein.');
  }
  const ticks = (TICKS_PER_SECOND * BigInt(fpsDenominator) + BigInt(Math.floor(fpsNumerator / 2))) / BigInt(fpsNumerator);
  if (ticks <= 0n || ticks > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Die Bildrate ergibt eine ungültige Tickgröße.');
  }
  return Number(ticks);
}

export function frameRateFor(fpsNumerator, fpsDenominator) {
  return fpsNumerator / fpsDenominator;
}

/**
 * Frame index of a tick value. Frame counts stay far below the safe integer
 * range for realistic durations, so a bounded number is returned.
 */
export function framesFromTicks(ticks, ticksPerFrame) {
  if (!Number.isInteger(ticksPerFrame) || ticksPerFrame <= 0) {
    throw new Error('Ungültige Tickgröße je Bild.');
  }
  const frames = toBigIntTicks(ticks) / BigInt(ticksPerFrame);
  if (frames > BigInt(Number.MAX_SAFE_INTEGER) || frames < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Bildanzahl außerhalb des sicheren Bereichs.');
  }
  return Number(frames);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * Builds the relative QE timecode `HH:MM:SS:FF`.
 *
 * Drop frame rates return null: they are not proven on the host and must abort
 * conservatively instead of cutting at a guessed position.
 */
export function timecodeFromFrames(frames, frameRate) {
  if (!Number.isFinite(frames) || frames < 0 || !Number.isFinite(frameRate) || frameRate <= 0) {
    return null;
  }
  if (DROP_FRAME_FPS.some(candidate => Math.abs(candidate - frameRate) < 1e-6)) {
    return null;
  }
  const fps = Math.round(frameRate);
  if (fps <= 0 || Math.abs(fps - frameRate) > 1e-6) {
    return null;
  }
  const totalSeconds = Math.floor(frames / fps);
  const frame = frames - totalSeconds * fps;
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(
    totalSeconds % 60
  )}:${pad(frame)}`;
}

/** Timecode for an internal tick value. The sequence zero point is never added. */
export function timecodeFromTicks(ticks, ticksPerFrame, frameRate) {
  return timecodeFromFrames(framesFromTicks(ticks, ticksPerFrame), frameRate);
}

/* --------------------------------------------------------- host value rules */

function normalizeBoolean(value) {
  if (value === true || value === false) {
    return value;
  }
  if (value === 1) {
    return true;
  }
  if (value === 0) {
    return false;
  }
  return undefined;
}

/**
 * Strict boolean for schema fields that require `true` or `false`.
 * A missing, thrown or nonsensical value is an error, never `false`.
 */
export function requiredBoolean(read, field) {
  let value;
  try {
    value = read();
  } catch (error) {
    throw new Error(`${field} ist nicht lesbar: ${error}`);
  }
  const normalized = normalizeBoolean(value);
  if (normalized === undefined) {
    throw new Error(`${field} ist nicht lesbar oder ungültig (${String(value)}).`);
  }
  return normalized;
}

/**
 * Tri-state flag. `true`/`false` and the documented `1`/`0` are accepted,
 * everything else including a missing getter stays UNKNOWN.
 */
export function safetyFlagFromHost(read) {
  let value;
  try {
    value = read();
  } catch (error) {
    return UNKNOWN;
  }
  const normalized = normalizeBoolean(value);
  return normalized === undefined ? UNKNOWN : normalized;
}

/**
 * Time remapping has no getter on either reader. Finding a remap component is
 * evidence for "yes"; not finding one is NOT evidence for "no", because the
 * component list itself is not a documented remap reader. Therefore the result
 * is either true or UNKNOWN.
 */
export function timeRemapFlagFromComponents(components) {
  if (!Array.isArray(components)) {
    return UNKNOWN;
  }
  const match = components.some(component => {
    const name = `${component.displayName || ''} ${component.matchName || ''}`.toLowerCase();
    return name.includes('remap');
  });
  return match ? true : UNKNOWN;
}

/* --------------------------------------------------------------- snapshot */

/**
 * Builds the snapshot the engine consumes.
 *
 * Hard rules:
 * * `locked`, `muted`, `disabled` and `linked` must be readable booleans,
 *   otherwise no snapshot is produced at all,
 * * tri-state fields stay UNKNOWN when the host cannot read them,
 * * tick values keep their exact decimal representation.
 */
export function buildSnapshot({
  sequence,
  tracks,
  analysisTracks,
  parameters,
  channelMode,
  rippleDriver = 'video_first',
  respectLocks = true,
  mode = 'delete_ripple',
  renderedMixdown = null,
  selectedSections = null
}) {
  if (!sequence || !Number.isInteger(sequence.fpsNumerator) || !Number.isInteger(sequence.fpsDenominator)) {
    throw new Error('Die Bildrate der Sequenz fehlt.');
  }
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error('Der Schnappschuss enthält keine Spuren.');
  }
  if (!Array.isArray(analysisTracks) || analysisTracks.length === 0) {
    throw new Error('Es ist keine Analysespur gewählt.');
  }
  return {
    ...(selectedSections ? { selectedSections } : {}),
    analysisSource: renderedMixdown ? 'rendered_mixdown' : 'raw_sources',
    ...(renderedMixdown ? { renderedMixdown } : {}),
    sequence: {
      name: sequence.name || 'unnamed',
      fpsNumerator: sequence.fpsNumerator,
      fpsDenominator: sequence.fpsDenominator,
      zeroPointTicks: normalizeTicks(sequence.zeroPointTicks),
      startTicks: normalizeTicks(sequence.startTicks),
      endTicks: normalizeTicks(sequence.endTicks)
    },
    tracks: tracks.map(track => {
      const kind = track.kind === 'video' || track.kind === 'audio' ? track.kind : null;
      if (!kind) {
        throw new Error(`Unbekannte Spurenart: ${String(track.kind)}`);
      }
      if (!Number.isInteger(track.index)) {
        throw new Error('Spurindex fehlt.');
      }
      const locked = normalizeBoolean(track.locked);
      const muted = normalizeBoolean(track.muted);
      if (locked === undefined) {
        throw new Error(`Sperrstatus von ${kind}${track.index} ist nicht lesbar.`);
      }
      if (muted === undefined) {
        throw new Error(`Stummschaltung von ${kind}${track.index} ist nicht lesbar.`);
      }
      return {
        kind,
        index: track.index,
        name: track.name || `${kind}${track.index}`,
        locked,
        muted,
        role: ['dialogue', 'music', 'other'].includes(track.role) ? track.role : 'other',
        clips: track.clips.map(clip => {
          const disabled = normalizeBoolean(clip.disabled);
          const linked = normalizeBoolean(clip.linked);
          if (disabled === undefined) {
            throw new Error(`Deaktiviert-Status von ${clip.id} ist nicht lesbar.`);
          }
          if (linked === undefined && !renderedMixdown) {
            throw new Error(`Verknüpfungsstatus von ${clip.id} ist nicht lesbar.`);
          }
          if (clip.mediaPath !== null && typeof clip.mediaPath !== 'string') {
            throw new Error(`Medienpfad von ${clip.id} ist ungültig.`);
          }
          return {
            id: clip.id,
            startTicks: normalizeTicks(clip.startTicks),
            endTicks: normalizeTicks(clip.endTicks),
            inPointSeconds: clip.inPointSeconds,
            outPointSeconds: clip.outPointSeconds,
            speed: clip.speed,
            reversed: clip.reversed === undefined ? UNKNOWN : clip.reversed,
            timeRemap: clip.timeRemap === undefined ? UNKNOWN : clip.timeRemap,
            nested: clip.nested === undefined ? UNKNOWN : clip.nested,
            transitionIn: clip.transitionIn === undefined ? UNKNOWN : clip.transitionIn,
            transitionOut: clip.transitionOut === undefined ? UNKNOWN : clip.transitionOut,
            mediaPath: clip.mediaPath,
            disabled,
            linked: linked === undefined ? null : linked,
            gainDb: clip.gainDb === undefined ? UNKNOWN : clip.gainDb,
            audioEffects: clip.audioEffects === undefined ? UNKNOWN : clip.audioEffects,
            channelMappingChanged:
              clip.channelMappingChanged === undefined ? UNKNOWN : clip.channelMappingChanged
          };
        })
      };
    }),
    analysisTracks,
    parameters: {
      thresholdDb: parameters.thresholdDb,
      minPause: parameters.minPause,
      minSpeech: parameters.minSpeech,
      leadIn: parameters.leadIn,
      tail: parameters.tail
    },
    channelMode,
    mode,
    rippleDriver,
    respectLocks
  };
}

/* ----------------------------------------------------------- capabilities */

/**
 * Reports which host values a general cut would need and which of them cannot
 * be read. Cutting is only offered when every required state is readable.
 *
 * A user statement about the raw material explains a limitation, it is not a
 * reader and therefore never clears an unknown state.
 */
export function assessCapabilities(sequence) {
  const readable = [];
  const blockers = [];
  const warnings = [];
  if (!sequence || sequence.ok !== true) {
    return { readable, blockers: ['Die Sequenz konnte nicht gelesen werden.'], warnings, canCut: false };
  }
  if (sequence.qeAvailable === true) {
    readable.push('QE Zugriff für den Schnitt');
  } else {
    blockers.push('QE Zugriff für den Schnitt ist nicht bestätigt.');
  }
  if (sequence.fpsSupported === true) {
    readable.push(`Bildrate ${sequence.fps ?? sequence.fpsNumerator / sequence.fpsDenominator}`);
  } else if (sequence.fpsObserved === false) {
    blockers.push('Nur 25 Bilder pro Sekunde ist auf diesem Host belegt. Diese Rate ist es nicht.');
  } else {
    blockers.push('Diese Bildrate ist nicht belegt (Drop Frame oder ungewöhnliche Rate).');
  }
  if (sequence.sourceTicksReadable === true) {
    readable.push('Quellbereich in Ticks');
  } else {
    blockers.push('Der Quellbereich der Clips ist nicht in Ticks lesbar.');
  }
  if (sequence.mediaIdentityReadable === true) {
    readable.push('Medienzuordnung der Clips');
  } else {
    blockers.push('Die Medienzuordnung der Clips ist nicht lesbar.');
  }
  if (sequence.nativeTimelineAvailable === true) {
    readable.push('Nativer Audioexport der Timeline und nativer Schnitt auf einer Kopie');
  } else if (sequence.timeRemapReadable === true) {
    readable.push('Zeitlupen- oder Remap-Status');
  } else {
    blockers.push('Der Zeitlupen- oder Remap-Status ist im Host nicht lesbar.');
  }
  if (sequence.nativeTimelineAvailable === true) {
    readable.push('Lautstärke, Effekte und Kanalzuordnung im gerenderten Audio');
  } else if (sequence.audioStateReadable === true) {
    readable.push('Lautstärke, Effekte und Kanalzuordnung');
  } else {
    blockers.push(
      'Lautstärke, Audioeffekte und Kanalzuordnung der Clips sind im Host nicht lesbar. ' +
        'Ohne gerenderte Mischung ist eine Rohquellenanalyse dafür keine Grundlage.'
    );
  }
  if (sequence.nativeTimelineAvailable === true) {
    readable.push('Schnitt aller betroffenen Spuren mit vollständiger Nachprüfung');
  } else if (sequence.linkedReadable === true) {
    readable.push('Verknüpfungsstatus der Clips');
  } else {
    warnings.push(
      'Der Verknüpfungsstatus einzelner Clips ist nicht lesbar. Der Probelauf kann deshalb abbrechen, ' +
        'und es wird nichts geschnitten.'
    );
  }
  return { readable, blockers, warnings, canCut: blockers.length === 0, nativeTimeline: sequence.nativeTimelineAvailable === true };
}

/* --------------------------------------------------------------- the plan */

/** Validates a plan before it reaches the host. Returns German messages. */
export function validatePlan(plan) {
  const problems = [];
  if (!plan || typeof plan !== 'object') {
    problems.push('Kein Schnittplan vorhanden.');
    return problems;
  }
  if (compareTicks(plan.expectedDurationDeltaTicks, '0') > 0) {
    problems.push('Der Schnittplan würde die Sequenz verlängern.');
  }
  const rippleCounts = new Map();
  for (const removal of plan.removals || []) {
    if (removal.ripple) {
      const key = `${removal.trackKind}${removal.trackIndex}:${normalizeTicks(removal.startTicks)}-${normalizeTicks(
        removal.endTicks
      )}`;
      const range = key.split(':')[1];
      rippleCounts.set(range, (rippleCounts.get(range) || 0) + 1);
    }
  }
  for (const [range, count] of rippleCounts) {
    if (count > 1) {
      problems.push(`Für den Bereich ${range} würden ${count} Spuren gleichzeitig rippeln.`);
    }
  }
  const razorTicks = (plan.razorPoints || []).map(point => normalizeTicks(point.ticks));
  if (new Set(razorTicks).size !== razorTicks.length) {
    problems.push('Der Schnittplan enthält doppelte Schnittpunkte.');
  }
  for (const interval of plan.intervals || []) {
    if (compareTicks(interval.endTicks, interval.startTicks) <= 0) {
      problems.push('Der Schnittplan enthält einen leeren Bereich.');
      break;
    }
  }
  return problems;
}

/** Summarises a plan for the panel log. */
export function summarizePlan(plan) {
  const intervals = plan.intervals || [];
  let removedTicks = 0n;
  for (const interval of intervals) {
    removedTicks += toBigIntTicks(interval.endTicks) - toBigIntTicks(interval.startTicks);
  }
  return {
    cutCount: intervals.length,
    razorCount: (plan.razorPoints || []).length,
    removedSeconds: Number(removedTicks) / TICKS_PER_SECOND_NUMBER,
    rejectionCount: (plan.rejections || []).length,
    warningCount: (plan.warnings || []).length
  };
}

/* ------------------------------------------------- readback and verification */

/**
 * The canonical readback shape both sides use as a fingerprint. The controller
 * compares the raw reply text, so the same producer always yields the same
 * string.
 */
export function readbackFingerprint(readback) {
  return JSON.stringify({ ok: true, tracks: readback.tracks });
}

/** Short track label used in every message: V0, A1 and so on. */
export function trackLabel(kind, index) {
  return `${kind === 'video' ? 'V' : 'A'}${index}`;
}

/** true, false or null. Never invents a value for an unreadable state. */
export function normalizeTriState(value) {
  if (value === true || value === 1) {
    return true;
  }
  if (value === false || value === 0) {
    return false;
  }
  return null;
}

function readHostItem(item) {
  return {
    startTicks: normalizeTicks(item.startTicks),
    endTicks: normalizeTicks(item.endTicks),
    sourceInTicks: normalizeTicks(item.sourceInTicks),
    sourceOutTicks: normalizeTicks(item.sourceOutTicks),
    mediaPath: item.mediaPath === undefined ? null : item.mediaPath,
    projectItemId: item.projectItemId === undefined ? null : item.projectItemId,
    disabled: normalizeTriState(item.disabled),
    speed: item.speed === undefined ? null : item.speed
  };
}

/**
 * Independent expectation of the surviving items.
 *
 * Derived from the original readback and the cut intervals before anything is
 * mutated: every original item is split at the interval borders, the removed
 * pieces are dropped and the source range of the surviving pieces is shifted by
 * the same amount. Speed must be 1, otherwise the caller must not apply.
 */
export function expectedKeptItems({ tracks, intervals }) {
  const cuts = (intervals || []).map(interval => ({
    start: toBigIntTicks(interval.startTicks),
    end: toBigIntTicks(interval.endTicks)
  }));
  cuts.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  // A ripple delete is global: every surviving position moves left by the full
  // length of all cut intervals that end before it, not only by the part that
  // overlaps its own original clip.
  const shiftAt = position => {
    let shift = 0n;
    for (const cut of cuts) {
      if (position <= cut.start) {
        break;
      }
      const reached = position < cut.end ? position : cut.end;
      shift += reached - cut.start;
    }
    return shift;
  };

  return tracks.map(track => {
    const items = [];
    for (const item of track.items) {
      const itemStart = toBigIntTicks(item.startTicks);
      const itemEnd = toBigIntTicks(item.endTicks);
      const sourceIn = toBigIntTicks(item.sourceInTicks);
      const speed = item.speed === undefined ? null : item.speed;
      let cursor = itemStart;
      for (const cut of cuts) {
        if (cut.end <= cursor || cut.start >= itemEnd) {
          continue;
        }
        const cutStart = cut.start > cursor ? cut.start : cursor;
        if (cutStart > cursor) {
          items.push({
            startTicks: (cursor - shiftAt(cursor)).toString(),
            endTicks: (cutStart - shiftAt(cutStart)).toString(),
            sourceInTicks: (sourceIn + cursor - itemStart).toString(),
            sourceOutTicks: (sourceIn + cutStart - itemStart).toString(),
            mediaPath: item.mediaPath ?? null,
            projectItemId: item.projectItemId ?? null,
            disabled: normalizeTriState(item.disabled),
            speed
          });
        }
        const cutEnd = cut.end < itemEnd ? cut.end : itemEnd;
        cursor = cutEnd > cursor ? cutEnd : cursor;
      }
      if (cursor < itemEnd) {
        items.push({
          startTicks: (cursor - shiftAt(cursor)).toString(),
          endTicks: (itemEnd - shiftAt(itemEnd)).toString(),
          sourceInTicks: (sourceIn + cursor - itemStart).toString(),
          sourceOutTicks: (sourceIn + itemEnd - itemStart).toString(),
          mediaPath: item.mediaPath ?? null,
          projectItemId: item.projectItemId ?? null,
          disabled: normalizeTriState(item.disabled),
          speed
        });
      }
    }
    return { kind: track.kind, index: track.index, items };
  });
}

/**
 * Compares every expected surviving item against the host readback.
 *
 * Checks kind and index, item count, timeline ticks, source ticks, media and
 * project item identity and the disabled state. A wrong result with an
 * unchanged total duration is detected because each segment is compared.
 */
export function verifyNativePartitions(original, partitioned) {
  if (!Array.isArray(partitioned) || partitioned.length !== original.length) {
    return ['Native Schnittstücke fehlen oder enthalten zusätzliche Spuren.'];
  }
  const problems = [];
  for (const track of original) {
    const after = partitioned.find(t => t.kind === track.kind && t.index === track.index);
    if (!after) { problems.push('Eine Spur fehlt nach dem nativen Schnitt.'); continue; }
    let used = 0;
    for (const item of track.items) {
      const parts = after.items.filter(p => compareTicks(p.startTicks, item.startTicks) >= 0 &&
        compareTicks(p.endTicks, item.endTicks) <= 0);
      let cursor = item.startTicks;
      let sourceCursor = item.sourceInTicks;
      for (const part of parts) {
        if (compareTicks(part.startTicks, cursor) !== 0 || compareTicks(part.sourceInTicks, sourceCursor) !== 0 ||
            part.mediaPath !== item.mediaPath || part.projectItemId !== item.projectItemId ||
            part.disabled !== item.disabled || compareTicks(part.endTicks, part.startTicks) <= 0) {
          problems.push('Ein natives Schnittstück hat eine unerwartete Position oder Medienzuordnung.');
        }
        cursor = part.endTicks;
        sourceCursor = part.sourceOutTicks;
        used++;
      }
      if (compareTicks(cursor, item.endTicks) !== 0 || compareTicks(sourceCursor, item.sourceOutTicks) !== 0) {
        problems.push('Der native Schnitt bewahrt den vollständigen Quellbereich nicht.');
      }
    }
    if (used !== after.items.length) problems.push('Zusätzliche native Schnittstücke sind entstanden.');
  }
  return problems;
}

/** Native razor determines source ranges, including speed and time remapping. */
export function expectedAfterNativeCuts({ tracks, intervals }) {
  const cuts = intervals.map(i => ({start: toBigIntTicks(i.startTicks), end: toBigIntTicks(i.endTicks)}));
  const shiftAt = point => cuts.reduce((sum, cut) => sum + (cut.end <= point ? cut.end - cut.start : 0n), 0n);
  return tracks.map(track => ({kind: track.kind, index: track.index, items: track.items.flatMap(item => {
    const start = toBigIntTicks(item.startTicks), end = toBigIntTicks(item.endTicks);
    if (cuts.some(cut => start >= cut.start && end <= cut.end)) return [];
    if (cuts.some(cut => start < cut.end && end > cut.start)) throw Error('Natives Schnittstück überlappt eine Schnittgrenze.');
    return [{...readHostItem(item), startTicks: (start - shiftAt(start)).toString(), endTicks: (end - shiftAt(start)).toString()}];
  })}));
}

export function verifyReadback({ expected, actual }) {
  const problems = [];
  if (!Array.isArray(expected) || !Array.isArray(actual)) {
    return ['Nachprüfung ohne erwartete oder tatsächliche Daten.'];
  }
  for (const actualTrack of actual) {
    const known = expected.some(
      track => track.kind === actualTrack.kind && track.index === actualTrack.index
    );
    if (!known) {
      problems.push(
        `Spur ${trackLabel(actualTrack.kind, actualTrack.index)} war nicht erwartet.`
      );
    }
  }
  for (const expectedTrack of expected) {
    const label = trackLabel(expectedTrack.kind, expectedTrack.index);
    const actualTrack = actual.find(track => track.kind === expectedTrack.kind && track.index === expectedTrack.index);
    if (!actualTrack) {
      problems.push(`Spur ${label} fehlt nach dem Schnitt.`);
      continue;
    }
    if (actualTrack.items.length !== expectedTrack.items.length) {
      problems.push(
        `Spur ${label}: ${actualTrack.items.length} Elemente erwartet ${expectedTrack.items.length}.`
      );
      continue;
    }
    for (let index = 0; index < expectedTrack.items.length; index++) {
      const expectedItem = expectedTrack.items[index];
      const actualItem = readHostItem(actualTrack.items[index]);
      const where = `Spur ${label}, Element ${index + 1}`;
      if (compareTicks(expectedItem.startTicks, actualItem.startTicks) !== 0) {
        problems.push(`${where}: Startposition weicht ab.`);
      }
      if (compareTicks(expectedItem.endTicks, actualItem.endTicks) !== 0) {
        problems.push(`${where}: Endposition weicht ab.`);
      }
      if (compareTicks(expectedItem.sourceInTicks, actualItem.sourceInTicks) !== 0) {
        problems.push(`${where}: Quellstart weicht ab.`);
      }
      if (compareTicks(expectedItem.sourceOutTicks, actualItem.sourceOutTicks) !== 0) {
        problems.push(`${where}: Quellende weicht ab.`);
      }
      if ((expectedItem.mediaPath ?? null) !== actualItem.mediaPath) {
        problems.push(`${where}: anderes Medium.`);
      }
      if ((expectedItem.projectItemId ?? null) !== actualItem.projectItemId) {
        problems.push(`${where}: anderes Projektelement.`);
      }
      if (expectedItem.disabled !== actualItem.disabled) {
        problems.push(`${where}: Deaktiviert-Status weicht ab.`);
      }
      if ((expectedItem.speed ?? null) !== actualItem.speed) {
        problems.push(`${where}: Geschwindigkeit weicht ab.`);
      }
    }
  }
  return problems;
}

/** Provenance comparison of a full readback, used for the original sequence. */
export function verifyOriginalUnchanged(before, after) {
  const problems = [];
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    problems.push('Die Originalsequenz hat sich verändert.');
  }
  return problems;
}


/**
 * Stable fingerprint of a track readback. Uses exact tick strings and the full
 * provenance (media, project item, disabled, speed). Names are deliberately not
 * part of the identity, they are not unique.
 */
export function fingerprintTracks(tracks) {
  return JSON.stringify(
    (tracks || []).map(track => ({
      kind: track.kind,
      index: track.index,
      items: (track.items || []).map(item => ({
        startTicks: normalizeTicks(item.startTicks),
        endTicks: normalizeTicks(item.endTicks),
        sourceInTicks: normalizeTicks(item.sourceInTicks),
        sourceOutTicks: normalizeTicks(item.sourceOutTicks),
        mediaPath: item.mediaPath === undefined ? null : item.mediaPath,
        projectItemId: item.projectItemId === undefined ? null : item.projectItemId,
        disabled: item.disabled === true,
        speed: item.speed === undefined ? null : item.speed
      }))
    }))
  );
}

/**
 * Preflight before any mutation.
 *
 * Every interval must lie inside exactly one item per affected track. An
 * interval that spans several items or crosses a gap cannot be handled by the
 * verified single range operation, so it is rejected here, before anything is
 * cut, instead of failing halfway through.
 */
export function preflightPlan({ tracks, intervals }) {
  const problems = [];
  if (!Array.isArray(tracks) || !Array.isArray(intervals)) {
    return ['Vorprüfung ohne Spuren oder Bereiche.'];
  }
  for (const interval of intervals) {
    const start = toBigIntTicks(interval.startTicks);
    const end = toBigIntTicks(interval.endTicks);
    for (const track of tracks) {
      const hit = [];
      for (const item of track.items || []) {
        const itemStart = toBigIntTicks(item.startTicks);
        const itemEnd = toBigIntTicks(item.endTicks);
        if (itemStart < end && itemEnd > start) {
          hit.push({ itemStart, itemEnd });
        }
      }
      const label = trackLabel(track.kind, track.index);
      if (hit.length === 0) {
        continue;
      }
      if (hit.length > 1) {
        problems.push(
          `Bereich ${start} bis ${end} liegt auf ${label} über mehrere Clipstücke, das ist nicht belegt.`
        );
        continue;
      }
      if (hit[0].itemStart > start || hit[0].itemEnd < end) {
        problems.push(
          `Bereich ${start} bis ${end} reicht auf ${label} über eine Lücke oder einen Cliprand hinaus.`
        );
      }
    }
  }
  return problems;
}

/** True when the interval is exactly one whole item on the given track. */
export function findExactItemIndex(track, interval) {
  const start = normalizeTicks(interval.startTicks);
  const end = normalizeTicks(interval.endTicks);
  return (track.items || []).findIndex(
    item => normalizeTicks(item.startTicks) === start && normalizeTicks(item.endTicks) === end
  );
}

/**
 * Interprets a host reply. A syntactically valid JSON envelope with `ok: false`
 * is a host failure, not a success: transport and host status are different
 * things.
 */
export function interpretHostReply(text) {
  if (text === 'EvalScript error.' || text === undefined || text === null || text === '') {
    return { ok: false, error: 'Der Host hat den Aufruf ohne Ergebnis beendet.' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Antwort des Hosts nicht lesbar: ${error.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Der Host hat kein gültiges Objekt zurückgegeben.' };
  }
  if (parsed.ok !== true) {
    return {
      ok: false,
      error: parsed.error || 'Der Host hat keinen Erfolg gemeldet.',
      parsed
    };
  }
  return { ok: true, parsed, raw: text };
}

/**
 * The exact evalScript text for one host call.
 *
 * A plain string argument is encoded once, so the JSX receives the string
 * itself. Only the apply payload is JSON text and therefore encoded twice.
 */
export function hostScriptFor(name, payload) {
  if (name === 'prepareCut') return `OS_prepareCut(${JSON.stringify(JSON.stringify(payload))})`;
  if (name === 'readItems') {
    return 'OS_readItems()';
  }
  if (name === 'readSequence') {
    return 'OS_readSequence()';
  }
  if (name === 'clone') {
    return `OS_cloneSequence(${JSON.stringify(payload.expectedIdentity)}, ${JSON.stringify(
      payload.expectedItemFingerprint
    )})`;
  }
  if (name === 'apply') {
    return `OS_applyPlan(${JSON.stringify(JSON.stringify(payload))})`;
  }
  if (name === 'renderAudio') {
    return `OS_renderAudio(${JSON.stringify(JSON.stringify(payload))})`;
  }
  if (name === 'readItemsOfSequence') {
    return `OS_readItemsOfSequence(${JSON.stringify(payload.sequenceId)})`;
  }
  throw new Error(`Unbekannter Hostaufruf ${name}.`);
}

/**
 * Apply workflow with injected host calls, so it can be tested with mocks.
 *
 * Order and stop conditions:
 *  1. validate the plan,
 *  2. read the original and compare it with the analysed state before cloning,
 *  3. clone with the expected identity and fingerprint,
 *  4. compare the clone with the original,
 *  5. preflight and derived expectation on the clone,
 *  6. apply,
 *  7. verify the clone and prove the original unchanged.
 * Every step stops the workflow on failure. Nothing is retried.
 */
export async function applyWorkflow({ callHost, plan, analyzed, capabilities }) {
  const result = { ok: false, steps: [], error: null };
  const step = async (name, payload) => {
    result.steps.push(name);
    return callHost(name, payload);
  };
  const fail = message => {
    result.error = message;
    return result;
  };

  if (!plan) {
    return fail('Kein Schnittplan vorhanden.');
  }
  if (!capabilities || capabilities.canCut !== true) {
    return fail('Schnitt gesperrt: erforderliche Hostwerte sind nicht lesbar.');
  }
  const planProblems = validatePlan(plan);
  if (planProblems.length > 0) {
    return fail(planProblems.join(' '));
  }
  if (
    !analyzed ||
    typeof analyzed.identity !== 'string' ||
    analyzed.identity.length === 0 ||
    typeof analyzed.itemFingerprint !== 'string' ||
    analyzed.itemFingerprint.length === 0 ||
    typeof analyzed.stateFingerprint !== 'string' ||
    analyzed.stateFingerprint.length === 0
  ) {
    return fail('Der analysierte Sequenzzustand fehlt.');
  }

  // 1. The sequence state the plan was built from must still be current.
  const stateNow = await step('readSequence');
  if (!stateNow.ok) {
    return fail(stateNow.error);
  }
  if (stateNow.raw !== analyzed.stateFingerprint) {
    return fail('Die Sequenz hat sich seit der Analyse geändert. Bitte neu analysieren.');
  }

  // 2. Original readback must match the analysed one.
  const originalBefore = await step('readItems');
  if (!originalBefore.ok) {
    return fail(originalBefore.error);
  }
  if (originalBefore.parsed.identity !== analyzed.identity) {
    return fail('Die aktive Sequenz ist nicht die analysierte Sequenz. Es wird nichts geschnitten.');
  }
  if (originalBefore.raw !== analyzed.itemFingerprint) {
    return fail('Die Originalsequenz hat sich seit der Analyse geändert. Es wird nichts geschnitten.');
  }

  // 3. Clone, verified inside the host call.
  const clone = await step('clone', {
    expectedIdentity: analyzed.identity,
    expectedItemFingerprint: analyzed.itemFingerprint
  });
  if (!clone.ok) {
    return fail(clone.error);
  }

  // 4. The copy must be active and identical to the original.
  const cloneBefore = await step('readItems');
  if (!cloneBefore.ok) {
    return fail(cloneBefore.error);
  }
  if (cloneBefore.parsed.identity !== clone.parsed.cloneIdentity) {
    return fail('Die Kopie ist nicht die aktive Sequenz. Es wird nichts geschnitten.');
  }
  // The clone has its own identity, so the envelopes can never be equal. The
  // content must match exactly, the identity must not.
  if (JSON.stringify(cloneBefore.parsed.tracks) !== JSON.stringify(originalBefore.parsed.tracks)) {
    return fail('Die Kopie weicht von der Originalsequenz ab. Es wird nichts geschnitten.');
  }
  if (cloneBefore.parsed.identity === originalBefore.parsed.identity) {
    return fail('Die Kopie hat dieselbe Kennung wie das Original. Es wird nichts geschnitten.');
  }
  if (clone.parsed.originalItems !== originalBefore.raw) {
    return fail('Der Klonauftrag hat einen anderen Originalstand gesehen. Es wird nichts geschnitten.');
  }

  // 5. Preflight and the independent expectation, derived before any mutation.
  const preflight = preflightPlan({ tracks: cloneBefore.parsed.tracks, intervals: plan.intervals });
  if (preflight.length > 0) {
    return fail(preflight.join(' '));
  }
  let expected = capabilities.nativeTimeline
    ? null : expectedKeptItems({ tracks: cloneBefore.parsed.tracks, intervals: plan.intervals });

  // 6. Apply. The payload carries the raw fingerprints of both sequences.
  const applied = await step('apply', {
    plan,
    expectedOriginalId: clone.parsed.originalId,
    expectedCloneIdentity: clone.parsed.cloneIdentity,
    expectedOriginalFingerprint: clone.parsed.originalItems,
    expectedCloneFingerprint: cloneBefore.raw,
    nativeTimeline: capabilities.nativeTimeline === true
  });
  if (!applied.ok) {
    return fail(applied.error);
  }
  if (capabilities.nativeTimeline) {
    const partitions = applied.parsed.beforeRemovalTracks;
    const problems = verifyNativePartitions(cloneBefore.parsed.tracks, partitions);
    if (problems.length) return fail(problems.join(' '));
    expected = expectedAfterNativeCuts({ tracks: partitions, intervals: plan.intervals });
  }

  // 7. Verify every surviving segment on the copy.
  const cloneAfter = await step('readItems');
  if (!cloneAfter.ok) {
    return fail(`Nachprüfung der Kopie nicht möglich: ${cloneAfter.error}`);
  }
  const readbackProblems = verifyReadback({ expected, actual: cloneAfter.parsed.tracks });
  if (readbackProblems.length > 0) {
    return fail(readbackProblems.join(' '));
  }

  // 8. Prove the original is untouched, by raw text.
  const originalAfter = await step('readItemsOfSequence', { sequenceId: analyzed.identity.split(':')[1] });
  if (!originalAfter.ok) {
    return fail(`Prüfung der Originalsequenz nicht möglich: ${originalAfter.error}`);
  }
  if (originalAfter.raw !== originalBefore.raw) {
    return fail('Die Originalsequenz hat sich verändert.');
  }

  result.ok = true;
  result.applied = applied.parsed;
  return result;
}

/** German message for one engine rejection. */
export function describeRejection(rejection) {
  const reason = rejection.reason || 'unbekannter Grund';
  return `Clip ${rejection.clipId} auf ${rejection.track}: ${reason}`;
}
