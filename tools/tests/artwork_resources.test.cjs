const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const root=path.resolve(__dirname,'../..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const http=read('src/artwork/artwork_http.cpp'), cache=read('src/artwork/artwork_cache.cpp');
const web=read('src/web/web_server.cpp'), policy=read('src/artwork/album_art_policy.h');
function body(text,marker){
  const at=text.indexOf(marker);assert.ok(at>=0,marker);
  const start=text.indexOf('{',at);let depth=0;
  for(let i=start;i<text.length;++i){if(text[i]==='{')++depth;if(text[i]==='}'&&--depth===0)return text.slice(start,i+1);}
  throw Error(marker);
}
const ctor=body(http,'TlsPriorityScope() :').replace(/nullptr/g,'null');
const dtor=body(http,'~TlsPriorityScope()').replace(/nullptr/g,'null');
let establish=body(http,'int establish(Connect connectSocket)')
  .replace('TlsPriorityScope priority;','const priority = new Priority(); try {')
  .replace(/const (?:uint32_t|int) /g,'const ').replace(/NetworkClientSecure::stop\(\)/g,'stop()')
  .replace(/sslclient->/g,'sslclient.').replace('sslclient.get()','sslclient')
  .replace(/max<uint32_t>\(/g,'Math.max(')
  .replace('(remaining(transfer.options.deadlineMs, 6000) + 999) / 1000','Math.trunc((remaining(transfer.options.deadlineMs, 6000) + 999) / 1000)');
establish=establish.slice(0,-1)+'} finally { priority.dispose(); } }';
function tls({priority=0,setup=true,handshake=0,services=[true,true,true],budget=35000}={}){
  const c=vm.createContext({priority,events:[],now:0,connectionFailure_:'',_stillinPlainStart:false,
    sslclient:{last_error:0},Math,String,setup,handshake,services:[...services],budget,
    tskIDLE_PRIORITY:0,failures:[],handshakes:0,stops:0});
  c.uxTaskPriorityGet=()=>c.priority;
  c.vTaskPrioritySet=(_task,p)=>{c.priority=p;c.events.push(p);};
  c.transfer={options:{deadlineMs:budget},service:()=>c.services.length?c.services.shift():true};
  c.millis=()=>c.now;
  c.remaining=(_deadline,normal)=>Math.min(normal,c.budget);
  c.setPlainStart=()=>{c._stillinPlainStart=true;};
  c.setHandshakeTimeout=value=>{c.timeout=value;};
  c.stop=()=>{++c.stops;};
  c.failure=(phase,elapsed,code)=>c.failures.push({phase,elapsed,code});
  c.ssl_starttls_handshake=()=>{
    assert.equal(c._stillinPlainStart,true);
    assert.equal(c.priority,Math.max(priority,1));
    ++c.handshakes;c.now+=c.handshake<0?6000:100;return c.handshake;
  };
  c.connectSocket=()=>{assert.equal(c.priority,Math.max(priority,1));c.now+=30;return c.setup;};
  vm.runInContext(`class Priority {
    constructor(){const original_=uxTaskPriorityGet(null);this.original_=original_;${ctor}}
    dispose(){const original_=this.original_;${dtor}}
  }
  function establish(connectSocket) ${establish}`,c);
  c.result=c.establish(c.connectSocket);return c;
}
test('TLS shares display priority only during connection, and restores the idle caller',()=>{
  const c=tls();assert.equal(c.result,1);assert.deepEqual(Array.from(c.events),[1,0]);
  assert.equal(c._stillinPlainStart,false);assert.equal(c.timeout,6);assert.equal(c.stops,0);
});
test('TLS never lowers or raises callers already at display/audio priority',()=>{
  for(const priority of [1,2]){const c=tls({priority});assert.equal(c.result,1);assert.equal(c.priority,priority);assert.equal(c.events.length,0);}
});
test('TCP/setup and TLS handshake failures restore priority and retain the actual phase/code',()=>{
  const setup=tls({setup:false});assert.equal(setup.result,0);assert.equal(setup.handshakes,0);
  assert.equal(setup.failures[0].phase,'TCP/TLS setup');assert.equal(setup.priority,0);
  for(const code of [-1,-0x7f00]){
    const c=tls({handshake:code});assert.equal(c.result,0);assert.equal(c.priority,0);
    assert.equal(c.failures[0].phase,'TLS handshake');assert.equal(c.failures[0].code,code);assert.equal(c.stops,1);
  }
});
test('cancellation cannot expose an unencrypted successful client or leak raised priority',()=>{
  for(const services of [[false],[true,false],[true,true,false]]){
    const c=tls({services});assert.equal(c.result,0);assert.equal(c.priority,0);
    if(services.length<3)assert.equal(c.handshakes,0);
  }
  assert.equal(tls({budget:1500}).timeout,2);
});
test('TLS errors include phase, code and memory; API URLs and audio networking stay unchanged',()=>{
  assert.match(http,/String\(phase\).*code=/);assert.match(http,/largest=/);
  assert.match(http,/client.connectionFailure\(\)/);
  assert.match(http,/SecureArtworkClient client\(transfer\)/);
  assert.match(cache,/https:\/\/ws.audioscrobbler.com/);
  assert.match(cache,/https:\/\/itunes.apple.com/);
  assert.doesNotMatch(http,/mbedtls_platform_set_calloc_free|esp_wifi|WiFi.disconnect|setTxTimeout/);
});
const callback=body(web,'[frame](uint8_t* buffer, size_t maxLen, size_t index) mutable')
  .replace('if (!frame)','if (!frame.current)').replace(/const size_t /g,'const ').replace(/frame->/g,'frame.current.');
function reader(size){
  const source=Uint8Array.from({length:size},(_,i)=>i%251);
  const frame={current:{imageBytes:size,read:(out,n,offset)=>{
    const count=offset>=size?0:Math.min(n,4096,size-offset);out.set(source.subarray(offset,offset+count));return count;
  }},released:0,reset(){this.current=null;++this.released;}};
  const fill=new Function('frame','buffer','maxLen','index',callback);
  return {source,frame,fill:(buffer,n,offset)=>fill(frame,buffer,n,offset)};
}
test('a completed web body releases its slot even if the callback/connection remains alive',()=>{
  const r=reader(19079);let offset=0;const out=[];
  while(offset<r.source.length){const b=new Uint8Array(6000);const n=r.fill(b,b.length,offset);assert.ok(n>0);out.push(...b.subarray(0,n));offset+=n;}
  assert.deepEqual(Uint8Array.from(out),r.source);assert.equal(r.frame.current,null);assert.equal(r.frame.released,1);
  assert.equal(r.fill(new Uint8Array(10),10,offset),0);assert.equal(r.frame.released,1);
});
test('partial TCP sends use the response copy after source lease release',()=>{
  const r=reader(8192);let offset=0;const sent=[];
  while(offset<r.source.length){
    const responseBuffer=new Uint8Array(4096);const n=r.fill(responseBuffer,4096,offset);offset+=n;
    if(offset===r.source.length)assert.equal(r.frame.current,null);
    for(let i=0;i<n;i+=127)sent.push(...responseBuffer.subarray(i,Math.min(i+127,n)));
  }
  assert.deepEqual(Uint8Array.from(sent),r.source);
});
test('JPEG accepts the constrained-memory case while retaining PNG and contiguous-block guards',()=>{
  const constants=[...policy.matchAll(/constexpr size_t (\w+) = ([^;]+);/g)].map(m=>`const ${m[1]}=${m[2]};`).join('\n');
  const code=constants+'\n'+['internalHeadroom','internalBlock','internalReady'].map(name=>{
    const args=name==='internalReady'?'format,freeBytes,largestBlock':'format';
    return `function ${name}(${args}) ${body(policy,name+'(').replace(/Format::/g,'Format.')}`;
  }).join('\n');
  const ready=new Function('Format',code+'; return internalReady;')({Jpeg:1,Png:2});
  assert.equal(ready(1,30000,8000),true);assert.equal(ready(2,30000,8000),false);
  assert.equal(ready(1,23000,8000),false);assert.equal(ready(1,30000,3900),false);
});
test('temporary slot contention retries existing bytes only, with bounded wait and precise reasons',()=>{
  const p=body(cache,'bool ArtworkCache::prepareAlbumMemory(');
  assert.match(p,/retryUntil = millis\(\) \+ 250/);assert.match(p,/failure != AlbumArtStore::ReserveFailure::SlotsBusy/);
  assert.match(p,/RAM reserve failed: %s; internal=%u largest=%u need=%u; PSRAM=%u largest=%u; slots=%ld,%ld published=%d/);
  assert.doesNotMatch(p,/LittleFS|download\(/);
});
test('Deezer stops repeated album connections after a transport failure but not a missing album',()=>{
  const part=cache.slice(cache.indexOf('int lookupStatus = 0;'),cache.indexOf('if (lookupOk &&',cache.indexOf('int lookupStatus = 0;')))
    .replace('int lookupStatus = 0;','let lookupStatus=0;').replace('const bool lookupOk','const lookupOk')
    .replace(/fetchArtworkJson\([^\n]+&lookupStatus\)/,'fetch(code=>lookupStatus=code)');
  const run=new Function('verificationUnavailable','fetch','albumArtTrace',part+';return verificationUnavailable;');
  for(const status of [-1,503,404]){
    let unavailable=false,calls=0;
    for(let i=0;i<2;++i)unavailable=run(unavailable,set=>{++calls;set(status);return false;},()=>{});
    assert.equal(calls,status===404?2:1);
  }
});
