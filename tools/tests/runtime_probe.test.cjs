const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/diagnostics/runtime_probe.cpp'),'utf8');
function body(name){const i=source.indexOf('{',source.indexOf(name));let depth=0;for(let j=i;j<source.length;j++){if(source[j]==='{')depth++;if(source[j]==='}'&&!--depth)return source.slice(i,j+1);}throw Error(name);}
function translate(s){return s.replace(/port(?:ENTER|EXIT)_CRITICAL(?:_ISR)?\(&probeMux\);/g,'')
 .replace(/const uint32_t now = static_cast<uint32_t>\(esp_timer_get_time\(\)\);/g,'const now=clock();')
 .replace(/const uint32_t /g,'const ').replace(/static_cast<uint32_t>\((.*?)\)/g,'($1)')
 .replace(/uint64_t\(capacityFrames\)/g,'capacityFrames');}
function make(){let now=1000;const probe={epoch:0,starts:0,stops:0,active:false,sentFrames:0,sentBlocks:0,sentGapMaxUs:0,feedGapMaxUs:0,feedDeadlineMisses:0,writes:0,acceptedBytes:0,partialWrites:0,writeTimeouts:0,writeErrors:0,writeMaxUs:0};
 const setup=`let lastSentUs=0,lastFeedUs=0,startedUs=0,dmaBudgetUs=0,feedLate=false;`;
 const factory=new Function('probe','clock','ESP_OK','ESP_ERR_TIMEOUT',setup+`
  function start(rate,capacityFrames) ${translate(body('void outputStart('))}
  function sent(frames,now) ${translate(body('void IRAM_ATTR outputSent('))}
  function written(requested,accepted,result,elapsedUs) ${translate(body('void written('))}
  function stop() ${translate(body('void outputStop('))}
  return {start,sent,written,stop};`);
 return {...factory(probe,()=>now,0,263),probe,time(t){now=t;}};
}
test('monitor measures driver progress even when no valid music has been written',()=>{const p=make();p.start(44100,8192);p.sent(256,10000);assert.equal(p.probe.sentFrames,256);assert.equal(p.probe.acceptedBytes,0);});
test('warmup and an intentional stop cannot create feed deadline misses',()=>{const p=make();p.start(44100,8192);p.written(100,100,0,10);p.sent(256,500000);assert.equal(p.probe.feedDeadlineMisses,0);p.stop();p.sent(256,9000000);assert.equal(p.probe.feedDeadlineMisses,0);});
test('one prolonged feed pause is counted once until an accepted write arrives',()=>{const p=make();p.start(44100,8192);p.time(3000000);p.written(100,100,0,10);p.sent(256,3300000);p.sent(256,3400000);assert.equal(p.probe.feedDeadlineMisses,1);p.time(3500000);p.written(100,100,0,10);p.sent(256,3800000);assert.equal(p.probe.feedDeadlineMisses,2);});
test('a partial timed-out write is not reported as a fatal driver error',()=>{const p=make();p.start(44100,8192);p.written(100,50,263,5000);assert.equal(p.probe.partialWrites,1);assert.equal(p.probe.writeTimeouts,1);assert.equal(p.probe.writeErrors,0);assert.equal(p.probe.acceptedBytes,50);});
test('a new epoch drops the previous epoch feed history',()=>{const p=make();p.start(44100,8192);p.time(3000000);p.written(100,100,0,10);p.time(4000000);p.start(48000,8192);p.sent(256,8000000);assert.equal(p.probe.feedDeadlineMisses,0);assert.equal(p.probe.epoch,2);});
test('the output callback only updates scalar counters under a short ISR lock',()=>{const b=body('void IRAM_ATTR outputSent(');assert.doesNotMatch(b,/malloc|Serial|printf|memcpy|vTaskDelay|new |snapshot|Json/);assert.match(b,/portENTER_CRITICAL_ISR/);});
