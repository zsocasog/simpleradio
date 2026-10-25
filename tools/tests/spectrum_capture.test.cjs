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
    .replace(/\bconst (?:u?int\d+_t|size_t|bool) /g, 'const ')
    .replace(/(\d+)u\b/g,'$1')
    .replace(/\b(?:u?int\d+_t|size_t|bool) /g, 'let ')
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
  .replace('int newest = -1;', 'let newest = -1;').replace(/static_cast<int>\(/g, 'Math.trunc(')
  .replace('return newest >= 0;', 'return newest;');
const reset = translate(body(source, 'void AudioSpectrum::resetLocked('));
const clockMethod = name => translate(body(policy, name)).replace(/\b(ready|anchorMs|frames)\b/g, 'this.$1')
  .replace(/\btimeAt\(/g, 'this.timeAt(');

function analyzer(rate = 44100) {
  const context = vm.createContext({ N, rate, BUFFERS, now:1000, Int32Array, Math });
  vm.runInContext(`
    const State={ Free:0, Writing:1, Ready:2, Processing:3 };
    const MathPolicy={ POINT_COUNT:N, beforeDeadline:(now,due) => due!==0 && ((now-due)|0)<0 };
    const CapturePolicy={ windowHop:function(sampleRate) ${translate(body(policy,'uint32_t windowHop(')).replace('sampleRate * INTERVAL_MS / 1000','Math.trunc(sampleRate * INTERVAL_MS / 1000)')} };
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
    let published_={},firstFrame_=true,lastPcmMs_=0,task_=1,mux_=0,notifications=0;
    let diagnostics_={callbacks:0,pcmFrames:0,captured:0,busyDrops:0,staleDrops:0,resets:0,maxCaptureUs:0};
    const millis=()=>now,micros=()=>now*1000;
    function portENTER_CRITICAL(){} function portEXIT_CRITICAL(){}
    function xTaskNotifyGive(){++notifications;}
    function resetLocked() ${reset}
    function capture(samples,frames) ${capture.replace(/&mux_/g,'mux_')}
    function takeFrame(index) ${take.replace(/&mux_/g,'mux_')}
    function drain(){
      const out=[];
      for(let i=takeFrame();i>=0;i=takeFrame()){
        const frame=frames_[i];
        out.push({time:frame.capturedMs,pcm:Array.from(frame.samples),generation:frame.generation});
        frame.state=State.Free;
      }
      return out;
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
  a.now=2000;assert.equal(a.drain().length,1); // newest due frame, no backlog replay.
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
