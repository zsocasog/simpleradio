const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),web=fs.readFileSync(path.join(root,'src/web/web_server.cpp'),'utf8');
function body(s,marker){const b=s.indexOf('{',s.indexOf(marker));let depth=0;for(let i=b;i<s.length;i++){if(s[i]==='{')depth++;if(s[i]==='}'&&!--depth)return s.slice(b,i+1);}throw Error(marker);}
function harness(){
 const sent=[];
 const c=vm.createContext({active:0,stationSaveImageHolds:0,stationImageHead:0,stationImageTail:0,stationImageCount:0,stationImageConnected:0,
  STATION_IMAGE_QUEUE_SIZE:8,stationImageQueue:Array(8).fill(null),allocationOk:true,otaUploadActive:false,rebootPending:false,
  storedReadInProgress:{store(v){c.reading=v;}},allocate:()=>c.allocationOk?{counted:false,admitted:false,cancelled:false}:null,
  sendStationImage:r=>{assert.equal(c.reading,true);sent.push(r.id);c.duringPrepare?.(r);},sendDeferredReply:(r,response)=>r.send(response)});
 const translate=s=>s.replace(/port(?:ENTER|EXIT)_CRITICAL\(&stationImageMux\);/g,'')
  .replace('StationImageLease job(new (std::nothrow) StationImageJob);','const job=allocate();')
  .replace('StationImageLease job;','let job=null;')
  .replace(/uint8_t processed/g,'let processed').replace(/bool (queued|cancelled)/g,'let $1')
  .replace('job.swap(stationImageQueue[stationImageHead]);','job=stationImageQueue[stationImageHead];stationImageQueue[stationImageHead]=null;')
  .replace(/stationImageActive.load\(\)/g,'active').replace(/stationSaveImageHolds.load\(\)/g,'stationSaveImageHolds')
  .replace(/stationImageActive/g,'active').replace(/->/g,'.').replace(/job.get\(\)/g,'job')
  .replace('if (auto request = job.request.lock()) {','const request=job.request.lock(); if(request) {')
  .replace(/request.get\(\)/g,'request').replace(/nullptr/g,'null').replace(/\[job\]\(\)/g,'()=>');
 vm.runInContext('function finishStationImage(job)'+translate(body(web,'static void finishStationImage(StationImageJob* job) {'))+
  '\nfunction dispatch()'+translate(body(web,'static void dispatchStationImages() {'))+
  '\nfunction queue(request)'+translate(body(web,'static void queueStationImage(')),c);
 const request=(id)=>({id,connected:true,replies:[],hasParam:()=>true,callback:null,
  onDisconnect(fn){this.callback=fn;},pause(){return {lock:()=>this.connected?this:null};},
  beginResponse:code=>code,send(code){this.replies.push(code);},
  disconnect(){if(this.connected){this.connected=false;this.callback?.();}}});
 return {c,sent,request};
}

test('network callbacks only enqueue; Main prepares one snapshot per loop and holds admission until disconnect',()=>{
 const h=harness(),r=Array.from({length:6},(_,i)=>h.request(i));r.forEach(x=>h.c.queue(x));
 assert.deepEqual(h.sent,[]);assert.equal(h.c.active,0);assert.equal(h.c.stationImageCount,6);
 h.c.dispatch();assert.deepEqual(h.sent,[0]);h.c.dispatch();assert.deepEqual(h.sent,[0,1]);assert.equal(h.c.active,2);
 h.c.dispatch();r[0].disconnect();assert.equal(h.c.active,1);assert.deepEqual(h.sent,[0,1]);
 h.c.dispatch();assert.equal(h.c.active,2);assert.deepEqual(h.sent,[0,1,2]);
 r.forEach(x=>x.disconnect());h.c.dispatch();assert.equal(h.c.active,0);assert.equal(h.c.stationImageCount,0);assert.equal(h.c.stationImageConnected,0);
});

test('total active and queued connections stay bounded to eight; cancelled entries release capacity once reaped',()=>{
 const h=harness(),r=Array.from({length:8},(_,i)=>h.request(i));r.forEach(x=>h.c.queue(x));
 h.c.dispatch();h.c.dispatch();const extra=h.request(11);h.c.queue(extra);assert.deepEqual(extra.replies,[503]);extra.disconnect();
 assert.equal(h.c.stationImageConnected,8);r[2].disconnect();r[0].disconnect();h.c.dispatch();
 assert.deepEqual(h.sent,[0,1,3]);assert.equal(h.c.active,2);assert.equal(h.c.stationImageConnected,6);
 const next=h.request(12);h.c.queue(next);assert.equal(next.replies.length,0);
 r.forEach(x=>x.disconnect());next.disconnect();h.c.dispatch();assert.equal(h.c.active,0);assert.equal(h.c.stationImageCount,0);assert.equal(h.c.stationImageConnected,0);
});

test('invalid and allocation-failed requests are rejected without pausing or consuming admission',()=>{
 const h=harness(),r=h.request(1);r.pause=()=>{throw Error('must not pause');};r.hasParam=()=>false;h.c.queue(r);
 assert.deepEqual(r.replies,[400]);r.hasParam=()=>true;h.c.allocationOk=false;h.c.queue(r);
 assert.deepEqual(r.replies,[400,503]);assert.equal(h.c.active,0);assert.equal(h.c.stationImageCount,0);
});

test('disconnect while Main copies an image releases exactly once and never dispatches recursively',()=>{
 const h=harness(),a=h.request(1),b=h.request(2);h.c.queue(a);h.c.queue(b);
 h.c.duringPrepare=r=>{r.disconnect();r.callback();assert.equal(h.c.active,0);};h.c.dispatch();
 assert.deepEqual(h.sent,[1]);assert.equal(h.c.active,0);assert.equal(h.c.stationImageConnected,1);assert.equal(h.c.stationImageCount,1);
 h.c.duringPrepare=null;h.c.dispatch();b.disconnect();assert.equal(h.c.active,0);assert.equal(h.c.stationImageConnected,0);
});

test('Main publishes deferred immutable replies, while EOF is independent of TCP admission',()=>{
 assert.match(body(web,'void webServerLoop()'),/dispatchStationImages/);
 for(const marker of ['static void queueStationImage(','static void finishStationImage(StationImageJob* job) {']){
  assert.doesNotMatch(body(web,marker),/dispatchStationImages|sendStationImage/);
 }
 const send=body(web,'static void sendStationImage(');assert.doesNotMatch(send,/request->send\(/);assert.match(send,/sendDeferredReply/);
 const dispatch=body(web,'static void dispatchStationImages() {');assert.doesNotMatch(dispatch,/onDisconnect|client\(\)/);
 assert.ok(dispatch.indexOf('storedReadInProgress.store(true)')<dispatch.indexOf('otaUploadActive'));
 assert.ok(dispatch.indexOf('sendStationImage')<dispatch.indexOf('storedReadInProgress.store(false)'));
 for(const name of ['station_web_image_response.h','station_artwork_response.h']){
  const response=fs.readFileSync(path.join(root,'src/web',name),'utf8');assert.doesNotMatch(response,/stationImageActive|ImageAdmission|dispatchStationImages/);
 }
});

test('a save holds preparation only until its job completes; cancellation can still be reaped',()=>{
 const h=harness(),a=h.request(1),b=h.request(2);h.c.queue(a);h.c.dispatch();h.c.stationSaveImageHolds=1;h.c.queue(b);
 a.disconnect();h.c.dispatch();assert.equal(h.c.active,0);assert.deepEqual(h.sent,[1]);assert.equal(h.c.stationImageCount,1);
 h.c.stationSaveImageHolds=0;h.c.dispatch();assert.deepEqual(h.sent,[1,2]);b.disconnect();assert.equal(h.c.active,0);
 const start=body(web,'static void startStationSaveJob(');assert.ok(start.indexOf('++stationSaveImageHolds')<start.indexOf('pendingStationSave = job'));
 assert.doesNotMatch(start,/onDisconnect/);assert.match(start,/job->imagesHeld = true/);assert.match(web,/if \(imagesHeld\) --stationSaveImageHolds/);
 const c=h.request(3);h.c.stationSaveImageHolds=1;h.c.queue(c);c.disconnect();h.c.dispatch();assert.equal(h.c.stationImageCount,0);
});

test('OTA rejects a queued image before touching unmounted storage and releases its barrier',()=>{
 const h=harness(),a=h.request(1);h.c.queue(a);h.c.otaUploadActive=true;h.c.dispatch();
 assert.deepEqual(h.sent,[]);assert.deepEqual(a.replies,[503]);assert.equal(h.c.reading,false);a.disconnect();assert.equal(h.c.active,0);
});
