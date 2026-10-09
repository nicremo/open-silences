import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SETTINGS, PRESETS, resolveSections, settingsToParameters, createWorkflow} from '../panel/js/workflow.js';
import {createTranslator} from '../panel/js/i18n.js';
const seq={identity:'doc:target',endTicks:'2540160000000',sections:{readable:true,inTicks:null,outTicks:null,selectedSections:[]}};
test('defaults use -45 dB and four 160 ms values with label correct names',()=>{
 assert.equal(DEFAULT_SETTINGS.threshold,-45);
 assert.deepEqual(settingsToParameters(DEFAULT_SETTINGS),{thresholdDb:-45,minPause:.16,minSpeech:.16,leadIn:.16,tail:.16});
 assert.deepEqual(settingsToParameters({...DEFAULT_SETTINGS,leadIn:100,tail:300}),{thresholdDb:-45,minPause:.16,minSpeech:.16,leadIn:.1,tail:.3});
 assert.equal(settingsToParameters({...DEFAULT_SETTINGS,threshold:-60}).thresholdDb,-60);
 assert.throws(()=>settingsToParameters({...DEFAULT_SETTINGS,threshold:-61}));
 assert.throws(()=>settingsToParameters({...DEFAULT_SETTINGS,tail:10001}));
});
test('unset In/Out and empty selection stop instead of silently processing everything',()=>{
 assert.throws(()=>resolveSections(seq,'inout'),/In and Out/);
 assert.throws(()=>resolveSections(seq,'selected'),/clips/);
 assert.throws(()=>resolveSections(seq,'inout',createTranslator('es')),/entrada y la salida/);
 assert.deepEqual(resolveSections(seq,'entire'),[{startTicks:'0',endTicks:seq.endTicks}]);
});
test('selected sections merge overlap but preserve disjoint gaps and exact ticks',()=>{
 const sequence={...seq,endTicks:'10000000000000001',sections:{readable:true,selectedSections:[{startTicks:'10',endTicks:'20'},{startTicks:'15',endTicks:'30'},{startTicks:'10000000000000000',endTicks:'10000000000000001'}]}};
 assert.deepEqual(resolveSections(sequence,'selected'),[{startTicks:'10',endTicks:'30'},{startTicks:'10000000000000000',endTicks:'10000000000000001'}]);
});
function harness({fail,wait,plan,confirm=true,t}={}) {
 const calls=[], notices=[], phases=[], previews=[]; const tracks=[{kind:'audio',index:0,name:'Voice',locked:false,muted:false,transitions:0,clips:[{id:'clip',startTicks:'0',endTicks:seq.endTicks,sourceInTicks:'0',sourceOutTicks:seq.endTicks,inPointSeconds:0,outPointSeconds:10,speed:1,mediaPath:'/test.mov',projectItemId:'clip',disabled:false,linked:null}]}];
 const sequence={...seq,ok:true,tracks,qeAvailable:true,fpsSupported:true,fpsObserved:true,fpsNumerator:25,fpsDenominator:1,zeroPointTicks:'0',sourceTicksReadable:true,mediaIdentityReadable:true,transitionsReadable:true,nativeTimelineAvailable:true};
 const items={identity:seq.identity,tracks:tracks.map(t=>({kind:t.kind,index:t.index,items:[]}))};
 const workflow=createWorkflow({host:async(name)=>{
  calls.push(name); if(wait&&name==='readSequence') await wait;
  if(fail===name) return {ok:false,error:'controlled failure'};
  if(name==='readSequence') return {ok:true,parsed:sequence,raw:'state'};
  if(name==='readItems') return {ok:true,parsed:items,raw:'original'};
  if(name==='prepareCut') return {ok:true,parsed:{backupId:'backup',backupItems:'protected',backupName:'Target backup'}};
  if(name==='readItemsOfSequence') return {ok:true,parsed:{...items,identity:'doc:backup'},raw:'protected'};
  if(name==='renderAudio') return {ok:true,parsed:{mediaPath:'/render.wav'}};
  throw Error(`unexpected call ${name}`);
 },engine:{renderPath:()=>'/render.wav',run:async()=>{calls.push('engine');return {ok:true,envelope:{plan:plan||{intervals:[],removals:[],razorPoints:[],rejections:[],expectedDurationDeltaTicks:'0',ticksPerFrame:10160640000,frameRate:25},noiseEstimate:-45}};}},ui:{busy:(...args)=>{notices.push(args); if(args[0]&&args[3]) phases.push(args[3]);},backup:()=>{},error:e=>notices.push(e),complete:summary=>notices.push({complete:summary}),estimate:()=>{},confirm:async preview=>{previews.push(preview);return confirm;}},t});
 return {workflow,calls,notices,phases,previews};
}
const config={scope:'entire',settings:DEFAULT_SETTINGS,analysisTracks:[{kind:'audio',index:0}]};
test('backup is verified before any render or engine run',async()=>{
 const h=harness();await h.workflow.refresh();const result=await h.workflow.run(config);
 assert.equal(result.ok,true,result.error);
 assert.ok(h.calls.indexOf('prepareCut')<h.calls.indexOf('renderAudio'));
 assert.ok(h.calls.indexOf('readItemsOfSequence')<h.calls.indexOf('engine'));
 assert.equal(h.calls.includes('apply'),false,'no silence means no edit');
});
test('failed backup never reaches audio rendering, engine or apply',async()=>{
 const h=harness({fail:'prepareCut'});await h.workflow.refresh();const result=await h.workflow.run(config);
 assert.equal(result.ok,false);assert.equal(h.calls.includes('renderAudio'),false);assert.equal(h.workflow.isRunning(),false);
});
test('double click cannot create a second backup or render',async()=>{
 const h=harness();await h.workflow.refresh();const first=h.workflow.run(config);const second=await h.workflow.run(config);await first;
 assert.equal(second,null);assert.equal(h.calls.filter(c=>c==='prepareCut').length,1);
});
const ONE_SECOND='254016000000';
const cutPlan={
 intervals:[{startTicks:'0',endTicks:ONE_SECOND,startFrame:0,endFrame:25}],
 removals:[{trackKind:'audio',trackIndex:0,startTicks:'0',endTicks:ONE_SECOND,ripple:true}],
 razorPoints:[{ticks:'0',frame:0},{ticks:ONE_SECOND,frame:25}],
 rejections:[],warnings:[],expectedDurationDeltaTicks:'-'+ONE_SECOND,ticksPerFrame:10160640000,frameRate:25
};
test('every busy update names its phase in workflow order',async()=>{
 const h=harness();await h.workflow.refresh();const result=await h.workflow.run(config);
 assert.equal(result.ok,true,result.error);
 assert.deepEqual(h.phases,['check','backup','audio','detect']);
});
test('declining the preview cuts nothing, skips the second render and keeps the backup',async()=>{
 const h=harness({plan:cutPlan,confirm:false});await h.workflow.refresh();const result=await h.workflow.run(config);
 assert.equal(result.ok,true,result.error);
 assert.equal(result.declined,true);
 assert.equal(h.previews.length,1);
 assert.equal(h.previews[0].cutCount,1);
 assert.equal(h.previews[0].removedSeconds,1);
 assert.equal(h.previews[0].rangeSeconds,10);
 assert.equal(h.calls.filter(c=>c==='renderAudio').length,1,'no second render after declining');
 assert.equal(h.calls.includes('apply'),false);
 assert.equal(h.phases.includes('verify'),false);
 const complete=h.notices.find(n=>n?.complete)?.complete;
 assert.equal(complete.declined,true);
 assert.equal(complete.backupName,'Target backup');
});
test('the threshold estimate never asks for confirmation',async()=>{
 const h=harness({plan:cutPlan});await h.workflow.refresh();
 const result=await h.workflow.run(config,true);
 assert.equal(result.ok,true,result.error);
 assert.equal(h.previews.length,0);
 assert.equal(h.calls.includes('prepareCut'),false);
});
test('presets are values only, their names live in the language tables',()=>{
 assert.deepEqual(Object.keys(PRESETS),['mine','calm','measured','paced','energetic','jumpy']);
 assert.deepEqual(PRESETS.mine.values,[160,160,160,160]);
});
test('workflow messages follow the injected language and default to English',async()=>{
 const english=harness();const failed=await english.workflow.run(config);
 assert.equal(failed.error,'Please open a sequence in Premiere first.');
 const german=harness({fail:'prepareCut',t:createTranslator('de')});await german.workflow.refresh();
 const result=await german.workflow.run(config);
 assert.equal(result.ok,false);
 assert.match(result.error,/^controlled failure$/);
 const busy=german.notices.find(n=>Array.isArray(n)&&n[0]&&n[3]==='backup');
 assert.equal(busy[1],'Backup wird erstellt ...');
});
