const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/audio/audio_spectrum.cpp'), 'utf8');
const policy = fs.readFileSync(path.join(root, 'src/audio/spectrum_capture.h'), 'utf8');
const math = fs.readFileSync(path.join(root, 'src/audio/spectrum_math.h'), 'utf8');
const N = Number(math.match(/POINT_COUNT = (\d+)/)[1]);
const BUFFERS = Number(policy.match(/BUFFER_COUNT = (\d+)/)[1]);

function body(text, marker) {
  const at = text.indexOf(marker); assert.ok(at >= 0, marker);
  const begin = text.indexOf('{', at); let depth = 0;
  for (let i = begin; i < text.length; ++i) {
    if (text[i] === '{') ++depth;
    if (text[i] === '}' && --depth === 0) return text.slice(begin, i + 1);
  }
  throw new Error(marker);
}
function translate(text) {
  return text.replace(/static_cast<(?:u?int\d+_t|size_t)>\(/g, 'Math.trunc(')
    .replace(/\bconst (?:u?int\d+_t|size_t|bool|int) /g, 'const ')
    .replace(/(\d+)u\b/g,'$1')
    .replace(/\b(?:u?int\d+_t|size_t|bool|int) /g, 'let ')
    .replace(/Frame& frame =/g, 'const frame =')
    .replace(/for \(Frame& frame : frames_\)/g, 'for (const frame of frames_)')
    .replace(/BufferState::/g, 'State.')
    .replace(/SpectrumMath::/g, 'MathPolicy.')
    .replace(/SpectrumCapture::/g, 'CapturePolicy.')
    .replace(/frames_\.size\(\)/g, 'frames_.length')
    .replace(/min<size_t>\(/g, 'Math.min(').replace(/\bmax\(/g, 'Math.max(')
    .replace(/published_ = \{\};/g, 'published_ = {};')
    .replace(/captureClock_ = \{\};/g, 'captureClock_ = new Clock();');
}
const capture = translate(body(source, 'void AudioSpectrum::capture('))
  .replace('memcpy(frames_[index].samples + start * 2, samples + offset * 2, count * 2 * sizeof(int32_t));',
    'frames_[index].samples.set(samples.subarray(offset * 2, (offset + count) * 2), start * 2);');
const take = translate(body(source, 'bool AudioSpectrum::takeFrame('))
  .replace(/static_cast<int>\(/g, 'Math.trunc(')
  .replace('return oldest >= 0;', 'return oldest;');
const snapshot = translate(body(source, 'AudioSpectrumSnapshot AudioSpectrum::snapshot('))
  .replace('AudioSpectrumSnapshot result;', 'let result;')
  .replace('result = published_;', 'result = clone(published_);')
  .replace('result = resultStorage_[newest];', 'result = clone(resultStorage_[newest]);')
  .replace('published_ = result;', 'published_ = clone(result);')
  .replace(/static_cast<int>\(/g, 'Math.trunc(')
  .replace('for (float db : published_.bandDb)', 'for (const db of published_.bandDb)')
  .replace(/\bmin\(/g, 'Math.min(');
const reset = translate(body(source, 'void AudioSpectrum::resetLocked('));
const clockMethod = name => translate(body(policy, name)).replace(/\b(ready|anchorMs|frames)\b/g, 'this.$1')
  .replace(/\btimeAt\(/g, 'this.timeAt(');

function analyzer(rate = 44100) {
  const context = vm.createContext({ N, rate, BUFFERS, now:1000, Int32Array, Math });
  vm.runInContext(`
    const State={ Free:0, Writing:1, Ready:2, Processing:3, Analyzed:4 };
    const MathPolicy={ POINT_COUNT:N, BAND_COUNT:24,
      MAX_QUEUE_AGE_MS:${Number(math.match(/MAX_QUEUE_AGE_MS = (\d+)/)[1])},
      FRAME_HOLD_MS:${Number(math.match(/FRAME_HOLD_MS = (\d+)/)[1])},
      beforeDeadline:(now,due) => due!==0 && ((now-due)|0)<0 };
    const CapturePolicy={ PEAK_MERGE_MS:${Number(policy.match(/PEAK_MERGE_MS = (\d+)/)[1])},
      windowHop:function(sampleRate) ${translate(body(policy,'uint32_t windowHop(')).replace('sampleRate * INTERVAL_MS / 1000','Math.trunc(sampleRate * INTERVAL_MS / 1000)')} };
    const INTERVAL_MS=${Number(policy.match(/INTERVAL_MS = (\d+)/)[1])};
    class Clock {
      constructor(){this.ready=false;this.anchorMs=0;this.frames=0;}
      timeAt(frame,rate) ${clockMethod('uint32_t timeAt(')}
      discontinuity(now,rate) ${clockMethod('bool discontinuity(')}
      start(now) ${clockMethod('void start(')}
      append(count) ${clockMethod('uint64_t append(')}
    }
    let frames_=Array.from({length:BUFFERS},()=>({samples:new Int32Array(N*2),state:State.Free}));
    let initialized_=true,enabled_=true,visible_=true, generation_=1, sampleRate_=rate;
    let playbackGainDb_=-20, captureClock_=new Clock(),nextWindowFrame_=0,writeBuffer_=-1,writePosition_=0;
    let published_={},firstFrame_=true,lastPcmMs_=0,task_=1,mux_=0,notifications=0,lastMinDb_=0,lastMaxDb_=-120;
    let diagnostics_={callbacks:0,pcmFrames:0,captured:0,processed:0,presented:0,merged:0,busyDrops:0,staleDrops:0,resets:0,maxCaptureUs:0};
    let resultStorage_=Array(BUFFERS), traces=new Map(), lastReturnedTime=-1;
    const clone=x=>({...x,bandDb:[...(x.bandDb||Array(24).fill(-120))]});
    const millis=()=>now,micros=()=>now*1000;
    function portENTER_CRITICAL(){} function portEXIT_CRITICAL(){}
    function xTaskNotifyGive(){++notifications;}
    function resetLocked() ${reset}
    function capture(samples,frames) ${capture.replace(/&mux_/g,'mux_')}
    function takeFrame(index) ${take.replace(/&mux_/g,'mux_')}
    function snapshot() ${snapshot.replace(/&mux_/g,'mux_')}
    function finishWork(i,db=-30){
      const frame=frames_[i];
      resultStorage_[i]={active:true,updatedMs:frame.capturedMs,generation:frame.generation,
        bandDb:Array(24).fill(db),peakDb:db,rmsDb:db,outputRmsDb:db};
      traces.set(frame.capturedMs,{time:frame.capturedMs,pcm:Array.from(frame.samples),generation:frame.generation});
      frame.state=State.Analyzed;++diagnostics_.processed;
    }
    function worker(){for(let i=takeFrame();i>=0;i=takeFrame())finishWork(i);}
    function drain(){
      worker();const value=snapshot();
      if(!value.active || value.updatedMs===lastReturnedTime)return [];
      lastReturnedTime=value.updatedMs;return [traces.get(value.updatedMs)];
    }
    function stats(){return {...diagnostics_,notifications};}
    function setVisible(value){visible_=value;resetLocked();}
  `, context);
  return context;
}
function packet(start, count) {
  return Int32Array.from({length:count*2},(_,i)=>Math.floor(i/2)+start+(i%2 ? 1000000 : 0));
}

test('long FLAC packets yield several time-ordered windows, without changing audio',()=>{
  const a=analyzer(), input=packet(0,4096), before=new Int32Array(input);
  a.capture(input,4096);
  assert.deepEqual(input,before);
  assert.equal(a.stats().captured,3); // fourth spans the next packet.
  assert.deepEqual(Array.from(a.drain()),[]); // midpoint has not arrived yet.
  const windows=[];
  for(let t=1000;t<1100;t+=5){a.now=t;windows.push(...a.drain());}
  assert.equal(windows.length,3);
  assert.deepEqual(windows.map(w=>w.time),[1011,1036,1061]);
  assert.deepEqual(windows.map(w=>w.pcm[0]),[0,1102,2204]);
  for(const w of windows) for(let i=0;i<N;++i){
    assert.equal(w.pcm[i*2],w.pcm[0]+i);
    assert.equal(w.pcm[i*2+1],w.pcm[i*2]+1000000);
  }
});

test('window samples stay contiguous across uneven MP3/FLAC packet boundaries',()=>{
  const a=analyzer(); let offset=0; const out=[];
  for(const count of [700,452,4096,1152,3000,1152]){
    a.now=1000+Math.floor(offset*1000/44100);out.push(...a.drain());
    a.capture(packet(offset,count),count); offset+=count;
    for(let t=a.now;t<1000+offset*1000/44100;t+=5){a.now=t;out.push(...a.drain());}
  }
  assert.ok(out.length>8);
  for(const w of out) for(let i=0;i<N;++i) assert.equal(w.pcm[i*2],w.pcm[0]+i);
  assert.equal(a.stats().busyDrops,0);
});

test('future FLAC windows survive selection of the current window',()=>{
  const a=analyzer();a.capture(packet(0,8192),8192);
  a.now=1012;assert.equal(a.drain().length,1);
  a.now=1037;assert.equal(a.drain().length,1);
  a.now=1062;assert.equal(a.drain().length,1);
  assert.equal(a.stats().staleDrops,0);
});

test('full queue skips analyzer windows without blocking or touching playback',()=>{
  const a=analyzer();const input=packet(0,30000),before=new Int32Array(input);
  a.capture(input,30000);
  assert.ok(a.stats().busyDrops>0);assert.equal(a.stats().captured,BUFFERS);
  assert.deepEqual(input,before);
  a.now=2000;assert.equal(a.drain().length,0); // obsolete windows are not replayed.
  assert.ok(a.stats().staleDrops>=BUFFERS);
});

test('visibility/stop resets cancel scheduled future windows and partial input',()=>{
  const a=analyzer();a.capture(packet(0,4096),4096);a.setVisible(false);
  a.now=1100;assert.equal(a.drain().length,0);
  a.capture(packet(4096,4096),4096);assert.equal(a.stats().captured,3);
  a.setVisible(true);a.capture(packet(8000,1152),1152);a.now=1120;
  assert.equal(a.drain()[0].pcm[0],8000);
});

test('5-second MP3 and FLAC streams both supply about 200 evenly scheduled FFT windows',()=>{
  for(const rate of [44100,48000]) for(const size of [1152,4096]){
    const a=analyzer(rate);let cursor=0;const out=[];
    while(cursor<rate*5){
      a.now=1000+Math.floor(cursor*1000/rate);out.push(...a.drain());
      a.capture(packet(cursor,size),size);cursor+=size;
      for(let t=a.now;t<1000+cursor*1000/rate;t+=5){a.now=t;out.push(...a.drain());}
    }
    assert.ok(out.length>=197 && out.length<=205,`${rate}/${size}: ${out.length}`);
    assert.equal(a.stats().busyDrops,0);assert.equal(a.stats().resets,0);
    assert.ok(out.every((w,i)=>!i || w.time>out[i-1].time));
  }
});

test('DMA startup prefill plus a full FLAC packet fits without dropping windows',()=>{
  const a=analyzer();let offset=0;
  for(let i=0;i<7;++i){a.capture(packet(offset,1152),1152);offset+=1152;}
  a.capture(packet(offset,4608),4608);
  assert.equal(a.stats().busyDrops,0);assert.equal(a.stats().resets,0);
  const out=[];
  for(let t=1000;t<1300;t+=5){a.now=t;out.push(...a.drain());}
  assert.ok(out.length>=11);
});

test('queued PCM uses PSRAM exclusively and callback contains no wait, allocation or FFT',()=>{
  const callback=body(source,'void AudioSpectrum::capture(');
  assert.doesNotMatch(callback,/vTaskDelay|ulTaskNotifyTake|malloc|transform\(|captureWindowOffset/);
  assert.match(source,/MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT/);
  assert.doesNotMatch(source,/MALLOC_CAP_INTERNAL/);
});

test('future windows are analyzed immediately but never displayed early',()=>{
  const a=analyzer();a.capture(packet(0,4096),4096);a.worker();
  assert.equal(a.stats().processed,3);
  assert.equal(a.snapshot().active,undefined);
  assert.equal(a.stats().presented,0);
  a.now=1012;assert.equal(a.snapshot().updatedMs,1011);
  assert.equal(a.stats().presented,1);
  a.now=1037;assert.equal(a.snapshot().updatedMs,1036);
  assert.equal(a.stats().presented,2);
  assert.equal(a.stats().staleDrops,0);
});

test('slightly late FLAC windows are all analyzed rather than discarded as neighbors',()=>{
  const a=analyzer();a.capture(packet(0,4096),4096);
  a.now=1045;a.worker();
  assert.equal(a.stats().processed,3);
  assert.equal(a.snapshot().updatedMs,1036);
  assert.equal(a.stats().presented,2);
  assert.equal(a.stats().merged,1);
  assert.equal(a.stats().staleDrops,0);
  a.now=1062;a.snapshot();assert.equal(a.stats().presented,3);
});

test('12ms FFT work and 33ms LCD updates retain about 200 windows per five seconds',(t)=>{
  for(const rate of [44100,48000])for(const count of [1152,4096]){
    const a=analyzer(rate);let cursor=0,pending=-1,done=0,nextLcd=1000;
    for(let t=1000;t<=6000;++t){
      a.now=t;
      if(cursor<rate*5 && t>=1000+Math.floor(cursor*1000/rate)){
        a.capture(packet(cursor,count),count);cursor+=count;
      }
      if(pending>=0 && t>=done){a.finishWork(pending);pending=-1;}
      if(t>=nextLcd){
        const s=a.snapshot();
        if(s.active)assert.ok(s.updatedMs<=t,'future result appeared early');
        nextLcd+=33;
      }
      if(pending<0){pending=a.takeFrame();if(pending>=0)done=t+12;}
    }
    const s=a.stats();
    assert.ok(s.processed>=196 && s.processed<=204,`${rate}/${count}: ${s.processed}`);
    assert.ok(s.presented>=194,`${rate}/${count}: ${s.presented}`);
    assert.ok(s.merged>20,'sub-frame results should be preserved in LCD frames');
    assert.equal(s.busyDrops,0,`${rate}/${count}: ${JSON.stringify(s)}`);
    // Rare results outside the one-LCD-frame peak horizon may be skipped;
    // every raw window was still analyzed, with no playback backpressure.
    assert.ok(s.staleDrops<=5,`${rate}/${count}: ${JSON.stringify(s)}`);assert.equal(s.resets,0);
    t.diagnostic(`${rate}/${count}: FFT=${s.processed}, presented=${s.presented}, merged=${s.merged}, obsolete=${s.staleDrops}`);
  }
});

test('a measured short beat survives between LCD frames, then immediately releases',()=>{
  const a=analyzer();a.capture(packet(0,4096),4096);
  a.finishWork(a.takeFrame(),-4);a.finishWork(a.takeFrame(),-42);a.finishWork(a.takeFrame(),-42);
  a.now=1044;const beat=a.snapshot();
  assert.equal(beat.updatedMs,1036);assert.equal(beat.bandDb[0],-4);
  a.now=1045;assert.equal(a.snapshot().bandDb[0],-42,'peak must not become the retained baseline');
  a.now=1062;assert.equal(a.snapshot().bandDb[0],-42);
});

test('a delayed LCD does not replay an old strong beat over current quiet audio',()=>{
  const a=analyzer();a.capture(packet(0,4096),4096);
  a.finishWork(a.takeFrame(),-4);a.finishWork(a.takeFrame(),-42);a.finishWork(a.takeFrame(),-42);
  a.now=1090;const current=a.snapshot();
  assert.equal(current.updatedMs,1061);assert.equal(current.bandDb[0],-42);
  assert.equal(a.stats().staleDrops,1);
});

test('stop and visibility changes cancel already analyzed future results',()=>{
  const a=analyzer();a.capture(packet(0,4096),4096);a.worker();
  a.setVisible(false);a.now=1150;assert.equal(a.snapshot().active,undefined);
  a.setVisible(true);a.capture(packet(8000,1152),1152);a.worker();
  assert.equal(a.snapshot().active,undefined);
  a.now=1162;assert.equal(a.snapshot().updatedMs,1161);
});

test('analyzed results expire after a long stall and recover with current PCM',()=>{
  const a=analyzer();a.capture(packet(0,4096),4096);a.worker();
  a.now=1800;assert.equal(a.snapshot().active,undefined);
  assert.equal(a.stats().staleDrops,3);
  a.capture(packet(9000,1152),1152);a.worker();a.now=1812;
  assert.equal(a.snapshot().updatedMs,1811);
});

test('production FFT stores PSRAM results and LCD consumption performs no FFT or USB IO',()=>{
  const process=body(source,'void AudioSpectrum::processFrame(');
  const draw=body(source,'AudioSpectrumSnapshot AudioSpectrum::snapshot(');
  const loop=body(source,'void AudioSpectrum::taskLoop(');
  assert.match(source,/frames_\.size\(\) \* sizeof\(AudioSpectrumSnapshot\), MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT/);
  assert.match(process,/resultStorage_\[index\] = result/);
  assert.match(process,/frame\.state = BufferState::Analyzed/);
  assert.doesNotMatch(process,/published_ = result/);
  assert.match(loop,/if \(frames_\[index\]\.state == BufferState::Processing\)/);
  assert.doesNotMatch(draw,/prepareFrame|transform\(|SpectrumLog|Serial|malloc|vTaskDelay/);
  assert.match(source,/presented=%lu merged=%lu/);
});
