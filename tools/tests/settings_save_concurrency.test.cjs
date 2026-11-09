const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const web = read('src/web/web_server.cpp'), network = read('src/artwork/artwork_network_gate.h');
function body(source, marker) {
  const at = source.indexOf(marker); assert.ok(at >= 0, marker);
  const start = source.indexOf('{', at); let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(marker);
}
class Atomic {
  constructor() { this.value = false; }
  store(x) { this.value = x; }
  load() { return this.value; }
  compare_exchange_strong(expected, value) {
    if (this.value !== expected) return false; this.value = value; return true;
  }
}
const names = ['reserveAudio','releaseAudio','audioReserved','reserveSettingsSave','releaseSettingsSave',
  'settingsSaveReserved','backgroundActive','beginBackground','endBackground'];
const Gate = new Function('Atomic', `return class {
  audio_=new Atomic(); background_=new Atomic(); settingsSave_=new Atomic();
  ${names.map(name => `${name}() ${body(network, name + '(')
    .replace(/\b(audio_|background_|settingsSave_)\b/g, 'this.$1')
    .replace(/\b(audioReserved|settingsSaveReserved|endBackground)\(/g, 'this.$1(')
    .replace('bool expected', 'let expected')}`).join('\n')}
}`)(Atomic);
const translate = source => source.replace(/port(?:ENTER|EXIT)_CRITICAL\(&settingsSaveMux\);/g, '')
  .replace('if (auto* client = request->client()) client->close(true);','if (request->client()) request->client()->close(true);')
  .replace('SettingsSaveJob* job =', 'const job =').replace('delete job;', 'dispose(job);')
  .replace(/if \(auto request = job->request.lock\(\)\)/g, 'if (request = job.request.lock())')
  .replace(/const bool /g, 'const ').replace(/int status/g, 'let status')
  .replace('String response;', 'let response = "";').replace('const String ', 'const ')
  .replace('auto* reply =', 'const reply =').replace(/->/g, '.')
  .replace(/\b(ArtworkHttp|AppConfig|ArtworkCache|StatusLed)::/g, '$1.')
  .replace(/::instance\(\)/g, '.instance()').replace(/nullptr/g, 'null')
  .replace('job.request = request.shared_from_this();', 'job.request = request.weak;');
const queueCode = translate(body(web, 'static bool queueSettingsSave('));
const processCode = translate(body(web, 'static void processSettingsSave('));
const libraryFixture=require('./fixtures/web-request-lifecycle-3.12.1.json');
const memberCode=code=>code.replace(/\b(_sent|_paused|_response|_client|_this)\b/g,'this.$1')
  .replace(/\bclient\(\)->/g,'this.client().').replace(/->/g,'.')
  .replace('delete this._response;','this._response=null;')
  .replace(/(?<![\w.])send\(/g,'this.send(').replace(/(?<![\w.])_send\(/g,'this._send(')
  .replace(/async_ws_log_\w+\([^;]+;/g,'').replace(/T_text_plain/g,'"text/plain"');
function harness() {
  const gate = new Gate(), calls = [], replies = [];
  let alive = true;
  const request = { weak: { expired: () => !alive, lock: () => alive ? request : null },
    _sent:false,_paused:false,_response:null,
    _client:{setRxTimeout(){},close(force){calls.push('close');alive=false;},abort(){calls.push('abort');alive=false;}},
    client(){return this._client;},
    beginResponse: (status, type, text) => ({ status, type, text, headers: {}, addHeader(k,v) { this.headers[k]=v; },
      _sourceValid(){return true;},_respond(){calls.push('reply');replies.push(this);} }) };
  request._this=request.weak;
  for(const method of ['pause','_send','abort'])request[method]=new Function(memberCode(libraryFixture.methods[method])).bind(request);
  const sendObject=new Function('response',memberCode(libraryFixture.methods.send));
  request.send=(reply,type,text)=>sendObject.call(request,typeof reply==='number'?request.beginResponse(reply,type,text):reply);
  const cfg = { lastFmApiKey:'old-key', brightness:200,
    applyJson(doc) { calls.push('apply'); assert.equal(gate.backgroundActive(),false);
      if (!c.valid) return false; this.brightness=doc.brightness; if (doc.key) this.lastFmApiKey=doc.key; return true; },
    save() { calls.push('save'); assert.equal(gate.backgroundActive(),false); return c.saveOk; },
    toJson() { calls.push('serialize'); return JSON.stringify({ brightness:this.brightness }); },
    applyTimeZone() { calls.push('timezone'); } };
  const c = vm.createContext({ pendingSettingsSave:null, otaUploadActive:false, rebootPending:false,
    SETTINGS_SAVE_WAIT_MS:15000, now:100, valid:true, saveOk:true, request:null,
    millis:()=>c.now, dispose:job=>calls.push('dispose'),
    ArtworkHttp:{ reserveSettingsSave:()=>gate.reserveSettingsSave(), releaseSettingsSave:()=>gate.releaseSettingsSave(),
      backgroundNetworkActive:()=>gate.backgroundActive() },
    AppConfig:{ instance:()=>cfg }, ArtworkCache:{ instance:()=>({retryCurrentAlbumLookup:()=>calls.push('retry-album')}) },
    StatusLed:{ instance:()=>({applyConfig:()=>calls.push('led')}) }, requestDisplayConfigRefresh:()=>calls.push('display') });
  vm.runInContext(`function queueSettingsSave(request,job) ${queueCode}
    function processSettingsSave() ${processCode}`,c);
  const job = {doc:{ brightness:80, overflowed:()=>false }, request:null, startedMs:0, replied:false};
  return {c,gate,calls,replies,request,job,cfg, queue:(j=job)=>c.queueSettingsSave(request,j),
    process:()=>c.processSettingsSave(), disconnect:()=>{alive=false;} };
}
test('logged brightness save waits for TLS, then commits once and replies after persistence', () => {
  const h=harness(); assert.equal(h.gate.beginBackground(),true); assert.equal(h.queue(),true);
  h.request._send(); // The real server automatically does this after the handler returns.
  for(let i=0;i<5;i++)h.process();
  assert.deepEqual(h.calls,[]); assert.equal(h.cfg.brightness,200);
  h.gate.endBackground(); h.process();
  assert.equal(h.cfg.brightness,80); assert.equal(h.replies[0].status,200);
  assert.ok(h.calls.indexOf('save')<h.calls.indexOf('reply'));
  assert.equal(h.replies[0].headers.Connection,'close');
  h.process(); assert.equal(h.replies.length,1); assert.equal(h.gate.settingsSaveReserved(),true);
  h.disconnect(); h.process(); assert.equal(h.c.pendingSettingsSave,null);
  assert.equal(h.gate.settingsSaveReserved(),false); assert.equal(h.calls.filter(x=>x==='dispose').length,1);
});
test('disconnect before commit changes nothing and releases reservation exactly once', () => {
  const h=harness(); h.queue(); h.disconnect(); h.process(); h.process();
  assert.deepEqual(h.calls,['dispose']); assert.equal(h.cfg.brightness,200);
  assert.equal(h.gate.beginBackground(),true);
});
test('a duplicate request cannot replace a pending save or release its reservation', () => {
  const h=harness();h.queue();assert.equal(h.queue({...h.job}),false);
  assert.equal(h.c.pendingSettingsSave,h.job);assert.equal(h.gate.settingsSaveReserved(),true);
});
test('OTA/reboot and an overflowed document reject admission without taking a reservation', () => {
  for(const field of ['otaUploadActive','rebootPending']) {
    const h=harness();h.c[field]=true;assert.equal(h.queue(),false);assert.equal(h.gate.settingsSaveReserved(),false);
  }
  const h=harness();h.job.doc.overflowed=()=>true;
  assert.equal(h.queue(),false);assert.equal(h.c.pendingSettingsSave,null);
});
test('validation and storage failures never report success, and release after response drains', () => {
  for(const [field,status] of [['valid',400],['saveOk',500]]) {
    const h=harness();h.c[field]=false;h.queue();h.process();assert.equal(h.replies[0].status,status);
    assert.ok(!h.calls.includes('display'));h.disconnect();h.process();assert.equal(h.gate.settingsSaveReserved(),false);
  }
});
test('waiting times out without opening configuration files and closes a stuck response', () => {
  const h=harness();h.gate.beginBackground();h.queue();h.c.now+=15000;h.process();
  assert.equal(h.replies[0].status,503);assert.ok(!h.calls.includes('save'));
  h.c.now+=15000;h.process();assert.ok(h.calls.includes('close'));h.process();
  assert.equal(h.gate.settingsSaveReserved(),false);
});
test('an OTA that begins while queued cancels persistence and does not strand the gate', () => {
  const h=harness();h.queue();h.c.otaUploadActive=true;h.process();assert.equal(h.replies[0].status,503);
  assert.ok(!h.calls.includes('apply'));h.disconnect();h.process();assert.equal(h.gate.settingsSaveReserved(),false);
});
test('API-key retry and timezone/display changes still follow successful settings commit', () => {
  const h=harness();h.job.doc.key='new-key';h.queue();h.process();
  for(const effect of ['retry-album','timezone','led','display'])assert.ok(h.calls.indexOf(effect)>h.calls.indexOf('save'));
});
test('both gate orderings exclude new background sockets, while an existing request drains normally', () => {
  const a=new Gate();a.reserveSettingsSave();assert.equal(a.beginBackground(),false);
  assert.equal(a.backgroundActive(),false);a.releaseSettingsSave();assert.equal(a.beginBackground(),true);
  const b=new Gate();assert.equal(b.beginBackground(),true);b.reserveSettingsSave();
  assert.equal(b.backgroundActive(),true);b.endBackground();assert.equal(b.beginBackground(),false);
  b.releaseSettingsSave();b.reserveAudio();assert.equal(b.beginBackground(),false);
});
test('HTTP waiting yields to settings completion, and honours audio, cancellation and the original deadline', () => {
  const http=read('src/artwork/artwork_http.cpp');
  const ctor=body(http,'explicit BackgroundNetworkScope(').replace(/\bacquired_/g,'this.acquired_');
  for(const stop of ['none','audio','cancel','deadline']) {
    const gate=new Gate();gate.reserveSettingsSave();if(stop==='audio')gate.reserveAudio();
    let now=0,yields=0;
    const run=new Function('networkGate','expired','WiFi','WL_CONNECTED','vTaskDelay','options',ctor);
    const scope={acquired_:false};
    run.call(scope,gate,d=>d&&now>=d,{status:()=>1},1,()=>{now++;yields++;if(stop==='none')gate.releaseSettingsSave();},
      {deadlineMs:stop==='deadline'?2:100,cancelled:()=>stop==='cancel'});
    assert.equal(scope.acquired_,stop==='none');assert.ok(yields<=2);
  }
});
test('production route only queues; save documents use PSRAM and reject overflow before touching flash', () => {
  const route=web.slice(web.indexOf('server.on("/api/config/save"'),web.indexOf('server.on("/recovery"'));
  assert.doesNotMatch(route,/\.applyJson\(|\.save\(|\.applyTimeZone\(/);
  assert.match(route,/queueSettingsSave\(request, job.get\(\)\)/);
  assert.doesNotMatch(body(web,'static bool queueSettingsSave('),/onDisconnect/);
  const cfg=read('src/config/app_config.cpp'),save=body(cfg,'bool AppConfig::save(');
  assert.match(save,/JsonDocument doc\(&jsonAllocator\)/);
  assert.ok(save.indexOf('if (doc.overflowed()) return false;')<save.indexOf('writeJsonAtomic('));
});
test('the real library reproduces automatic 501 without pause, and production admission prevents it',()=>{
 const old=harness();old.request._send();assert.equal(old.replies[0].status,501);
 const fixed=harness();fixed.queue();fixed.request._send();assert.deepEqual(fixed.replies,[]);
 fixed.process();assert.equal(fixed.replies[0].status,200);assert.equal(fixed.cfg.brightness,80);
});
test('abort on an already-sent response is a real no-op; the settings timeout must force-close it',()=>{
 const h=harness();h.queue();h.process();assert.equal(h.replies[0].status,200);
 h.request.abort();assert.equal(h.request.weak.expired(),false);
 h.c.now+=15000;h.process();assert.equal(h.request.weak.expired(),true);
 h.process();assert.equal(h.gate.settingsSaveReserved(),false);
});
test('the fixture matches the pinned server request lifecycle when dependencies are present',()=>{
 const p=path.join(root,'.pio/libdeps/esp32-s3-devkitc1-n16r8/ESPAsyncWebServer/src/WebRequest.cpp');
 if(!fs.existsSync(p))return;
 const live=fs.readFileSync(p,'utf8');
 for(const [name,marker] of Object.entries(libraryFixture.markers))assert.equal(body(live,marker),libraryFixture.methods[name]);
});
