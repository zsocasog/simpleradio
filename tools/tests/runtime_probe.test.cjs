const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/diagnostics/runtime_probe.cpp'),'utf8');
function body(name){const i=source.indexOf('{',source.indexOf(name));let depth=0;for(let j=i;j<source.length;j++){if(source[j]==='{')depth++;if(source[j]==='}'&&!--depth)return source.slice(i,j+1);}throw Error(name);}
function translate(s){return s.replace(/port(?:ENTER|EXIT)_CRITICAL(?:_ISR)?\(&probeMux\);/g,'')
 .replace(/recordZeroEvent\(now\);/g,'void 0;')
 .replace(/const uint32_t now = static_cast<uint32_t>\(esp_timer_get_time\(\)\);/g,'const now=clock();')
 .replace(/const uint32_t /g,'const ').replace(/auto& /g,'const ').replace(/uint32_t bits = 0/g,'let bits=0').replace(/size_t i = 0/g,'let i=0').replace(/static_cast<uint32_t>\((.*?)\)/g,'($1)')
 .replace(/xTaskGetTickCountFromISR\(\) \* portTICK_PERIOD_MS/g,'Math.floor(clock()/1000)')
 .replace(/uint64_t\(capacityFrames\)/g,'capacityFrames');}
function make(){let now=1000;const probe={epoch:0,starts:0,stops:0,active:false,sentFrames:0,sentBlocks:0,sentGapMaxUs:0,feedGapMaxUs:0,feedDeadlineMisses:0,writes:0,acceptedBytes:0,partialWrites:0,writeTimeouts:0,writeErrors:0,writeMaxUs:0,observedBlocks:0,zeroBlocks:0,zeroRunMaxFrames:0};
 const rows=Array.from({length:8},()=>({}));
 const setup=`let lastSentUs=0,lastFeedUs=0,startedUs=0,dmaBudgetUs=0,feedLate=false,feedEventNumber=0,activityMask=0,zeroRunFrames=0;
 const feedEventRows={rows};`;
 const factory=new Function('probe','clock','ESP_OK','ESP_ERR_TIMEOUT','rows',setup+`
  function start(rate,capacityFrames) ${translate(body('void outputStart('))}
  function sent(frames,now) ${translate(body('void IRAM_ATTR outputSent('))}
  function block(data,frames,now) ${translate(body('void IRAM_ATTR outputBlock('))}
  function written(requested,accepted,result,elapsedUs) ${translate(body('void written('))}
  function stop() ${translate(body('void outputStop('))}
  return {start,sent,written,stop,block};`);
 return {...factory(probe,()=>now,0,263,rows),probe,rows,time(t){now=t;}};
}
test('monitor measures driver progress even when no valid music has been written',()=>{const p=make();p.start(44100,8192);p.sent(256,10000);assert.equal(p.probe.sentFrames,256);assert.equal(p.probe.acceptedBytes,0);});
test('warmup and an intentional stop cannot create feed deadline misses',()=>{const p=make();p.start(44100,8192);p.written(100,100,0,10);p.sent(256,500000);assert.equal(p.probe.feedDeadlineMisses,0);p.stop();p.sent(256,9000000);assert.equal(p.probe.feedDeadlineMisses,0);});
test('one prolonged feed pause is counted once until an accepted write arrives',()=>{const p=make();p.start(44100,8192);p.time(3000000);p.written(100,100,0,10);p.sent(256,3300000);p.sent(256,3400000);assert.equal(p.probe.feedDeadlineMisses,1);p.time(3500000);p.written(100,100,0,10);p.sent(256,3800000);assert.equal(p.probe.feedDeadlineMisses,2);});
test('a partial timed-out write is not reported as a fatal driver error',()=>{const p=make();p.start(44100,8192);p.written(100,50,263,5000);assert.equal(p.probe.partialWrites,1);assert.equal(p.probe.writeTimeouts,1);assert.equal(p.probe.writeErrors,0);assert.equal(p.probe.acceptedBytes,50);});
test('a new epoch drops the previous epoch feed history',()=>{const p=make();p.start(44100,8192);p.time(3000000);p.written(100,100,0,10);p.time(4000000);p.start(48000,8192);p.sent(256,8000000);assert.equal(p.probe.feedDeadlineMisses,0);assert.equal(p.probe.epoch,2);});
test('the output callback only updates scalar counters under a short ISR lock',()=>{const b=body('void IRAM_ATTR outputSent(');assert.doesNotMatch(b,/malloc|Serial|printf|memcpy|vTaskDelay|new |snapshot|Json/);assert.match(b,/portENTER_CRITICAL_ISR/);});
test('event retains the completed pause length rather than just the first threshold crossing',()=>{
 const p=make();p.start(44100,8192);p.time(3000000);p.written(100,100,0,10);
 p.time(3200000);p.sent(256,3200000);assert.equal(p.rows[0].completed,false);
 p.time(3500000);p.written(100,100,0,10);assert.equal(p.rows[0].gapUs,500000);assert.equal(p.rows[0].completed,true);
});
test('bounded event ring replaces old rows and uses a clock independent of 32-bit microsecond wrap',()=>{
 const p=make();p.start(44100,8192);
 for(let i=0;i<10;i++){p.time(3000000+i*1000000);p.written(100,100,0,1);p.time(3300000+i*1000000);p.sent(256,3300000+i*1000000);}
 assert.equal(p.rows.length,8);assert.equal(p.rows[0].number,9);assert.equal(p.rows[1].number,10);
 assert.match(body('void IRAM_ATTR outputSent('),/xTaskGetTickCountFromISR/);
});
test('sent-block observer detects real all-zero DMA data, keeps input immutable and ignores warmup',()=>{
 const p=make(),zero=new Int32Array(512),music=new Int32Array(512);music[511]=1;
 p.start(44100,8192);p.block(zero,256,10000);assert.equal(p.probe.observedBlocks,0);
 p.block(zero,256,3000000);p.block(zero,256,3010000);p.block(music,256,3020000);
 assert.equal(p.probe.zeroBlocks,2);assert.equal(p.probe.observedBlocks,3);assert.equal(p.probe.zeroRunMaxFrames,512);
 assert.equal(music[511],1);assert.equal(zero.reduce((a,b)=>a|b,0),0);
 p.block(null,256,4000000);p.block(zero,257,4000000);assert.equal(p.probe.observedBlocks,3);
});
