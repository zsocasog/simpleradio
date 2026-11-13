const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=p=>fs.readFileSync(path.resolve(__dirname,'../..',p),'utf8');
function body(source,marker){const start=source.indexOf('{',source.indexOf(marker));let depth=0;for(let i=start;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&!--depth)return source.slice(start,i+1);}throw Error(marker);}
const source=read('src/artwork/artwork_cache.cpp');
const code=body(source,'bool ArtworkCache::writeBufferYielding(')
 .replace('static constexpr size_t CHUNK_BYTES','const CHUNK_BYTES').replace(/\bsize_t /g,'let ')
 .replace('const uint32_t pauseMs','const pauseMs').replace(/(\d+)U/g,'$1')
 .replace('data + written','data.subarray(written)').replace(/\bmin\(/g,'Math.min(').replace('static_cast<size_t>(512)','512')
 .replace('max(static_cast<TickType_t>(1),','Math.max(1,');
function run(bytes,{active=true,shortAt=-1,cancelAt=-1,tickMs=1}={}){
 const writes=[],delays=[];const input=Buffer.alloc(bytes,37);
 const ok=new Function('file','data','length','idlePrewarmCancellationRequested','audioReady','pdMS_TO_TICKS','vTaskDelay',code)(
  {write(data,n){writes.push(Buffer.from(data.subarray(0,n)));return writes.length===shortAt?n-1:n;}},
  input,input.length,()=>writes.length===cancelAt,()=>active,ms=>Math.floor(ms/tickMs),n=>delays.push(n));
 return {ok,writes,delays,input};
}
test('large image writes remain byte-exact bounded chunks and give active audio refill time',()=>{
 for(const size of [1,4096,19053,67738,120*1024])for(const active of [true,false]){
  const r=run(size,{active});assert.equal(r.ok,true);assert.deepEqual(Buffer.concat(r.writes),r.input);
  const chunk=active?512:4096;
  assert.ok(r.writes.every(p=>p.length<=chunk));assert.deepEqual(r.delays,Array(Math.ceil(size/chunk)).fill(active?20:1));
 }
});
test('cooperative flash pacing never becomes a busy loop with a coarser RTOS tick',()=>{
 for(const active of [true,false]){const r=run(9000,{active,tickMs:10});assert.ok(r.delays.every(n=>n>=1));}
});
test('cancellation and short disk writes terminate without continuing the image commit',()=>{
 let r=run(19053,{cancelAt:0});assert.equal(r.ok,false);assert.equal(r.writes.length,0);
 r=run(19053,{cancelAt:2});assert.equal(r.ok,false);assert.equal(r.writes.length,2);
 r=run(19053,{shortAt:2});assert.equal(r.ok,false);assert.equal(r.writes.length,2);assert.equal(r.delays.length,1);
});
