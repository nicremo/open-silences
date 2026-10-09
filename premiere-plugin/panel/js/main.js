import {interpretHostReply, hostScriptFor} from './core.js';
import {createWorkflow, DEFAULT_SETTINGS, PRESETS, TIMING_FIELDS, resolveSections, seconds} from './workflow.js';
import {LANGUAGES, createTranslator, createFormat, resolveLanguage} from './i18n.js';
const csInterface = new CSInterface();
const ENGINE_RELATIVE_PATH = 'engine/silences-engine';
const STDOUT_LIMIT_BYTES = 32 * 1024 * 1024;
const STDERR_LIMIT_BYTES = 8192;
const runtime = {activeChild:null, cancelRequested:false};
const $ = id => document.getElementById(id);
const LANGUAGE_KEY = 'open-silences-language';
let t = createTranslator('en'), fmt = createFormat('en');
// A status given as a function is rendered again when the language changes.
let lastStatus = {message:'', kind:''};
function log(message, kind) { status(message, kind === 'error' ? 'error' : ''); }
function status(message, kind='') {
  lastStatus = {message, kind};
  const text = typeof message === 'function' ? message() : message;
  $('status').hidden=!text; $('status').textContent=text; $('status').className=kind;
}
function evalScript(script) {
  return new Promise(resolve => {
    csInterface.evalScript(script, resolve);
  });
}

/** One named host call. A host error envelope is a failure, not a success. */
async function callHost(name, payload) {
  let script;
  try {
    script = hostScriptFor(name, payload);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return interpretHostReply(await evalScript(script));
}

function extensionPath() {
  return csInterface.getSystemPath(SystemPath.EXTENSION);
}

function joinPath(directory, relative) {
  const separator = directory.indexOf('\\') >= 0 ? '\\' : '/';
  return `${directory}${directory.endsWith(separator) ? '' : separator}${relative}`;
}

function evidenceDirectory() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const base = path.join(os.tmpdir(), 'open-silences-evidence');
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }
  const runDirectory = path.join(base, require('node:crypto').randomUUID());
  fs.mkdirSync(runDirectory, { recursive: true });
  return runDirectory;
}

/**
 * Runs the engine once.
 *
 * stdout is capped by bytes and must stay parseable, stderr keeps its byte tail.
 * An overflow cancels the run instead of wasting the decoder deadline. Evidence
 * files are retained on purpose.
 */
function runEngine(snapshot, { timeoutSeconds = 1800, estimate = false } = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawn } = require('node:child_process');

  const enginePath = joinPath(extensionPath(), ENGINE_RELATIVE_PATH);
  if (!fs.existsSync(enginePath)) {
    return Promise.resolve({
      ok: false,
      error: t('engine.missing', {path:enginePath})
    });
  }

  const runDirectory = evidenceDirectory();
  const snapshotPath = path.join(runDirectory, 'snapshot.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

  const args = ['plan', '--input', snapshotPath, '--watch-stdin', '--timeout-seconds', String(timeoutSeconds)];
  if (estimate) args.push('--with-db-values');

  return new Promise(resolve => {
    const child = spawn(enginePath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    runtime.activeChild = child;
    runtime.cancelRequested = false;

    let stdoutBytes = 0;
    const stdoutChunks = [];
    let stderrTail = Buffer.alloc(0);
    let settled = false;
    let escalation = null;
    let hardKill = null;

    const clearTimers = () => {
      clearTimeout(hardTimer);
      if (escalation) {
        clearTimeout(escalation);
      }
      if (hardKill) {
        clearTimeout(hardKill);
      }
    };

    const finish = outcome => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      runtime.activeChild = null;
      try {
        fs.writeFileSync(path.join(runDirectory, 'stdout.json'), Buffer.concat(stdoutChunks));
        fs.writeFileSync(path.join(runDirectory, 'stderr.txt'), stderrTail);
      } catch (error) {
        // Incomplete evidence is reported through the result text.
      }
      resolve({ ...outcome, runDirectory });
    };

    const cancelRun = () => {
      runtime.cancelRequested = true;
      try {
        child.stdin.end();
      } catch (error) {
        // Already closed.
      }
      escalation = setTimeout(() => child.kill('SIGTERM'), 1500);
      hardKill = setTimeout(() => child.kill('SIGKILL'), 4000);
    };

    const hardTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      log(() => t('engine.timeout'), 'warn');
      cancelRun();
    }, (timeoutSeconds + 30) * 1000);

    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= STDOUT_LIMIT_BYTES) {
        stdoutChunks.push(chunk);
        return;
      }
      log(() => t('engine.overflow'), 'error');
      cancelRun();
    });
    child.stderr.on('data', chunk => {
      // Byte exact tail, not a character count.
      const combined = Buffer.concat([stderrTail, chunk]);
      stderrTail =
        combined.length > STDERR_LIMIT_BYTES ? combined.subarray(combined.length - STDERR_LIMIT_BYTES) : combined;
    });
    child.on('error', error => {
      finish({ ok: false, error: t('engine.startFailed', {detail:error.message}) });
    });
    child.on('close', code => {
      if (stdoutBytes > STDOUT_LIMIT_BYTES) {
        finish({ ok: false, error: t('engine.overflowDiscarded') });
        return;
      }
      if (runtime.cancelRequested) {
        finish({ ok: false, error: t('engine.cancelled') });
        return;
      }
      if (code !== 0) {
        finish({ ok: false, error: stderrTail.toString('utf8').trim() || t('engine.exit', {code}) });
        return;
      }
      try {
        finish({ ok: true, envelope: JSON.parse(Buffer.concat(stdoutChunks).toString('utf8')) });
      } catch (error) {
        finish({ ok: false, error: t('engine.unreadable', {detail:error.message}) });
      }
    });
  });
}

/** Cancels the running engine: close the cancel channel, wait, then escalate. */
function cancelEngine() {
  const child = runtime.activeChild;
  if (!child) {
    return;
  }
  runtime.cancelRequested = true;
  log(() => t('engine.cancelRequested'), 'warn');
  try {
    child.stdin.end();
  } catch (error) {
    // Already closed.
  }
  setTimeout(() => {
    if (runtime.activeChild === child) {
      child.kill('SIGTERM');
    }
  }, 1500);
  setTimeout(() => {
    if (runtime.activeChild === child) {
      child.kill('SIGKILL');
    }
  }, 4000);
}


let sequence = null, step = 1, busy = false;
// Rendered parts that depend on the language, kept so a switch can redraw them.
let summaryParts = null, lastPreview = null, lastResult = null, lastPhase = null, lastBackup = null;
const fields = ['threshold', ...TIMING_FIELDS];
// Settings saved before version 3 used other field names. The label of each
// field is unchanged, so values move to the field with the same label.
const LEGACY_FIELDS = {noiseLevel:'threshold', minSilence:'minPause', minTalk:'minSpeech', marginBefore:'leadIn', marginAfter:'tail'};
let saved;
try { saved=JSON.parse(localStorage.getItem('open-silences-settings-v3')); } catch (_) {}
if (!saved) {
  try {
    const legacy=JSON.parse(localStorage.getItem('open-silences-settings-v2'));
    if (legacy) saved=Object.fromEntries(Object.entries(LEGACY_FIELDS).map(([from,to])=>[to,legacy[from]]));
  } catch (_) {}
}
for (const field of fields) $(field).value=String(Number.isFinite(saved?.[field]) ? saved[field] : DEFAULT_SETTINGS[field]);
$('thresholdSlider').value=$('threshold').value;
function saveSettings() {
  const values=Object.fromEntries(fields.map(field=>[field,Number($(field).value)]));
  try { localStorage.setItem('open-silences-settings-v3',JSON.stringify(values)); } catch (_) {}
}
const PHASES = {full:['backup','audio','detect','verify','cut'], estimate:['audio','detect']};
// Premiere does not respond while it clones, renders or cuts.
const BLOCKING_PHASES = new Set(['backup','audio','verify','cut']);
let runKind = 'full';
function showProgress(phase) {
  lastPhase = phase;
  const order = PHASES[runKind];
  const position = order.indexOf(phase);
  $('progress').hidden = position < 0;
  $('blockingHint').hidden = !BLOCKING_PHASES.has(phase);
  if (position < 0) return;
  $('progress').replaceChildren(...order.map((name, index) => {
    const item = document.createElement('li');
    item.textContent = t(`phase.${name}`);
    if (index < position) item.className = 'done';
    if (index === position) { item.className = 'active'; item.setAttribute('aria-current', 'step'); }
    return item;
  }));
}
function renderConfirm() {
  if (!lastPreview) return;
  $('confirmText').textContent = t.plural('confirm.text', lastPreview.cutCount, {seconds:fmt.seconds(lastPreview.removedSeconds), percent:fmt.percent(lastPreview.removedSeconds, lastPreview.rangeSeconds)});
}
function confirmCut(preview) {
  status('');
  $('blockingHint').hidden = true;
  lastPreview = preview; renderConfirm();
  // Only the two answers are offered: cancel would leave the question open and
  // the primary button would duplicate the cut action.
  $('cancel').hidden = true;
  $('primary').hidden = true;
  $('confirm').hidden = false;
  $('confirmCut').focus();
  return new Promise(resolve => {
    const answer = value => {
      $('confirm').hidden = true;
      $('primary').hidden = false;
      $('confirmCut').onclick = null;
      $('confirmCancel').onclick = null;
      lastPreview = null;
      resolve(value);
    };
    $('confirmCut').onclick = () => answer(true);
    $('confirmCancel').onclick = () => answer(false);
  });
}
function renderResult() {
  const summary = lastResult;
  if (!summary) return;
  const cut = summary.cutCount > 0 && !summary.declined;
  $('resultValue').textContent = summary.declined ? t('result.declined') : cut ? t('result.removed', {seconds:fmt.seconds(summary.removedSeconds)}) : t('result.none');
  $('resultDetail').textContent = cut ? t.plural('result.cuts', summary.cutCount, {name:summary.backupName}) : t('result.backup', {name:summary.backupName});
}
function showResult(summary) {
  status('');
  lastResult = summary; renderResult();
  $('result').hidden = false;
}
function updatePreset() {
  $('preset').value=Object.entries(PRESETS).find(([,preset])=>preset.values.every((v,i)=>v===Number($(fields[i+1]).value)))?.[0] || 'custom';
}
updatePreset();
function config() { return {
  scope:document.querySelector('input[name="scope"]:checked').value,
  analysisTracks:[...document.querySelectorAll('#tracks input:checked')].map(el=>({kind:'audio',index:Number(el.value)})),
  settings:Object.fromEntries(fields.map(field=>[field,$(field).value]))
}; }
function primaryText() { return busy ? t('primary.busy') : step===1 ? t('primary.next') : t('primary.run'); }
function changeStep(next) {
  step=next; $('sections').hidden=next!==1; $('settings').hidden=next!==2;
  $('stepOne').removeAttribute('aria-current'); $('stepTwo').removeAttribute('aria-current');
  $(next===1?'stepOne':'stepTwo').setAttribute('aria-current','step');
  $('primary').textContent=primaryText();
  $('safety').hidden=next===1;
  document.querySelector('main').scrollTop=0;
}
function setBusy(running,text,cancellable,phase) {
  busy=running;
  for (const el of document.querySelectorAll('input,select,button')) {
    if (el.id==='cancel' || el.dataset.keepEnabled==='true') continue;
    el.disabled=running || el.dataset.unavailable==='true' || (el.id==='primary'&&!sequence);
  }
  $('cancel').hidden=!running; $('cancel').disabled=!cancellable;
  if (running) { $('result').hidden=true; lastResult=null; showProgress(phase); status(text); $('primary').textContent=primaryText(); }
  else { lastPhase=null; $('progress').hidden=true; $('blockingHint').hidden=true; $('confirm').hidden=true; $('primary').hidden=false; $('primary').textContent=primaryText(); }
}
function renderBackup() { if (lastBackup) $('backupNotice').textContent=t('backup.notice', {name:lastBackup}); }
const workflow=createWorkflow({host:callHost, engine:{run:runEngine, renderPath:()=>joinPath(evidenceDirectory(),'timeline.wav'), cancel:cancelEngine}, t:(key, vars)=>t(key, vars), ui:{
  busy:setBusy,
  backup:name=>{ lastBackup=name; $('backupNotice').hidden=false; renderBackup(); },
  error:message=>status(message,'error'),
  estimate:value=>{ $('threshold').value=String(value); $('thresholdSlider').value=String(value); saveSettings(); status(()=>t('estimate.result', {value:fmt.decimal(value)}),'success'); },
  confirm:confirmCut,
  complete:showResult
}});
function renderSequence() {
  if (!sequence) { $('sequenceName').textContent=t('sequence.none'); $('sequenceMeta').textContent=t('sequence.open'); return; }
  $('sequenceName').textContent=sequence.name;
  $('sequenceMeta').textContent=`${fmt.clock(seconds(sequence.endTicks))} · ${sequence.fps.toFixed(2).replace('.', t.language==='en'?'.':',')} fps`;
}
function trackDetail(track) {
  return track.muted ? t('tracks.muted') : track.locked ? t('tracks.locked') : (track.muted!==false||track.locked!==false) ? t('tracks.unreadable') : '';
}
function renderTracks() {
  for (const label of document.querySelectorAll('#tracks .track')) label.querySelector('small').textContent=trackDetail(label._track);
  if (sequence && !document.querySelector('#tracks .track')) $('tracks').textContent=t('tracks.empty');
}
let sequenceRead = false;
async function refresh() {
  if (busy) return;
  $('primary').disabled=true;
  const chosen=[...document.querySelectorAll('#tracks input:checked')].map(el=>Number(el.value));
  const previousId=sequence?.identity;
  try {
    sequence=await workflow.refresh();
    sequenceRead=true;
    renderSequence();
    $('tracks').replaceChildren();
    const audio=sequence.tracks.filter(track=>track.kind==='audio'&&track.clips.length);
    const first=audio.find(track=>track.muted===false&&track.locked===false)?.index;
    for (const track of audio) {
      const label=document.createElement('label'); label.className='track'; label._track=track;
      const checkbox=document.createElement('input'); checkbox.type='checkbox'; checkbox.value=String(track.index);
      const unavailable=track.muted!==false||track.locked!==false;
      checkbox.disabled=unavailable; checkbox.dataset.unavailable=String(unavailable);
      checkbox.checked=!unavailable&&(previousId===sequence.identity ? chosen.includes(track.index) : track.index===first);
      const name=document.createElement('span'); name.textContent=`A${track.index+1} · ${track.name}`;
      const detail=document.createElement('small'); detail.textContent=trackDetail(track);
      if (unavailable) label.classList.add('unavailable');
      label.append(checkbox,name,detail); $('tracks').append(label);
    }
    if (!audio.length) $('tracks').textContent=t('tracks.empty');
    $('primary').disabled=false;
  } catch(error) {
    sequence=null; sequenceRead=true; renderSequence();
    // The sequence card already says this in the chosen language.
    if (!/^No active sequence/.test(error.message)) status(error.message,'error');
  }
}
function renderScopeSummary() {
  if (!summaryParts) return;
  $('scopeSummary').textContent=`${t(`scope.${summaryParts.scope}`)} · ${fmt.clock(summaryParts.length)} · ${summaryParts.tracks}`;
}

/** Applies a language to every static text and redraws the dynamic ones. */
function applyLanguage(code) {
  t=createTranslator(resolveLanguage(code)); fmt=createFormat(t.language);
  document.documentElement.lang=t.language;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent=t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  $('language').value=t.language;
  $('primary').textContent=primaryText();
  if (sequenceRead) { renderSequence(); renderTracks(); } else $('sequenceName').textContent=t('sequence.reading');
  renderScopeSummary(); renderConfirm(); renderResult(); renderBackup();
  if (lastPhase) showProgress(lastPhase);
  if (typeof lastStatus.message==='function') status(lastStatus.message, lastStatus.kind);
}
function storedLanguage() {
  try { const value=localStorage.getItem(LANGUAGE_KEY); return LANGUAGES.some(language=>language.code===value) ? value : null; } catch (_) { return null; }
}
function storeLanguage(code) { try { localStorage.setItem(LANGUAGE_KEY, code); } catch (_) {} }
function hostLocale() {
  try { return csInterface.hostEnvironment?.appUILocale || navigator.language; } catch (_) { return navigator.language; }
}
function showApp() {
  $('languageScreen').hidden=true; $('languageControl').hidden=false; $('steps').hidden=false; $('footer').hidden=false;
  changeStep(step);
}
function showLanguageScreen(code) {
  $('languageScreen').hidden=false; $('languageControl').hidden=true; $('steps').hidden=true; $('footer').hidden=true;
  $('sections').hidden=true; $('settings').hidden=true;
  for (const input of document.querySelectorAll('input[name="languageChoice"]')) input.checked=input.value===code;
  markChoices('#languageChoices');
  document.querySelector('input[name="languageChoice"]:checked')?.focus();
}
function markChoices(selector) { for (const label of document.querySelectorAll(`${selector} .scope`)) label.classList.toggle('chosen',label.querySelector('input').checked); }

$('primary').addEventListener('click',async()=>{
  if (busy) return;
  status('');
  if (step===1) {
    try {
      const identity=sequence?.identity;
      const fresh=await workflow.refresh();
      if (fresh.identity!==identity) { await refresh(); throw Error(t('error.sequenceSwitched')); }
      sequence=fresh;
      const selection=config(); const ranges=resolveSections(sequence,selection.scope,t);
      if (!selection.analysisTracks.length) throw Error(t('error.chooseTrack'));
      const length=ranges.reduce((sum,r)=>sum+seconds((BigInt(r.endTicks)-BigInt(r.startTicks)).toString()),0);
      summaryParts={scope:selection.scope, length, tracks:selection.analysisTracks.map(track=>`A${track.index+1}`).join(', ')};
      renderScopeSummary();
      changeStep(2); $('settingsTitle').tabIndex=-1; $('settingsTitle').focus();
    } catch(error) { status(error.message,'error'); }
  } else if ($('settingsForm').reportValidity()) { saveSettings(); runKind='full'; await workflow.run(config()); }
});
$('estimate').addEventListener('click',()=>{ if ($('settingsForm').reportValidity()) { runKind='estimate'; workflow.run(config(),true); } });
$('refresh').addEventListener('click',()=>{status('');refresh();});
$('back').addEventListener('click',()=>{if(!busy){$('result').hidden=true;lastResult=null;changeStep(1);status('');refresh();}});
$('cancel').addEventListener('click',()=>{workflow.cancel(); $('cancel').disabled=true; status(()=>t('cancel.pending'));});
$('thresholdSlider').addEventListener('input',()=>{$('threshold').value=$('thresholdSlider').value;saveSettings();});
$('threshold').addEventListener('input',()=>{$('thresholdSlider').value=$('threshold').value;saveSettings();});
$('preset').addEventListener('change',()=>{const preset=PRESETS[$('preset').value]; if(preset) preset.values.forEach((v,i)=>$(fields[i+1]).value=String(v)); saveSettings();});
for(const field of fields.slice(1)) $(field).addEventListener('input',()=>{updatePreset();saveSettings();});
$('settingsForm').addEventListener('submit',event=>event.preventDefault());
$('language').addEventListener('change',()=>{ if (busy) return; storeLanguage($('language').value); applyLanguage($('language').value); });
$('languageChoices').addEventListener('change',event=>{ markChoices('#languageChoices'); applyLanguage(event.target.value); });
$('languageContinue').addEventListener('click',()=>{ storeLanguage(t.language); showApp(); $('sectionTitle').tabIndex=-1; $('sectionTitle').focus(); });

function markScope() { markChoices('#scope'); }
$('scope').addEventListener('change',markScope); markScope();

const initialLanguage=storedLanguage();
applyLanguage(initialLanguage || resolveLanguage(hostLocale()));
if (initialLanguage) showApp(); else showLanguageScreen(t.language);
refresh();
