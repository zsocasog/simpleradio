const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const csv=require('../../data/station-playlist.js');
const manager=fs.readFileSync(path.resolve(__dirname,'../../src/stations/station_manager.cpp'),'utf8');
const web=fs.readFileSync(path.resolve(__dirname,'../../src/web/web_server.cpp'),'utf8');
function body(source,marker){const at=source.indexOf('{',source.indexOf(marker));let depth=0;for(let i=at;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&!--depth)return source.slice(at,i+1);}throw Error(marker);}
const statuses=Object.fromEntries(['Ok','Invalid','Conflict','Limit','Busy','Memory','WriteFailed'].map(x=>[x,x]));
function harness(original,options={}){
  // Execute the production transaction body. Only ArduinoJson, lock, String
  // and flash primitives are adapted, so failure/publication paths are real.
  const code=body(manager,'StationImportStatus StationManager::importStations(')
    .replace('using namespace StationImportPolicy;','')
    .replace('result = {};','Object.assign(result,{added:0,skipped:0,total:0,revision:0});')
    .replace('StationWriteLock writeLock;','const writeLock={ok:()=>!env.busy};')
    .replace(/StationLock lock(?:\(portMAX_DELAY\))?;/g,'const lock={ok:()=>true};')
    .replace('JsonDocument next(&jsonAllocator_);','let next;')
    .replace('JsonArrayConst original;','let original;')
    .replace('if (!next.set(_doc)) return StationImportStatus::Memory;','if(env.copyFails)return StationImportStatus::Memory;next=structuredClone(_doc);')
    .replace('static_cast<const JsonDocument&>(_doc)["stations"].as<JsonArrayConst>()','(_doc.stations || [])')
    .replace('JsonArray destination = replace ? next["stations"].to<JsonArray>() : next["stations"].as<JsonArray>();','let destination=replace ? (next.stations=[]) : next.stations;')
    .replace('if (destination.isNull()) destination = next["stations"].to<JsonArray>();','if(!destination)destination=next.stations=[];')
    .replace(/for \(Json(?:Object|Variant)Const (\w+) : (\w+)\)/g,'for (const $1 of $2)')
    .replace('!value.is<JsonObjectConst>()','!value || typeof value !== "object" || Array.isArray(value)')
    .replace('!value["name"].is<const char*>()','typeof value["name"] !== "string"')
    .replace('!value["url"].is<const char*>()','typeof value["url"] !== "string"')
    .replace('const JsonString rawName = value["name"].as<JsonString>(), rawUrl = value["url"].as<JsonString>();','const rawName=value.name,rawUrl=value.url;')
    .replace('const auto nameView = trim({rawName.c_str(), rawName.size()}), urlView = trim({rawUrl.c_str(), rawUrl.size()});','const nameView=trim(rawName),urlView=trim(rawUrl);')
    .replace('const String name(nameView.data(), nameView.size()), url(urlView.data(), urlView.size());','const name=nameView,url=urlView;')
    .replace('JsonObjectConst previous;','let previous=null;')
    .replace('JsonObject added = destination.add<JsonObject>();','const added={};destination.push(added);')
    .replace(/\.as<int>\(\)/g,'').replace(/\.c_str\(\)/g,'')
    .replace(/incoming.isNull\(\)/g,'!Array.isArray(incoming)').replace(/previous.isNull\(\)/g,'(previous===null)')
    .replace(/\.size\(\)/g,'.length').replace('next.overflowed()','env.memoryFail')
    .replace(/\| ""/g,'?? ""').replace(/StationImportStatus::/g,'status.')
    .replace(/\bint /g,'let ').replace(/\bbool /g,'let ')
    .replace('swap(_doc, next);','[_doc,next]=[next,_doc];');
  const env={...options},writes=[];
  const factory=new Function('initial','env','status','csv','structuredClone',`
    let _doc=structuredClone(initial),_revision=7;
    const MAX_STATIONS=500,INT_MAX=2147483647,max=Math.max;
    const trim=s=>s.replace(/^[ \\t\\r\\n]+|[ \\t\\r\\n]+$/g,"");
    const validName=s=>csv.valid(s,"https://example.org")!=="nameError",validUrl=s=>csv.valid("Name",s)==="";
    const sameUrl=(a,b)=>trim(a)===trim(b),writes=[];
    const writeJsonAtomic=(file,next,pretty)=>{writes.push(structuredClone(next));if(env.observe)env.observe(structuredClone(_doc));return !env.ioFails;};
    return {run(incoming,replace=false,expectedRevision=7){const result={};const outcome=(function()${code})();return {status:outcome,result};},
      get doc(){return structuredClone(_doc);},get revision(){return _revision;},writes};
  `);
  return factory(original,env,statuses,csv,structuredClone);
}
const old={schema:1,stations:[{id:2,name:'Playing',url:'https://example.org/a',logo:'/logos/own.png'},
  {id:9,name:'Second',url:'https://example.org/b',logo:'/logos/b.png'}]};
test('append writes one complete snapshot, preserves old identities/logos/order, and skips duplicates',()=>{
  const h=harness(old),r=h.run([{name:'Renamed',url:'https://example.org/a'},{name:'New',url:'https://example.org/c'},{name:'Again',url:'https://example.org/c'}]);
  assert.equal(r.status,'Ok');assert.deepEqual(r.result,{added:1,skipped:2,total:3,revision:8});
  assert.equal(h.writes.length,1);assert.deepEqual(h.doc.stations.slice(0,2),old.stations);
  assert.deepEqual(h.doc.stations[2],{id:10,name:'New',url:'https://example.org/c',logo:''});assert.equal(h.doc.schema,1);
});
test('replace only retains CSV membership/order while reusing matching ID/logo and never recycling removed IDs',()=>{
  const h=harness(old),r=h.run([{name:'Updated name',url:'https://example.org/b'},{name:'Fresh',url:'https://example.org/c'},{name:'Again',url:'https://example.org/b'}],true);
  assert.equal(r.status,'Ok');assert.equal(h.writes.length,1);assert.deepEqual(r.result,{added:2,skipped:1,total:2,revision:8});
  assert.deepEqual(h.doc.stations,[{...old.stations[1],name:'Updated name'},{id:10,name:'Fresh',url:'https://example.org/c',logo:''}]);
});
test('the published list remains readable during persistence, and a flash failure leaves it intact',()=>{
  for(const ioFails of [true,false]){
    let seen;const h=harness(old,{ioFails,observe:x=>seen=x}),r=h.run([{name:'New',url:'https://example.org/new'}],true);
    assert.deepEqual(seen,old);assert.equal(r.status,ioFails?'WriteFailed':'Ok');
    assert.equal(h.revision,ioFails?7:8);if(ioFails)assert.deepEqual(h.doc,old);
  }
});
test('stale preview, invalid later rows, allocation failure, empty and oversized imports never write',()=>{
  for(const [input,replace,revision,options,status] of [
    [[{name:'N',url:'https://example.org/new'}],true,6,{},'Conflict'],
    [[{name:'N',url:'https://example.org/new'}, {name:'Bad',url:'javascript:x'}],true,7,{},'Invalid'],
    [[{name:'Name\0other',url:'https://example.org/new'}],true,7,{},'Invalid'],
    [[{name:'N',url:'https://example.org/new'}],false,7,{copyFails:true},'Memory'],
    [[{name:'N',url:'https://example.org/new'}],false,7,{memoryFail:true},'Memory'],
    [[{name:'N',url:'https://example.org/new'}],false,7,{busy:true},'Busy'],
    [[],true,7,{},'Invalid'],[Array(501).fill({name:'N',url:'https://example.org'}),true,7,{},'Limit']]){
    const h=harness(old,options);assert.equal(h.run(input,replace,revision).status,status);assert.equal(h.writes.length,0);assert.deepEqual(h.doc,old);assert.equal(h.revision,7);
  }
});
test('duplicate-only append is a durable no-op; station-ID overflow is rejected',()=>{
  const h=harness(old);assert.deepEqual(h.run([{name:'Old',url:'https://example.org/a'}]).result,{added:0,skipped:1,total:2,revision:7});assert.equal(h.writes.length,0);
  const full=harness({stations:[{id:2147483647,name:'Old',url:'https://example.org/a'}]});
  assert.equal(full.run([{name:'New',url:'https://example.org/new'}],true).status,'Limit');assert.equal(full.writes.length,0);
});
test('imports reuse the resident low-priority save worker, PSRAM admission and disconnect ownership',()=>{
  assert.match(body(web,'static void stationSaveTask('),/else if \(job->importData\) job->saved = storeStationImport\(\*job\)/);
  const receive=body(web,'static void receiveStationImport(');
  assert.match(receive,/MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT/);assert.match(receive,/request->onDisconnect/);
  assert.match(receive,/index != upload->received/);assert.match(receive,/len > total - index/);
  assert.doesNotMatch(receive,/deserializeJson|LittleFS|writeJsonAtomic|xTaskCreate/);
  assert.match(body(web,'static void queueStationImport('),/request->_tempObject = nullptr/);
  assert.match(body(web,'static void reconcileStationImport('),/command\["play"\] = false/);
  assert.match(body(web,'static void reconcileStationImport('),/getStation\(state.stationId, current\)/);
});
