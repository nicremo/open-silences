import {
  assessCapabilities, buildSnapshot, validatePlan, preflightPlan,
  verifyNativePartitions, expectedAfterNativeCuts, verifyReadback, summarizePlan
} from './core.js';

export const DEFAULT_SETTINGS = Object.freeze({threshold:-45, minPause:160, minSpeech:160, leadIn:160, tail:160});
// Timing presets in milliseconds: [minPause, minSpeech, leadIn, tail].
export const PRESETS = Object.freeze({
  mine: {label:'Standard', values:[160,160,160,160]},
  calm: {label:'Ruhig', values:[600,160,220,300]},
  measured: {label:'Gemächlich', values:[400,160,180,240]},
  paced: {label:'Flüssig', values:[260,160,160,180]},
  energetic: {label:'Energisch', values:[160,120,100,120]},
  jumpy: {label:'Sehr knapp', values:[100,80,60,80]}
});
export const TIMING_FIELDS = Object.freeze(['minPause','minSpeech','leadIn','tail']);
const TPS = 254016000000n;
export const seconds = ticks => Number(BigInt(ticks)) / Number(TPS);

/** Seconds with one German decimal, for example "41,2 s". */
export function formatSeconds(value) {
  return `${Number(value).toFixed(1).replace('.', ',')}\u00a0s`;
}

/** A duration as minutes and seconds, for example "12:34 min". */
export function formatClock(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}\u00a0min`;
}

/** Share of a whole with one German decimal, for example "5,5 %". */
export function formatPercent(part, whole) {
  const share = whole > 0 ? (part / whole) * 100 : 0;
  return `${share.toFixed(1).replace('.', ',')}\u00a0%`;
}

export function resolveSections(sequence, scope) {
  const end = BigInt(sequence.endTicks);
  let sections;
  if (scope === 'entire') sections = [{startTicks:'0', endTicks:end.toString()}];
  else {
    if (!sequence.sections?.readable) throw Error('Die Bereichsauswahl ist nicht lesbar. Bitte Timeline erneut aktivieren.');
    if (scope === 'inout') {
      const {inTicks, outTicks} = sequence.sections;
      if (inTicks === null || outTicks === null) throw Error('Setze zuerst In und Out in der Timeline mit I und O.');
      sections = [{startTicks:inTicks, endTicks:outTicks}];
    } else if (scope === 'selected') {
      sections = sequence.sections.selectedSections;
      if (!sections?.length) throw Error('Wähle zuerst die gewünschten Clips in der Timeline aus.');
    } else throw Error('Bitte einen Bereich auswählen.');
  }
  const sorted = sections.map(range => {
    const start = BigInt(range.startTicks), finish = BigInt(range.endTicks);
    if (start < 0n || finish > end || start >= finish) throw Error('Der gewählte Bereich liegt außerhalb der Timeline oder ist leer.');
    return {start, end:finish};
  }).sort((a,b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length-1];
    if (last && range.start <= last.end) last.end = range.end > last.end ? range.end : last.end;
    else merged.push({...range});
  }
  return merged.map(range => ({startTicks:range.start.toString(), endTicks:range.end.toString()}));
}

export function settingsToParameters(values) {
  const threshold = Number(values.threshold);
  if (!Number.isFinite(threshold) || threshold < -60 || threshold > 0) throw Error('Noise Floor muss zwischen -60 und 0 dB liegen.');
  const result = {thresholdDb:threshold};
  for (const field of TIMING_FIELDS) {
    const value = Number(values[field]);
    if (!Number.isFinite(value) || value < 0 || value > 10000) throw Error('Die Zeitwerte müssen zwischen 0 und 10.000 ms liegen.');
    result[field] = value / 1000;
  }
  return result;
}

/** One protected user action: validate, backup, render, plan, cut, read back. */
export function createWorkflow({host, engine, ui}) {
  let running = false;
  let sequence = null;
  let cancelled = false;
  const take = async(name,payload) => {
    const reply = await host(name,payload);
    if (!reply?.ok) throw Error(reply?.error || 'Premiere konnte den Auftrag nicht ausführen.');
    return reply;
  };
  const checkCancelled = () => { if (cancelled) throw Error('Abgebrochen. Die Sequenz wurde nicht geschnitten.'); };
  async function refresh() {
    if (running) return null;
    const reply = await take('readSequence'); sequence = reply.parsed; return sequence;
  }
  async function run(config, estimateOnly = false) {
    if (running) return null;
    running = true; cancelled = false;
    let backup = null, cutting = false;
    ui.busy(true, 'Bereich wird geprüft ...', true, 'check');
    try {
      if (!sequence) throw Error('Bitte zuerst eine Sequenz in Premiere öffnen.');
      const previousIdentity = sequence.identity;
      const fresh = await take('readSequence');
      if (fresh.parsed.identity !== previousIdentity) throw Error('Die aktive Sequenz hat gewechselt. Bitte Bereich erneut wählen.');
      sequence = fresh.parsed;
      const sections = resolveSections(sequence, config.scope);
      const parameters = settingsToParameters(config.settings);
      const capabilities = assessCapabilities(sequence);
      if (!capabilities.nativeTimeline || !capabilities.canCut) throw Error(`Diese Sequenz kann noch nicht sicher geschnitten werden. ${capabilities.blockers.join(' ')}`);
      const analysisTracks = config.analysisTracks;
      if (!analysisTracks?.length) throw Error('Wähle mindestens eine hörbare Audiospur mit Sprache.');
      for (const ref of analysisTracks) {
        const track = sequence.tracks.find(t => t.kind === ref.kind && t.index === ref.index);
        if (!track || track.kind !== 'audio' || track.muted !== false || track.locked !== false || !track.clips.length) throw Error('Eine gewählte Audiospur ist stumm, gesperrt oder leer. Bitte Bereich erneut wählen.');
      }
      const original = await take('readItems');
      if (original.parsed.identity !== sequence.identity) throw Error('Die aktive Sequenz hat gewechselt.');
      checkCancelled();
      if (!estimateOnly) {
        ui.busy(true, 'Backup wird erstellt ...', false, 'backup');
        backup = (await take('prepareCut', {expectedIdentity:sequence.identity, expectedStateFingerprint:fresh.raw, expectedItemFingerprint:original.raw})).parsed;
        const backupRead = await take('readItemsOfSequence', {sequenceId:backup.backupId});
        if (backupRead.raw !== backup.backupItems || JSON.stringify(backupRead.parsed.tracks) !== JSON.stringify(original.parsed.tracks)) throw Error('Das Backup konnte nicht vollständig geprüft werden.');
        ui.backup(backup.backupName);
      }
      checkCancelled();
      const state = await take('readSequence');
      if (state.parsed.identity !== original.parsed.identity) throw Error('Die aktive Sequenz hat gewechselt.');
      const current = await take('readItems');
      if (current.raw !== original.raw) throw Error('Die Timeline hat sich beim Backup geändert.');
      const tracks = state.parsed.tracks.map(t => ({...t, role:analysisTracks.some(ref => ref.kind === t.kind && ref.index === t.index) ? 'dialogue' : 'other'}));
      const renderPayload = {expectedIdentity:state.parsed.identity, expectedStateFingerprint:state.raw, expectedItemFingerprint:original.raw, analysisTracks};
      async function analyze(verifying = false) {
        const renderText = verifying ? 'Audiomix wird vor dem Schnitt geprüft ...' : estimateOnly ? 'Pegel wird lokal berechnet ...' : 'Audio wird analysiert ...';
        ui.busy(true, renderText, false, verifying ? 'verify' : 'audio');
        const render = (await take('renderAudio', {...renderPayload, outputPath:engine.renderPath()})).parsed;
        checkCancelled(); ui.busy(true, verifying ? 'Audiomix wird vor dem Schnitt geprüft ...' : 'Stillen werden erkannt ...', true, verifying ? 'verify' : 'detect');
        const snapshot = buildSnapshot({sequence:{...state.parsed, startTicks:'0'}, tracks, analysisTracks, parameters,
          selectedSections:sections, renderedMixdown:{mediaPath:render.mediaPath, analysisTracks}, channelMode:'loudest'});
        const result = await engine.run(snapshot, {estimate:estimateOnly});
        checkCancelled();
        if (!result.ok) throw Error(result.error);
        const problems = validatePlan(result.envelope.plan);
        if (problems.length) throw Error(problems.join(' '));
        return result.envelope;
      }
      const analysis = await analyze();
      if (estimateOnly) {
        if (!Number.isFinite(analysis.noiseEstimate)) throw Error('Kein eindeutiger Ruhepegel gefunden. Stelle den Noise Floor manuell ein, zum Beispiel auf -45 dB.');
        ui.estimate(analysis.noiseEstimate); return {ok:true, noiseEstimate:analysis.noiseEstimate};
      }
      const plan = analysis.plan;
      if (plan.rejections?.length) throw Error('Ein Teil der Timeline ist für diesen Schnitt ungeeignet. Prüfe gesperrte Spuren, Übergänge und fehlende Medien.');
      if (!plan.intervals.length) {
        ui.complete({cutCount:0, removedSeconds:0, backupName:backup.backupName});
        return {ok:true, backup, plan};
      }
      // The user sees what will happen before anything is cut.
      const rangeSeconds = sections.reduce((sum, range) => sum + seconds((BigInt(range.endTicks) - BigInt(range.startTicks)).toString()), 0);
      const preview = summarizePlan(plan);
      checkCancelled();
      const approved = await ui.confirm({cutCount:preview.cutCount, removedSeconds:preview.removedSeconds, rangeSeconds});
      if (!approved) {
        ui.complete({cutCount:0, removedSeconds:0, backupName:backup.backupName, declined:true});
        return {ok:true, declined:true, backup, plan};
      }
      checkCancelled();
      // A second native render checks mixer state that has no public reader.
      const checked = await analyze(true);
      const operations = p => JSON.stringify({intervals:p.intervals, removals:p.removals, razorPoints:p.razorPoints, delta:p.expectedDurationDeltaTicks});
      if (operations(plan) !== operations(checked.plan)) throw Error('Der Audiomix hat sich geändert. Das Backup bleibt erhalten. Bitte erneut starten.');
      const before = await take('readItems');
      const latest = await take('readSequence');
      if (before.raw !== original.raw || latest.raw !== state.raw) throw Error('Die Timeline hat sich während der Analyse geändert. Bitte erneut starten.');
      const preflight = preflightPlan({tracks:before.parsed.tracks, intervals:plan.intervals});
      if (preflight.length) throw Error(preflight.join(' '));
      checkCancelled(); cutting = true;
      ui.busy(true, 'Stillen werden entfernt ...', false, 'cut');
      // 'ripple' restores the previous assembly with one ripple delete per pause.
      const applied = await take('apply', {plan, assembly:'shift', expectedOriginalId:backup.backupId, expectedOriginalFingerprint:backup.backupItems,
        expectedCloneIdentity:state.parsed.identity, expectedCloneFingerprint:before.raw, expectedStateFingerprint:latest.raw, nativeTimeline:true});
      const partitionProblems = verifyNativePartitions(before.parsed.tracks, applied.parsed.beforeRemovalTracks);
      if (partitionProblems.length) throw Error(partitionProblems.join(' '));
      const expected = expectedAfterNativeCuts({tracks:applied.parsed.beforeRemovalTracks, intervals:plan.intervals});
      const after = await take('readItems');
      if (after.parsed.identity !== state.parsed.identity) throw Error('Nachprüfung: aktive Sequenz hat gewechselt.');
      const problems = verifyReadback({expected, actual:after.parsed.tracks});
      if (problems.length) throw Error(problems.join(' '));
      const backupAfter = await take('readItemsOfSequence', {sequenceId:backup.backupId});
      if (backupAfter.raw !== backup.backupItems) throw Error('Die Backup-Sequenz hat sich geändert.');
      const summary = summarizePlan(plan);
      ui.complete({...summary, backupName:backup.backupName});
      return {ok:true, backup, plan, summary};
    } catch (error) {
      const message = `${error.message}${backup ? ` Backup: ${backup.backupName}.` : ''}${cutting ? ' Der Schnitt wurde nicht bestätigt. Öffne das Backup, um den vorherigen Stand wiederherzustellen.' : ''}`;
      ui.error(message); return {ok:false, error:message, backup};
    } finally { running = false; ui.busy(false, '', false); }
  }
  return {refresh, run, cancel:() => {cancelled = true; engine.cancel?.();}, isRunning:() => running};
}
