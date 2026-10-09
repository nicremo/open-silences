import {
  assessCapabilities, buildSnapshot, validatePlan, preflightPlan,
  verifyNativePartitions, expectedAfterNativeCuts, verifyReadback, summarizePlan
} from './core.js';
import {createTranslator} from './i18n.js';

const ENGLISH = createTranslator('en');

export const DEFAULT_SETTINGS = Object.freeze({threshold:-45, minPause:160, minSpeech:160, leadIn:160, tail:160});
// Timing presets in milliseconds: [minPause, minSpeech, leadIn, tail]. Names: preset.<key>.
export const PRESETS = Object.freeze({
  mine: {values:[160,160,160,160]},
  calm: {values:[600,160,220,300]},
  measured: {values:[400,160,180,240]},
  paced: {values:[260,160,160,180]},
  energetic: {values:[160,120,100,120]},
  jumpy: {values:[100,80,60,80]}
});
export const TIMING_FIELDS = Object.freeze(['minPause','minSpeech','leadIn','tail']);
const TPS = 254016000000n;
export const seconds = ticks => Number(BigInt(ticks)) / Number(TPS);

export function resolveSections(sequence, scope, t = ENGLISH) {
  const end = BigInt(sequence.endTicks);
  let sections;
  if (scope === 'entire') sections = [{startTicks:'0', endTicks:end.toString()}];
  else {
    if (!sequence.sections?.readable) throw Error(t('error.sectionsUnreadable'));
    if (scope === 'inout') {
      const {inTicks, outTicks} = sequence.sections;
      if (inTicks === null || outTicks === null) throw Error(t('error.setInOut'));
      sections = [{startTicks:inTicks, endTicks:outTicks}];
    } else if (scope === 'selected') {
      sections = sequence.sections.selectedSections;
      if (!sections?.length) throw Error(t('error.selectClips'));
    } else throw Error(t('error.chooseScope'));
  }
  const sorted = sections.map(range => {
    const start = BigInt(range.startTicks), finish = BigInt(range.endTicks);
    if (start < 0n || finish > end || start >= finish) throw Error(t('error.rangeOutside'));
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

export function settingsToParameters(values, t = ENGLISH) {
  const threshold = Number(values.threshold);
  if (!Number.isFinite(threshold) || threshold < -60 || threshold > 0) throw Error(t('error.threshold'));
  const result = {thresholdDb:threshold};
  for (const field of TIMING_FIELDS) {
    const value = Number(values[field]);
    if (!Number.isFinite(value) || value < 0 || value > 10000) throw Error(t('error.timings'));
    result[field] = value / 1000;
  }
  return result;
}

/** One protected user action: validate, backup, render, plan, cut, read back. */
export function createWorkflow({host, engine, ui, t = ENGLISH}) {
  let running = false;
  let sequence = null;
  let cancelled = false;
  const take = async(name,payload) => {
    const reply = await host(name,payload);
    if (!reply?.ok) throw Error(reply?.error || t('error.host'));
    return reply;
  };
  const checkCancelled = () => { if (cancelled) throw Error(t('error.cancelled')); };
  async function refresh() {
    if (running) return null;
    const reply = await take('readSequence'); sequence = reply.parsed; return sequence;
  }
  async function run(config, estimateOnly = false) {
    if (running) return null;
    running = true; cancelled = false;
    let backup = null, cutting = false;
    ui.busy(true, t('status.check'), true, 'check');
    try {
      if (!sequence) throw Error(t('error.noSequence'));
      const previousIdentity = sequence.identity;
      const fresh = await take('readSequence');
      if (fresh.parsed.identity !== previousIdentity) throw Error(t('error.sequenceChanged'));
      sequence = fresh.parsed;
      const sections = resolveSections(sequence, config.scope, t);
      const parameters = settingsToParameters(config.settings, t);
      const capabilities = assessCapabilities(sequence);
      if (!capabilities.nativeTimeline || !capabilities.canCut) throw Error(t('error.cannotCut', {detail:capabilities.blockers.join(' ')}));
      const analysisTracks = config.analysisTracks;
      if (!analysisTracks?.length) throw Error(t('error.chooseTrack'));
      for (const ref of analysisTracks) {
        const track = sequence.tracks.find(t => t.kind === ref.kind && t.index === ref.index);
        if (!track || track.kind !== 'audio' || track.muted !== false || track.locked !== false || !track.clips.length) throw Error(t('error.trackUnavailable'));
      }
      const original = await take('readItems');
      if (original.parsed.identity !== sequence.identity) throw Error(t('error.sequenceChanged'));
      checkCancelled();
      if (!estimateOnly) {
        ui.busy(true, t('status.backup'), false, 'backup');
        backup = (await take('prepareCut', {expectedIdentity:sequence.identity, expectedStateFingerprint:fresh.raw, expectedItemFingerprint:original.raw})).parsed;
        const backupRead = await take('readItemsOfSequence', {sequenceId:backup.backupId});
        if (backupRead.raw !== backup.backupItems || JSON.stringify(backupRead.parsed.tracks) !== JSON.stringify(original.parsed.tracks)) throw Error(t('error.backupUnverified'));
        ui.backup(backup.backupName);
      }
      checkCancelled();
      const state = await take('readSequence');
      if (state.parsed.identity !== original.parsed.identity) throw Error(t('error.sequenceChanged'));
      const current = await take('readItems');
      if (current.raw !== original.raw) throw Error(t('error.timelineChangedBackup'));
      const tracks = state.parsed.tracks.map(t => ({...t, role:analysisTracks.some(ref => ref.kind === t.kind && ref.index === t.index) ? 'dialogue' : 'other'}));
      const renderPayload = {expectedIdentity:state.parsed.identity, expectedStateFingerprint:state.raw, expectedItemFingerprint:original.raw, analysisTracks};
      async function analyze(verifying = false) {
        const renderText = t(verifying ? 'status.verifyMix' : estimateOnly ? 'status.estimate' : 'status.audio');
        ui.busy(true, renderText, false, verifying ? 'verify' : 'audio');
        const render = (await take('renderAudio', {...renderPayload, outputPath:engine.renderPath()})).parsed;
        checkCancelled(); ui.busy(true, t(verifying ? 'status.verifyMix' : 'status.detect'), true, verifying ? 'verify' : 'detect');
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
        if (!Number.isFinite(analysis.noiseEstimate)) throw Error(t('error.noEstimate'));
        ui.estimate(analysis.noiseEstimate); return {ok:true, noiseEstimate:analysis.noiseEstimate};
      }
      const plan = analysis.plan;
      if (plan.rejections?.length) throw Error(t('error.unsuitable'));
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
      if (operations(plan) !== operations(checked.plan)) throw Error(t('error.mixChanged'));
      const before = await take('readItems');
      const latest = await take('readSequence');
      if (before.raw !== original.raw || latest.raw !== state.raw) throw Error(t('error.timelineChanged'));
      const preflight = preflightPlan({tracks:before.parsed.tracks, intervals:plan.intervals});
      if (preflight.length) throw Error(preflight.join(' '));
      checkCancelled(); cutting = true;
      ui.busy(true, t('status.cut'), false, 'cut');
      // 'ripple' restores the previous assembly with one ripple delete per pause.
      const applied = await take('apply', {plan, assembly:'shift', expectedOriginalId:backup.backupId, expectedOriginalFingerprint:backup.backupItems,
        expectedCloneIdentity:state.parsed.identity, expectedCloneFingerprint:before.raw, expectedStateFingerprint:latest.raw, nativeTimeline:true});
      const partitionProblems = verifyNativePartitions(before.parsed.tracks, applied.parsed.beforeRemovalTracks);
      if (partitionProblems.length) throw Error(partitionProblems.join(' '));
      const expected = expectedAfterNativeCuts({tracks:applied.parsed.beforeRemovalTracks, intervals:plan.intervals});
      const after = await take('readItems');
      if (after.parsed.identity !== state.parsed.identity) throw Error(t('error.readbackSwitched'));
      const problems = verifyReadback({expected, actual:after.parsed.tracks});
      if (problems.length) throw Error(problems.join(' '));
      const backupAfter = await take('readItemsOfSequence', {sequenceId:backup.backupId});
      if (backupAfter.raw !== backup.backupItems) throw Error(t('error.backupChanged'));
      const summary = summarizePlan(plan);
      ui.complete({...summary, backupName:backup.backupName});
      return {ok:true, backup, plan, summary};
    } catch (error) {
      const message = `${error.message}${backup ? t('error.withBackup', {name:backup.backupName}) : ''}${cutting ? t('error.notConfirmed') : ''}`;
      ui.error(message); return {ok:false, error:message, backup};
    } finally { running = false; ui.busy(false, '', false); }
  }
  return {refresh, run, cancel:() => {cancelled = true; engine.cancel?.();}, isRunning:() => running};
}
