const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/web/web_server.cpp'),'utf8');
function body(marker){const start=source.indexOf('{',source.indexOf(marker));let depth=0;for(let i=start;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&!--depth)return source.slice(start,i+1);}throw Error(marker);}
test('hundreds of station/logo saves reuse one internal stack and a single bounded queue',()=>{
 let worker=null,queue=null,creates=0,queueCreates=0;const pending=[],done=[],finished={};
 const stack={bytes:6144,internal:true};
 const boot=body('static bool startStationSaveWorker(').replace(/sizeof\(StationSaveJob\*\)/g,'4').replace(/&stationSave(?:Queue)?Control/g,'null').replace(/nullptr/g,'null');
 const submit=body('static bool submitStationSave(').replace('&job','job');
 const loop=body('static void stationSaveWorkerEntry(').replace('StationSaveJob* job = nullptr;','let job=null;').replace('&job','value=>job=value');
 const create=new Function('xQueueCreateStatic','xTaskCreateStaticPinnedToCore','xQueueReceive','xQueueSend','stationSaveTask','stack',`
 let stationSaveWorker=null,stationSaveQueue=null;
 const stationSaveQueueStorage={},STATION_SAVE_TASK_STACK=6144,stationSaveStack=stack,tskNO_AFFINITY=-1,portMAX_DELAY=Infinity,pdTRUE=1;
 function stationSaveWorkerEntry()${loop}
 return {boot()${boot},submit(job)${submit},run(){stationSaveWorkerEntry();}};
 `)((n,bytes)=>{assert.equal(n,1);assert.equal(bytes,4);queueCreates++;return queue={};},
 (_fn,name,bytes,param,priority,actualStack,_tcb,core)=>{creates++;assert.equal(name,'station-save');assert.equal(bytes,6144);assert.equal(param,null);assert.equal(priority,0);assert.equal(core,-1);assert.equal(actualStack,stack);return worker={};},
 (_q,set,wait)=>{assert.equal(wait,Infinity);if(!pending.length)throw finished;set(pending.shift());return 1;},
 (_q,job,wait)=>{assert.equal(wait,0);if(pending.length)return 0;pending.push(job);return 1;},job=>done.push(job),stack);
 assert.equal(Boolean(create.submit({id:-1})),false); // C++ bool return converts a null handle.
 for(let i=0;i<200;i++){
  assert.equal(create.boot(),true);const job={id:i,upload:i%2===0};assert.equal(create.submit(job),true);
  assert.equal(create.submit({id:-1}),false);
  try{create.run();}catch(error){if(error!==finished)throw error;}
  assert.equal(done[i],job);
 }
 assert.equal(creates,1);assert.equal(queueCreates,1);assert.ok(worker&&queue);
 assert.doesNotMatch(body('static void dispatchPendingStationSave('),/xTaskCreate|heap_caps_malloc/);
 assert.doesNotMatch(body('static void stationSaveTask('),/vTaskDelete/);
});
