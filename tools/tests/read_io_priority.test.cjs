const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const source=fs.readFileSync(path.join(root,'src/storage/read_io_priority.h'),'utf8');
function body(marker){const begin=source.indexOf('{',source.indexOf(marker));let depth=0;for(let i=begin;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&!--depth)return source.slice(begin,i+1);}throw Error(marker);}
function harness(base,inherited=0){
 const calls=[];const get=(_,status)=>{status.uxBasePriority=base;},set=(_,value)=>{calls.push(value);base=value;};
 const js=s=>s.replace('TaskStatus_t status{};','const status={};').replace('&status','status')
  .replace(/nullptr/g,'null').replace(/previous_/g,'this.previous_').replace(/pdFALSE|eInvalid/g,'0');
 const enter=new Function('vTaskGetInfo','vTaskPrioritySet',js(body('ReadIoPriority()')));
 const leave=new Function('vTaskPrioritySet',js(body('~ReadIoPriority()')));
 return {calls,base:()=>base,effective:()=>Math.max(base,inherited),scope(){const s={previous_:0};enter.call(s,get,set);return ()=>leave.call(s,set);}};
}
test('a high-priority HTTP filesystem call runs below audio and restores its exact base priority',()=>{
 const h=harness(10),leave=h.scope();assert.equal(h.base(),1);leave();assert.equal(h.base(),10);assert.deepEqual(h.calls,[1,10]);
});
test('a background worker with inherited priority is never permanently promoted',()=>{
 const h=harness(0,10),leave=h.scope();assert.equal(h.base(),0);assert.equal(h.effective(),10);leave();assert.equal(h.base(),0);assert.deepEqual(h.calls,[]);
});
test('nested reads and error unwinding preserve the original priority without new tasks or heap',()=>{
 const h=harness(10),outer=h.scope(),inner=h.scope();inner();assert.equal(h.base(),1);
 try{throw Error('read failure');}catch{}finally{outer();}assert.equal(h.base(),10);
 assert.doesNotMatch(source,/malloc|xTaskCreate|vTaskDelay|new |delay\(/);
});
test('metadata probes, directory visits, descriptor opening, reading, seeking and closing all have a scope',()=>{
 const s=fs.readFileSync(path.join(root,'src/storage/read_only_file.h'),'utf8');
 assert.equal((s.match(/SR_READ_IO_SCOPE\(\);/g)||[]).length,7);
 assert.match(s,/fullPath\(absolute, mount, path\)\) return;\s*SR_READ_IO_SCOPE\(\);\s*fd_ = ::open/);
});
