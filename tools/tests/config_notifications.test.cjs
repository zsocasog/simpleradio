const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const test = require('node:test');
const read = name => fs.readFileSync(path.join(__dirname, '../..', name), 'utf8');
const app = read('data/app.js');
const functions = ['loadConfig', 'requestConfigRefresh', 'refreshChangedConfig'].map(name =>
  app.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'))[0]).join('\n');
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  let now = 0, next = 1; const timers = new Map(), reads = [], pending = [], applied = [];
  const c = vm.createContext({ console, Number, Math, ws: {}, currentConfig: {configurationRevision:1},
    configRefreshRevision:0, configRefreshTimer:null, configRefreshBusy:false,
    configSaving:false, configSaveTimer:null, configSaveDeferred:false, sliderGestures:new Map(), document:{hidden:false},
    setTimeout(fn,delay) { const id=next++;timers.set(id,{fn,at:now+delay});return id; }, clearTimeout:id=>timers.delete(id),
    fetch(url) { reads.push(url); return new Promise(resolve=>pending.push(config=>resolve({ok:true,json:async()=>config}))); },
    applyConfigToUI(config) { applied.push(config);c.currentConfig=config; }
  });
  vm.runInContext(functions,c);
  return {c,reads,pending,applied,timers,async advance(ms) {
    const end=now+ms;
    for (;;) { const entry=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;
      now=entry[1].at;timers.delete(entry[0]);entry[1].fn();await settle(); }
    now=end;await settle();
  }};
}
test('device changes coalesce into one config read, without periodic idle requests',async()=>{
  const h=harness();h.c.requestConfigRefresh(2);h.c.requestConfigRefresh(3);await h.advance(120);
  assert.deepEqual(h.reads,['/api/config']);
  h.pending.shift()({configurationRevision:3,displayFooterMode:'datetime'});await settle();await h.advance(10000);
  assert.equal(h.applied[0].displayFooterMode,'datetime');assert.equal(h.reads.length,1);assert.equal(h.timers.size,0);
  for (const revision of [0,-1,NaN,'4',1,2,3])h.c.requestConfigRefresh(revision);
  await h.advance(500);assert.equal(h.reads.length,1);
});
test('a local gesture or save finishes before remote config is fetched',async()=>{
  const h=harness();h.c.sliderGestures.set('brightness',{});h.c.requestConfigRefresh(2);await h.advance(1000);
  assert.equal(h.reads.length,0);h.c.sliderGestures.clear();h.c.configSaving=true;await h.advance(500);
  assert.equal(h.reads.length,0);h.c.configSaving=false;await h.advance(250);
  assert.equal(h.reads.length,1);h.pending.shift()({configurationRevision:2});await settle();
  h.c.configSaving=true;h.c.requestConfigRefresh(3);h.c.currentConfig={configurationRevision:3};h.c.configSaving=false;
  await h.advance(500);assert.equal(h.reads.length,1); // Own save response already contains the change.
});
test('a newer device revision arriving during a read is eventually applied',async()=>{
  const h=harness();h.c.requestConfigRefresh(2);await h.advance(120);h.c.requestConfigRefresh(3);
  h.pending.shift()({configurationRevision:2});await settle();await h.advance(1500);
  assert.equal(h.reads.length,2);h.pending.shift()({configurationRevision:3});await settle();
  assert.equal(h.c.currentConfig.configurationRevision,3);assert.equal(h.timers.size,0);
});
test('old HTTP replies cannot overwrite a newer save or a new WebSocket session',async()=>{
  for (const cause of ['save','session','saving']) {
    const h=harness(), request=h.c.loadConfig();
    if(cause==='save')h.c.currentConfig={configurationRevision:3};
    if(cause==='session')h.c.ws={};
    if(cause==='saving')h.c.configSaving=true;
    h.pending.shift()({configurationRevision:2});await request;
    assert.equal(h.applied.length,0,cause);
  }
});
test('configuration notices are never interpreted as empty playback state',()=>{
  const start=app.indexOf('ws.onmessage = event => {'),end=app.indexOf('\n  };',start);
  const source=app.slice(start,end+5).replace('ws.onmessage = event =>','handler = event =>');
  const changed=[],states=[];
  const c=vm.createContext({Date,JSON,console,lastWsMessageAt:0,handler:null,
    requestConfigRefresh:n=>changed.push(n),updateUI:s=>states.push(s)});
  vm.runInContext(source,c);c.handler({data:JSON.stringify({configurationChanged:true,configurationRevision:4})});
  assert.deepEqual(changed,[4]);assert.deepEqual(states,[]);
  c.handler({data:JSON.stringify({playing:true,volume:30,stationId:1})});assert.equal(states.length,1);
});
test('all successful config saves publish a revision without storing transport metadata in flash',()=>{
  const cpp=read('src/config/app_config.cpp');
  const save=cpp.match(/bool AppConfig::save\(\) \{[^]*?\n\}/)[0];
  assert.ok(save.indexOf('if (!writeJsonAtomic(CONFIG_FILE, doc, true)) return false;')<save.indexOf('configurationRevision.fetch_add'));
  assert.doesNotMatch(save,/doc\["configurationRevision"\]/);
  assert.match(cpp,/doc\["configurationRevision"\] = revision\(\)/);
  const web=read('src/web/web_server.cpp'),loop=web.slice(web.indexOf('void webServerLoop()'),web.indexOf('void webServerBegin()'));
  assert.match(loop,/String notice = PlayerState::instance\(\).toJson\(\)/);
  assert.ok(loop.indexOf('configurationChanged')<loop.indexOf('ws.textAll(notice)'));
});
