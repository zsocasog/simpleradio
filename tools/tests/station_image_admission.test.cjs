const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),web=fs.readFileSync(path.join(root,'src/web/web_server.cpp'),'utf8');
function body(s,marker){const b=s.indexOf('{',s.indexOf(marker));let depth=0;for(let i=b;i<s.length;i++){if(s[i]==='{')depth++;if(s[i]==='}'&&!--depth)return s.slice(b,i+1);}throw Error(marker);}
function harness(){
 const sent=[],disposed=[];
 const c=vm.createContext({playing:true,active:0,stationSaveImageHolds:0,stationImageHead:0,stationImageTail:0,stationImageCount:0,
  STATION_IMAGE_QUEUE_SIZE:8,stationImageQueue:Array(8).fill(null),allocationOk:true,
  allocate:()=>c.allocationOk?{}:null,dispose:job=>disposed.push(job),sendStationImage:r=>sent.push(r.id)});
 const translate=s=>s.replace(/port(?:ENTER|EXIT)_CRITICAL\(&stationImageMux\);/g,'')
  .replace('auto* job = new (std::nothrow) StationImageJob;','const job=allocate();')
  .replace(/const uint32_t /g,'const ').replace(/uint8_t processed/g,'let processed').replace(/bool queued/g,'let queued')
  .replace('StationImageJob* pending = nullptr;','let pending=null;')
  .replace('std::unique_ptr<StationImageJob> job(pending);','const job=pending;dispose(job);')
  .replace('PlayerState::instance().snapshot().playing','playing').replace(/stationImageActive.load\(\)/g,'active')
  .replace(/stationSaveImageHolds.load\(\)/g,'stationSaveImageHolds')
  .replace(/stationImageActive/g,'active').replace(/->/g,'.')
  .replace('if (auto request = job.request.lock()) {','const request=job.request.lock(); if(request) {')
  .replace('request.get()','request').replace(/delete job;/g,'dispose(job);').replace(/nullptr/g,'null')
  .replace(/\[\]\(\)/g,'()=>').replace(/dispatchStationImages\(\);/g,'dispatch();');
 vm.runInContext('function dispatch()'+translate(body(web,'static void dispatchStationImages() {'))+
  '\nfunction queue(request)'+translate(body(web,'static void queueStationImage(')),c);
 const request=(id)=>({id,connected:true,replies:[],hasParam:()=>true,callback:null,
  onDisconnect(fn){this.callback=fn;},client(){return {connected:()=>this.connected};},
  pause(){return {lock:()=>this.connected?this:null};},send(code){this.replies.push(code);},
  disconnect(){if(this.connected){this.connected=false;this.callback?.();}}});
 return {c,sent,disposed,request};
}
test('six clients open one source during playback and wait until TCP completion, including after source EOF',()=>{
 const h=harness(),r=Array.from({length:6},(_,i)=>h.request(i));r.forEach(x=>h.c.queue(x));
 assert.deepEqual(h.sent,[0]);assert.equal(h.c.stationImageCount,5);assert.equal(h.c.active,1);
 h.c.dispatch();assert.deepEqual(h.sent,[0]); // Reading all source bytes is not network completion.
 r[0].disconnect();assert.deepEqual(h.sent,[0,1]);assert.equal(h.c.active,1);
 for(let i=1;i<6;i++)r[i].disconnect();assert.equal(h.c.active,0);assert.equal(h.c.stationImageCount,0);
});
test('idle permits two responses; cancelled queued clients and queue overflow keep ownership bounded',()=>{
 const h=harness();h.c.playing=false;const r=Array.from({length:10},(_,i)=>h.request(i));r.forEach(x=>h.c.queue(x));
 assert.deepEqual(h.sent,[0,1]);assert.equal(h.c.stationImageCount,8);
 const extra=h.request(11);h.c.queue(extra);assert.deepEqual(extra.replies,[503]);
 r[2].disconnect();r[0].disconnect();assert.deepEqual(h.sent,[0,1,3]);assert.equal(h.c.active,2);
 for(const x of r)x.disconnect();assert.equal(h.c.active,0);assert.equal(h.c.stationImageCount,0);
});
test('invalid or allocation-failed requests are not paused or admitted',()=>{
 const h=harness(),r=h.request(1);r.pause=()=>{throw Error('must not pause');};r.hasParam=()=>false;h.c.queue(r);
 assert.deepEqual(r.replies,[400]);r.hasParam=()=>true;h.c.allocationOk=false;h.c.queue(r);
 assert.deepEqual(r.replies,[400,503]);assert.equal(h.c.active,0);assert.equal(h.c.stationImageCount,0);
});
test('main never starts streaming and file EOF cannot release a TCP admission',()=>{
 assert.doesNotMatch(body(web,'void webServerLoop()'),/dispatchStationImages|sendStationImage/);
 assert.match(body(web,'void webServerLoop()'),/reapStationImageRequests/);
 assert.match(body(web,'static void dispatchStationImages() {'),/onDisconnect\(\[\]\(\) \{ --stationImageActive; dispatchStationImages\(\); \}\)/);
 for(const name of ['station_web_image_response.h','station_artwork_response.h']){
  const response=fs.readFileSync(path.join(root,'src/web',name),'utf8');assert.doesNotMatch(response,/stationImageActive|ImageAdmission|dispatchStationImages/);
 }
});
test('a save lets active images drain and queues new streams until its network completion, without reserving another stack',()=>{
 const h=harness(),a=h.request(1),b=h.request(2);h.c.queue(a);h.c.stationSaveImageHolds=1;h.c.queue(b);
 a.disconnect();assert.equal(h.c.active,0);assert.deepEqual(h.sent,[1]);assert.equal(h.c.stationImageCount,1);
 h.c.stationSaveImageHolds=0;h.c.dispatch();assert.deepEqual(h.sent,[1,2]);b.disconnect();assert.equal(h.c.active,0);
 const start=body(web,'static void startStationSaveJob(');
 assert.ok(start.indexOf('++stationSaveImageHolds')<start.indexOf('pendingStationSave = job'));
 assert.match(start,/onDisconnect\(\[\]\(\) \{ --stationSaveImageHolds; dispatchStationImages\(\); \}\)/);
});
