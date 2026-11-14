const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../src/artwork/artwork_http.cpp'),'utf8');
function body(marker){const at=source.indexOf(marker);assert.ok(at>=0);const start=source.indexOf('{',at);let n=0;
 for(let i=start;i<source.length;++i){if(source[i]==='{')++n;if(source[i]==='}'&&!--n)return source.slice(start,i+1);}}
const code=body('bool get(const String&')
 .replace('const ArtworkRamWorkPriority priority;','') // Scheduling has its own nesting/base-priority tests.
 .replace(/const uint32_t /g,'const ').replace('static_cast<uint32_t>(millis() - retryStarted)','((millis() - retryStarted) >>> 0)').replace('1100U','1100')
 .replace('Options options = supplied;','const options={...supplied};')
 .replace('bool settingsInterrupted = false;','const settingsInterrupted={value:false};')
 .replace('!settingsInterrupted ||','!settingsInterrupted.value ||');
function run({paused=true,cancel=false,expired=false,musicbrainz=false}={}){
 let calls=0,now=1000;const supplied={deadlineMs:5000,cancelled:()=>cancel&&calls>0};const response={};
 const getAttempt=(_url,_limit,r,options,flag)=>{++calls;assert.equal(options.deadlineMs,5000);
  if(calls===1){flag.value=paused;r.error='old attempt';r.location='/redirect';now=expired?5000:1500;return false;}
  if(musicbrainz)assert.ok(now>=2600,'provider spacing was bypassed by transport retry');
  assert.equal(r.error,'');assert.equal(r.location,'');return true;};
 const get=new Function('getAttempt','expired','millis','REQUEST_MS','networkGate','WiFi','WL_CONNECTED','host','vTaskDelay','settingsYields',`return function(url,limit,response,supplied)${code}`)
  (getAttempt,d=>now>=d,()=>now,12000,{audioReserved:()=>false},{status:()=>1},1,()=>musicbrainz?'musicbrainz.org':'local',()=>{++now;},{fetch_add(){}});
 return {ok:get('http://same-url',1000,response,supplied),calls};
}
test('settings pause retries the same GET after owner cleanup without resetting its original deadline',()=>{
 assert.deepEqual(run(),{ok:true,calls:2});
 const attempt=body('static bool getAttempt(');assert.match(attempt,/BackgroundNetworkScope network\(options\)/);
 assert.match(attempt,/settingsInterrupted = transfer.settingsInterrupted/);
});
test('ordinary network failure is not retried as a save pause',()=>assert.deepEqual(run({paused:false}),{ok:false,calls:1}));
test('cooperative transport retry retains MusicBrainz request spacing',()=>assert.deepEqual(run({musicbrainz:true}),{ok:true,calls:2}));
test('track cancellation or original deadline expiry during the pause ends retry',()=>{
 assert.deepEqual(run({cancel:true}),{ok:false,calls:1});assert.deepEqual(run({expired:true}),{ok:false,calls:1});
});
