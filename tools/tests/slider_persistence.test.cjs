const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test');
const cpp=fs.readFileSync(path.join(__dirname,'../../src/web/web_server.cpp'),'utf8');
function body(marker){
 const at=cpp.indexOf(marker);assert.ok(at>=0,marker);const start=cpp.indexOf('{',at);let depth=0;
 for(let i=start;i<cpp.length;++i){if(cpp[i]==='{')++depth;if(cpp[i]==='}'&&--depth===0)return cpp.slice(start,i+1);}
 throw Error(marker);
}
function translate(s){
 return s.replace(/const (?:uint\d+_t|size_t|unsigned long|bool) /g,'const ')
  .replace(/\b(?:uint\d+_t|size_t|unsigned long|bool|int) /g,'let ')
  .replace(/static_cast<int>\(/g,'Math.trunc(')
  .replace(/&(?:actionMux|stateSaveMux)/g,'0')
  .replace(/for \(const auto& editor : controlEditors\)/g,'for (const editor of controlEditors)')
  .replace('controlEditors[freeSlot] = {clientId, true}','controlEditors[freeSlot] = {clientId, active:true}')
  .replace('StateStorage::instance().save()','save()');
}
const queueBody=translate(body('bool queuePlayerCommand('))
 .replace('QueuedPlayerAction action;','const action = newAction();')
 .replace(/\.is<(int|bool)>\(\)/g,'.is("$1")').replace(/\.as<(int|bool)>\(\)/g,'.as("$1")');
const tail=body('static void executeQueuedAction(');
const persistence=tail.slice(tail.indexOf('if ((changed && action.persistState)'),-1);
const defaults=[...cpp.match(/struct QueuedPlayerAction \{([^]*?)\n\};/)[1].matchAll(/(?:QueuedActionType|bool|int) (\w+) = ([^;]+);/g)]
 .map(m=>m[1]+':'+m[2]).join(',');
function harness(){
 const c=vm.createContext({Math,now:0,saves:0,broadcasts:0});
 c.millis=()=>c.now;c.portENTER_CRITICAL=c.portEXIT_CRITICAL=()=>{};
 c.save=()=>++c.saves;c.broadcastState=()=>++c.broadcasts;
 vm.runInContext([
  'const ACTION_NONE=0,ACTION_COMMAND=1,ACTION_QUEUE_SIZE=12;',
  'let actionHead=0,actionTail=0,actionCount=0,actionQueue=Array(12);',
  'let stateSavePending=false,stateSaveDue=0,controlEditors=Array.from({length:8},()=>({clientId:0,active:false}));',
  'function newAction(){return {'+defaults+'};}',
  'function isPureVolumeAction(action) '+body('static bool isPureVolumeAction('),
  'function enqueuePlayerAction(action) '+translate(body('static void enqueuePlayerAction(')),
  'function queuePlayerCommand(cmd) '+queueBody,
  'function scheduleStateSave() '+translate(body('static void scheduleStateSave(')),
  'function controlsBeingEditedLocked() '+translate(body('static bool controlsBeingEditedLocked(')),
  'function setWebControlEditing(clientId,editing) '+translate(body('static void setWebControlEditing(')),
  'function flushScheduledStateSave(force=false) '+translate(body('static void flushScheduledStateSave(')),
  'function executePersistence(action,changed){'+persistence+'}',
  'function ordered(){return Array.from({length:actionCount},(_,i)=>({...actionQueue[(actionTail+i)%12]}));}'
 ].join('\n'),c);
 c.command=data=>c.queuePlayerCommand(new Proxy({}, {get:(_target,key)=>({
  is:type=>type==='bool'?typeof data[key]==='boolean':Number.isInteger(data[key]),
  as:()=>data[key]
 })}));
 return c;
}
test('live volume, EQ and balance commands broadcast RAM changes without requesting flash writes',()=>{
 for(const value of [{volume:50},{eqLow:3,eqMid:-1,eqHigh:2},{balance:-40}]){
  const h=harness();h.command({...value,persist:false});const a=h.ordered()[0];
  assert.equal(a.persistState,false);assert.equal(a.forceStateSave,false);
  h.executePersistence(a,true);h.now=10000;h.flushScheduledStateSave();
  assert.equal(h.saves,0);assert.equal(h.broadcasts,1);
 }
});
test('release persists and acknowledges even when the final value already equals the preview',()=>{
 const h=harness();h.command({volume:66,persist:true});const a=h.ordered()[0];
 h.executePersistence(a,false);assert.equal(h.broadcasts,1);
 h.now=799;h.flushScheduledStateSave();assert.equal(h.saves,0);
 h.now=800;h.flushScheduledStateSave();assert.equal(h.saves,1);
 h.flushScheduledStateSave();assert.equal(h.saves,1);
});
test('legacy/MQTT commands keep persistence; preview cannot suppress station or play saves',()=>{
 for(const cmd of [{volume:66},{volume:66,play:true,persist:false},{station:1,persist:false}]){
  const h=harness();h.command(cmd);const a=h.ordered()[0];assert.equal(a.persistState,true);
  h.executePersistence(a,true);h.now=800;h.flushScheduledStateSave();assert.equal(h.saves,1);
 }
});
test('coalescing cannot cross a release or another player command',()=>{
 const h=harness();
 h.command({volume:10,persist:false});h.command({volume:20,persist:false});
 h.command({volume:20,persist:true});h.command({volume:30,persist:false});h.command({volume:40,persist:false});
 assert.deepEqual(Array.from(h.ordered(),a=>[a.volume,a.forceStateSave]),[[20,false],[20,true],[40,false]]);
 h.command({station:2});h.command({volume:55,persist:false});
 assert.deepEqual(Array.from(h.ordered(),a=>a.hasStation?'station':a.volume),[20,20,40,'station',55]);
});
test('a new drag pauses a previously pending save even through long stationary holds',()=>{
 const h=harness();h.scheduleStateSave();h.now=700;h.setWebControlEditing(4,true);
 h.now=5000;h.flushScheduledStateSave();assert.equal(h.saves,0);
 h.setWebControlEditing(4,false);h.now=5799;h.flushScheduledStateSave();assert.equal(h.saves,0);
 h.now=5800;h.flushScheduledStateSave();assert.equal(h.saves,1);
});
test('one client release or disconnect cannot release another client editor',()=>{
 const h=harness();h.scheduleStateSave();h.setWebControlEditing(1,true);h.setWebControlEditing(2,true);
 h.now=2000;h.setWebControlEditing(1,false);h.flushScheduledStateSave();assert.equal(h.saves,0);
 h.now=3000;h.setWebControlEditing(2,false);h.now=3800;h.flushScheduledStateSave();assert.equal(h.saves,1);
 assert.match(cpp,/WS_EVT_DISCONNECT\) \{ setWebControlEditing\(client->id\(\), false\)/);
});
test('explicit forced shutdown save is still allowed while a client is editing',()=>{
 const h=harness();h.scheduleStateSave();h.setWebControlEditing(1,true);h.flushScheduledStateSave(true);
 assert.equal(h.saves,1);
});
test('disconnecting a passive viewer does not postpone a pending committed write',()=>{
 const h=harness();h.scheduleStateSave();h.now=700;h.setWebControlEditing(99,false);
 h.now=800;h.flushScheduledStateSave();assert.equal(h.saves,1);
});
test('empty commit is rejected and the new capability is advertised without changing other command defaults',()=>{
 const h=harness();assert.equal(h.command({persist:true}),false);assert.equal(h.ordered().length,0);
 assert.match(cpp,/doc\["transientPlayerControls"\] = true/);
 assert.match(cpp,/cmd\["controlEdit"\]\.is<bool>\(\)/);
});
