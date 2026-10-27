const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test');
const root=path.resolve(__dirname,'../..');
const app=fs.readFileSync(path.join(root,'data/app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'data/index.html'),'utf8');
const attrs=tag=>Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
const sliders=[...html.matchAll(/<input\b[^>]*type="(?:range|color)"[^>]*>/g)].map(m=>attrs(m[0]));
const fields=app.match(/const playerSliderFields = \{[^]*?\n\};/)[0];
const names=['setValue','setText','sliderIsProtected','setConfigValue','beginSliderGesture','announceSliderEditing',
 'resetPlayerSliderCommits','trackSliderInput','finishSliderGesture','queuePlayerPreview','flushPlayerPreview',
 'sendPlayerControls','flushReleasedSliders','acknowledgePlayerSliders','acknowledgeConfigSliders','initSliderControls',
 'sendCommand','setVolume','changeVolume','numberValue','eqValue','setEq','mirrorEq','setBalance','syncBalance','mirrorBalance',
 'clampNumber','percentFrom255','balanceLabel','dbLabel','setPercentLabel','setRawPercentLabel',
 'syncEncoderSensitivity','syncIrSensitivity','syncEqLabels','validHexColor','normalizeHexColor',
 'syncThemeCustomColorFromPicker','syncThemeCustomColorFromText','syncFrontLedColorFromPicker','syncFrontLedColorFromText',
 'collectConfig','postConfig','queueConfigSave','saveConfigNow','previewMeterSensitivity','flushMeterSensitivity',
 'commitMeterSensitivity','applyConfigToUI','updateUI','timeToMinutes','minutesToTime'];
const functions=names.map(name=>{
 const found=app.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));
 assert.ok(found,name);return found[0];
}).join('\n');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function target(){
 const listeners=new Map();
 return {listeners,addEventListener(type,fn,capture=false){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push({fn,capture});},
  fire(type,event={}){const e={type,...event};for(const {fn} of [...listeners.get(type)||[]].sort((a,b)=>Number(b.capture)-Number(a.capture)))fn(e);}};
}
function harness({live=true,hold=false}={}){
 const nodes=new Map(),timers=new Map(),frames=[],requests=[],replies=[],statuses=[];
 let clock=0,nextTimer=1;
 for(const m of html.matchAll(/<[\w-]+\b[^>]*\bid="([^"]+)"[^>]*>/g)){
  const a=attrs(m[0]);const node={...target(),id:a.id,type:a.type||'',checked:false,disabled:false,textContent:'',
   style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},setAttribute(){}};
  let value=a.value||'';Object.defineProperty(node,'value',{get:()=>value,set:v=>{value=String(v);}});
  nodes.set(a.id,node);
 }
 const context=vm.createContext({console,Map,Set,Object,Number,String,Math,URLSearchParams,
  document:{...target(),getElementById:id=>nodes.get(id),querySelectorAll:()=>sliders.map(s=>nodes.get(s.id))},
  window:target(),WebSocket:{OPEN:1},themePresets:{green:{}},irActions:[],inactiveIrActions:[],
  t:(_key,fallback)=>fallback,
  setTimeout:(fn,delay)=>{const id=nextTimer++;timers.set(id,{fn,at:clock+delay});return id;},
  clearTimeout:id=>timers.delete(id),clearInterval(){},
  setConfigSaveState:state=>statuses.push(state),
  updateLastFmDeleteButton(){},updateIrPanel(){},syncEncoderControls(){},syncDisplayFooterMode(){},
  syncDisplayIdleMode(){},syncFrontLedControls(){},syncThemeAccent(){},syncVolumeCurve(){},
  applyThemeAccent(){},normalizeThemeAccent:v=>v||'green',
  updatePlayButtons(){},renderStations(){},updateCover(){},streamConnectionMessage:()=>''});
 context.fetch=(url,options)=>{
  const values=Object.fromEntries(options.body);requests.push({url,values});
  const reply=()=>({ok:true,json:async()=>Object.fromEntries(Object.entries(values).map(([k,v])=>[k,/^-?\d+$/.test(v)?Number(v):v]))});
  return hold&&url==='/api/config/save'?new Promise(resolve=>replies.push(()=>resolve(reply()))):Promise.resolve(reply());
 };
 context.socket={readyState:1,send:text=>frames.push(JSON.parse(text))};
 vm.runInContext([
  'let ws=socket,configSaveTimer,configSaveStatusTimer,configSaving=false,configSavePending=false,deferredConfigAction={};',
  'let configSaveDeferred=false,sliderRevision=0,playerPreviewTimer=null,playerPreviewPending={},sliderEditAnnounced=false;',
  'const sliderGestures=new Map(),sliderDirty=new Map();',fields,
  'let meterSensitivityTimer,meterSensitivityFlight=null,meterSensitivityPending=null;',
  'let meterSensitivityEditing=false,meterSensitivityDirty=false,meterSensitivityRevision=0;',
  'let currentConfig={},configLoaded=false,irPollTimer,selectedIrAction="",playing=false,currentStationId=-1;',
  'let hardwareCapabilities={transientPlayerControls:'+live+',encoder2:{available:false}};',
  'const $=id=>document.getElementById(id);',functions,'initSliderControls();'
 ].join('\n'),context);
 const defaults={brightness:128,dayBrightness:255,nightBrightness:16,displayIdleBrightness:16,
  displayVuSensitivity:100,encoderSensitivity:8,irSensitivity:40,frontLedBrightness:128,frontLedStandbyBrightness:13,
  themeCustomColor:'#a9f7bf',frontLedColor:'#a9f7bf',themeAccent:'custom'};
 context.applyConfigToUI(defaults);context.updateUI({volume:50,eqLow:0,eqMid:0,eqHigh:0,balance:0,stationId:-1,playing:true});
 function fire(id,type,event={}){
  const node=nodes.get(id);node.fire(type,event);
  if(type==='input'){const s=sliders.find(s=>s.id===id);if(s.oninput)vm.runInContext('(function(){'+s.oninput+'}).call($('+JSON.stringify(id)+'))',context);}
 }
 return {context,nodes,timers,frames,requests,replies,statuses,fire,
  run:code=>vm.runInContext(code,context),
  input(id,value){nodes.get(id).value=value;fire(id,'input');},
  down(id,pointerId=1){fire(id,'pointerdown',{pointerId});},
  up(pointerId=1,type='pointerup'){context.document.fire(type,{pointerId});},
  async advance(ms){const end=clock+ms;for(;;){const first=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!first)break;clock=first[1].at;timers.delete(first[0]);first[1].fn();await settle();}clock=end;await settle();},
  saves:()=>requests.filter(r=>r.url==='/api/config/save'),
  commits:()=>frames.filter(f=>f.persist===true),
  previews:()=>frames.filter(f=>f.persist===false)};
}
const finalValue=s=>s.type==='color'?'#123456':s.id==='displayVuSensitivity'?150:s.min==='-12'?3:s.id==='soundBalance'?45:s.id==='encoderSensitivity'?5:s.id==='irSensitivity'?55:75;
test('every range and native color control uses shared release handlers without input autosave',()=>{
 assert.equal(sliders.length,16);assert.equal(sliders.filter(s=>s.type==='range').length,14);
 for(const s of sliders){assert.doesNotMatch(s.oninput,/queueConfigSave|saveConfigNow/);assert.equal(s.onchange,undefined);assert.equal(s.onblur,undefined);}
 assert.match(app,/initSliderControls\(\);/);
});
test('all configuration sliders and color pickers wait through long pauses and save once on release',async()=>{
 for(const s of sliders.filter(s=>!['volume','soundEqLow','soundEqMid','soundEqHigh','soundBalance','displayVuSensitivity'].includes(s.id))){
  const h=harness();if(s.type==='range')h.down(s.id);
  h.input(s.id,finalValue(s));await h.advance(2000);assert.equal(h.saves().length,0,s.id);
  if(s.type==='range')h.up();else h.fire(s.id,'change');
  h.fire(s.id,'change');h.fire(s.id,'blur');await h.advance(140);
  assert.equal(h.saves().length,1,s.id);assert.equal(h.saves()[0].values[s.id],String(finalValue(s)),s.id);
 }
});
test('volume, all EQ bands and balance preview live without persistent commands, then commit once',async()=>{
 for(const s of sliders.filter(s=>['volume','soundEqLow','soundEqMid','soundEqHigh','soundBalance'].includes(s.id))){
  const h=harness();h.down(s.id);h.input(s.id,finalValue(s));await h.advance(80);
  assert.equal(h.previews().length,1,s.id);assert.equal(h.commits().length,0);
  await h.advance(2000);assert.equal(h.commits().length,0);assert.equal(h.saves().length,0);
  h.up();h.fire(s.id,'change');h.fire(s.id,'blur');await h.advance(300);
  assert.equal(h.commits().length,1,s.id);assert.equal(h.saves().length,0,s.id);
 }
});
test('continuous motion is throttled rather than silenced until the pointer stops',async()=>{
 const h=harness();h.down('volume');
 for(let i=0;i<20;++i){h.input('volume',i+10);await h.advance(16);}
 assert.ok(h.previews().length>=3&&h.previews().length<=4);
 assert.equal(h.commits().length,0);h.up();assert.equal(h.commits().length,1);
 assert.equal(h.commits()[0].volume,29);
});
test('keyboard repeat does not save on native change events; key release commits',async()=>{
 for(const id of ['brightness','volume','displayVuSensitivity']){
  const h=harness();h.fire(id,'keydown',{key:'ArrowRight'});
  for(const value of [110,120,130]){h.input(id,value);h.fire(id,'change');await h.advance(300);}
  assert.equal(h.saves().length,0,id);assert.equal(h.commits().length,0,id);
  h.context.document.fire('keyup',{key:'ArrowRight'});await settle();await h.advance(140);
  assert.equal(h.saves().length+h.commits().length,1,id);
 }
});
test('pointer cancel, release outside the slider, and blur share one commit',async()=>{
 for(const type of ['pointerup','pointercancel','windowblur']){
  const h=harness();h.down('brightness',7);h.input('brightness',201);
  if(type==='windowblur')h.context.window.fire('blur');else h.up(7,type);
  h.fire('brightness','blur');h.fire('brightness','change');await h.advance(140);
  assert.equal(h.saves().length,1,type);
 }
});
test('pointer click without an edit causes no save',async()=>{
 const h=harness();h.down('brightness');h.up();h.fire('brightness','change');h.fire('brightness','blur');await h.advance(1000);
 assert.equal(h.saves().length,0);assert.equal(h.commits().length,0);
});
test('right click does not start an editor session',()=>{
 const h=harness();h.fire('brightness','pointerdown',{pointerId:1,button:2});
 assert.equal(h.frames.length,0);
});
test('backgrounding a touch page commits once instead of leaving an editor session active',async()=>{
 const h=harness();h.down('brightness');h.input('brightness',201);
 h.context.document.hidden=true;h.context.document.fire('visibilitychange');
 h.fire('brightness','blur');await h.advance(140);assert.equal(h.saves().length,1);
 assert.equal(h.frames.at(-1).controlEdit,false);
});
test('an in-flight config reply cannot replace a newer drag value or save mid-drag',async()=>{
 const h=harness({hold:true});h.down('brightness');h.input('brightness',20);h.up();await h.advance(140);
 assert.equal(h.saves().length,1);
 h.down('encoderSensitivity');h.input('encoderSensitivity',5);
 h.replies.shift()();await settle();assert.equal(h.nodes.get('encoderSensitivity').value,'5');
 await h.advance(1000);assert.equal(h.saves().length,1);
 h.up();await h.advance(140);assert.equal(h.saves().length,2);
 assert.equal(h.saves()[1].values.encoderSensitivity,'5');h.replies.shift()();await settle();
});
test('an unrelated config save waits for the final active slider',async()=>{
 const h=harness();h.down('volume',1);h.input('volume',66);h.down('brightness',2);h.input('brightness',200);
 h.run('saveConfigNow()');h.up(1);await h.advance(1000);
 h.context.updateUI({playing:true,stationId:-1,volume:66,eqLow:0,eqMid:0,eqHigh:0,balance:0});
 assert.equal(h.saves().length,0);assert.equal(h.commits().length,0);
 h.up(2);await h.advance(140);assert.equal(h.saves().length,1);assert.equal(h.commits().length,1);
});
test('a prior commit can be acknowledged during a new unchanged pointer hold',()=>{
 const h=harness();h.down('volume');h.input('volume',66);h.up();h.down('volume');
 h.context.updateUI({playing:true,stationId:-1,volume:66});h.up();
 h.context.updateUI({playing:true,stationId:-1,volume:42});
 assert.equal(h.nodes.get('volume').value,'42');assert.equal(h.commits().length,1);
});
test('a saved config revision clears pending state even during an unchanged pointer hold',async()=>{
 const h=harness({hold:true});h.down('brightness');h.input('brightness',20);h.up();await h.advance(140);
 h.down('brightness');h.replies.shift()();await settle();h.up();
 h.context.applyConfigToUI({brightness:88});assert.equal(h.nodes.get('brightness').value,'88');
});
test('stale player echoes cannot move edited or unacknowledged controls',()=>{
 const h=harness();h.down('volume');h.input('volume',66);
 const state={playing:true,stationId:-1,volume:50,eqLow:0,eqMid:0,eqHigh:0,balance:0};
 h.context.updateUI(state);assert.equal(h.nodes.get('volume').value,'66');
 h.up();h.context.updateUI(state);assert.equal(h.nodes.get('volume').value,'66');
 h.context.updateUI({...state,volume:66});h.context.updateUI({...state,volume:42});
 assert.equal(h.nodes.get('volume').value,'42');
});
test('reconnect resubmits released values; old firmware never gets live save traffic',async()=>{
 const h=harness();h.context.socket.readyState=0;h.down('volume');h.input('volume',72);await h.advance(80);h.up();
 assert.equal(h.commits().length,0);
 h.run('resetPlayerSliderCommits()');h.context.socket.readyState=1;h.run('flushPlayerPreview();flushReleasedSliders()');
 assert.equal(h.commits().length,1);assert.equal(h.commits()[0].volume,72);
 const old=harness({live:false});old.down('volume');old.input('volume',62);await old.advance(1000);
 assert.equal(old.frames.length,0);old.up();assert.equal(old.commits().length,1);
});
test('direct volume buttons discard obsolete queued preview values',async()=>{
 const h=harness();h.down('volume');h.input('volume',40);h.context.setVolume(75);await h.advance(80);h.up();
 assert.equal(h.previews().length,0);assert.equal(h.frames.filter(f=>f.volume===75).length,1);
});
test('zero standby brightness survives save acknowledgement and UI refresh',async()=>{
 const h=harness();h.down('displayIdleBrightness');h.input('displayIdleBrightness',0);h.up();await h.advance(140);
 assert.equal(h.nodes.get('displayIdleBrightness').value,'0');
});
