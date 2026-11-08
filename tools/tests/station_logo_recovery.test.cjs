const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=fs.readFileSync(path.resolve(__dirname,'../../data/app.js'),'utf8');
function harness({present=[],results=[],edited=false}={}){
 const saves=[],queries=[],pending=[],warnings=[];
 const station={id:6,name:'Rádió 1',url:'https://icast.connectmedia.hu/5201/live.mp3',logo:'/logos/station-6-radio-1.png'};
 const c=vm.createContext({URL,URLSearchParams,AbortController,stations:[station],stationLogoRepairAttempts:new Set(),stationLogoRepairRunning:false,
  window:{SRUI:{otaBusy:false}},$:()=>({value:edited?'6':''}),setTimeout:()=>1,clearTimeout(){},
  remoteUrl:s=>/^https?:\/\//i.test(s),RADIO_BROWSER_SEARCH_URL:'https://de1.api.radio-browser.info/json/stations/search',
  console:{warn:(...a)=>warnings.push(a)},loadStations:async()=>{},
  saveStationData:()=>assert.fail('logo repair must never rewrite station metadata'),
  onlineStationLogoThumbnail:()=>'',
  uploadStationLogo:async(id,source)=>{saves.push({id,source});return station.logo;},
  fetch:async url=>{if(url==='/api/logos')return{ok:true,json:async()=>({logos:present.map(path=>({path}))})};
   queries.push(url);if(pending.length)await pending.shift()();return{ok:true,json:async()=>results};}
 });
 vm.runInContext(app.slice(app.indexOf('function stationLogoLookupUrl('),app.indexOf('function stationLogoPaths(')),c);
 return{c,station,saves,queries,pending,warnings};
}
const matching={url:'https://icast.connectmedia.hu/5201/live.mp3',favicon:'https://radio1.hu/logo.png'};
test('a lost generated PNG is repaired in place from an exact stream match, with the same station identity',async()=>{
 const h=harness({results:[{...matching,favicon:''},matching]});await h.c.repairMissingStationLogos();
 assert.equal(h.saves.length,1);assert.equal(h.saves[0].id,6);assert.equal(h.station.name,'Rádió 1');
 assert.equal(h.station.url,matching.url);assert.equal(h.saves[0].source,matching.favicon);
 assert.match(h.queries[0],/\/byurl\?url=/);await h.c.repairMissingStationLogos();assert.equal(h.saves.length,1);
});
test('existing local images, custom filenames and intentional missing-logo stations are not replaced',async()=>{
 const h=harness({present:['/logos/station-6-radio-1.png'],results:[matching]});await h.c.repairMissingStationLogos();assert.equal(h.queries.length,0);
 for(const logo of ['/logos/my-personal-logo.png','',matching.favicon]){h.station.logo=logo;await h.c.repairMissingStationLogos();}
 assert.equal(h.saves.length,0);assert.equal(h.queries.length,0);
});
test('an unrelated result or a dead directory never overwrites saved station data',async()=>{
 const h=harness({results:[{...matching,url:'https://icast.connectmedia.hu/other.mp3'}]});await h.c.repairMissingStationLogos();assert.equal(h.saves.length,0);
 const bad=harness();bad.c.fetch=async()=>({ok:false});await bad.c.repairMissingStationLogos();assert.equal(bad.saves.length,0);
});
test('an HTTPS/http spelling difference is accepted only when host, path and query remain identical',async()=>{
 const h=harness({results:[{...matching,url:matching.url.replace('https:','http:')}]});await h.c.repairMissingStationLogos();assert.equal(h.saves.length,1);
});
test('failed direct conversion retries a browser thumbnail and never rewrites station metadata',async()=>{
 const h=harness({results:[matching]});let attempts=0;
 h.c.onlineStationLogoThumbnail=()=> 'https://wsrv.nl/?url=original';
 h.c.uploadStationLogo=async(id,source)=>{h.saves.push({id,source});return ++attempts===1?'':h.station.logo;};
 await h.c.repairMissingStationLogos();assert.equal(attempts,2);assert.equal(h.saves[1].source,'https://wsrv.nl/?url=original');
});
test('recovery skips OTA, private or signed streams, an open editor, and data changed while awaiting the directory',async()=>{
 const ota=harness({results:[matching]});ota.c.window.SRUI.otaBusy=true;await ota.c.repairMissingStationLogos();assert.equal(ota.queries.length,0);
 for(const url of ['http://192.168.0.1/live','http://radio.local/live','https://radio.example/live?token=secret']){
  const h=harness({results:[matching]});h.station.url=url;await h.c.repairMissingStationLogos();assert.equal(h.queries.length,0);
 }
 const editor=harness({results:[matching],edited:true});await editor.c.repairMissingStationLogos();assert.equal(editor.saves.length,0);
 const changed=harness({results:[matching]});changed.pending.push(()=>{changed.station.name='User edit';});await changed.c.repairMissingStationLogos();assert.equal(changed.saves.length,0);
});

test('PNG uploads retain this station\'s generated filename after renaming, without overwriting unrelated or custom paths',()=>{
 const web=fs.readFileSync(path.resolve(__dirname,'../../src/web/web_server.cpp'),'utf8');
 const start=web.indexOf('static String stationLogoUploadPath('),tail=web.indexOf('\nstatic int stationIdFromLogoUploadPath',start);
 let code=web.slice(web.indexOf('{',start),tail).trim();
 code=code.replace('Station station;','const station={};').replace('String slug;','let slug="";')
  .replace('StationManager::instance().getStation','getStation').replace(/const String /g,'const ').replace(/\bString path/g,'let path')
  .replace(/\.length\(\)/g,'.length');
 const run=(logo,id=6)=>new Function('id','getStation','stationNameSlug',code)(id,(_id,station)=>{station.name='Renamed';station.logo=logo;return true;},()=> 'renamed');
 assert.equal(run('/logos/station-6-radio-1.png'),'/logos/station-6-radio-1.png');
 assert.equal(run('/logos/station-6.png'),'/logos/station-6.png');
 for(const path of ['/logos/custom.png','/logos/station-7-other.png','/logos/station-6-../other.png','https://origin.example/logo.png']){
  assert.equal(run(path),'/logos/station-6-renamed.png');
 }
});
