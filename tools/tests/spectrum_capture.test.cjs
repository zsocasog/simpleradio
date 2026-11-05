const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/audio/audio_spectrum.cpp'), 'utf8');
const policy = fs.readFileSync(path.join(root, 'src/audio/spectrum_capture.h'), 'utf8');
const math = fs.readFileSync(path.join(root, 'src/audio/spectrum_math.h'), 'utf8');
const output = fs.readFileSync(path.join(root, 'src/audio/audio_output.cpp'), 'utf8');
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
  return text.replace(/static_cast<(?:u?int\d+_t|size_t|int)>\(/g, 'Math.trunc(')
    .replace(/\bconst (?:u?int\d+_t|size_t|bool|int) /g, 'const ')
    .replace(/(\d+)u\b/g,'$1')
    .replace(/\b(?:u?int\d+_t|size_t|bool|int) /g, 'let ')
    .replace(/Frame& frame =/g, 'const frame =')
    .replace(/for \(Frame& frame : frames_\)/g, 'for (const frame of frames_)')
    .replace(/BufferState::/g, 'State.')
    .replace(/SpectrumMath::/g, 'MathPolicy.')
    .replace(/SpectrumCapture::/g, 'CapturePolicy.')
    .replace(/SpectrumOutput::/g, 'OutputPolicy.')
    .replace(/frames_\.size\(\)/g, 'frames_.length')
    .replace(/min<size_t>\(/g, 'Math.min(').replace(/\bmax\(/g, 'Math.max(')
    .replace(/published_ = \{\};/g, 'published_ = {};')
    .replace(/captureClock_ = \{\};/g, 'captureClock_ = new Clock();');
}
const capture = translate(body(source, 'void AudioSpectrum::capture('))
  .replace('memcpy(frames_[index].samples + start * 2, samples + offset * 2, count * 2 * sizeof(int32_t));',
    'frames_[index].samples.set(samples.subarray(offset * 2, (offset + count) * 2), start * 2);');
const take = translate(body(source, 'bool AudioSpectrum::takeFrame('))
  .replace('return oldest >= 0;', 'return oldest;');
const snapshot = translate(body(source, 'AudioSpectrumSnapshot AudioSpectrum::snapshot('))
  .replace('AudioSpectrumSnapshot result;', 'let result;')
  .replace('result = published_;', 'result = clone(published_);')
  .replace('result = resultStorage_[newest];', 'result = clone(resultStorage_[newest]);')
  .replace('published_ = result;', 'published_ = clone(result);')
  .replace('for (float db : published_.bandDb)', 'for (const db of published_.bandDb)')
  .replace(/\bmin\(/g, 'Math.min(');
const reset = translate(body(source, 'void AudioSpectrum::resetLocked('));
const clockMethod = name => translate(body(policy, name))
  .replace(/\b(ready|anchorMs|frames|epoch)\b/g, 'this.$1');

function analyzer(rate = 44100) {
  const context = vm.createContext({ N, rate, BUFFERS, now:1000, Int32Array, Math });
  vm.runInContext(`
    const State={ Free:0, Writing:1, Ready:2, Processing:3, Analyzed:4 };
    const MathPolicy={ POINT_COUNT:N, BAND_COUNT:24,
      MAX_QUEUE_AGE_MS:${Number(math.match(/MAX_QUEUE_AGE_MS = (\d+)/)[1])},
      FRAME_HOLD_MS:${Number(math.match(/FRAME_HOLD_MS = (\d+)/)[1])},
      beforeDeadline:(now,due) => due!==0 && ((now-due)|0)<0 };
    let epoch=1;
    const OutputPolicy={isCurrent:value=>value===epoch};
    const CapturePolicy={ PEAK_MERGE_MS:${Number(policy.match(/PEAK_MERGE_MS = (\d+)/)[1])},
      windowHop:function(sampleRate) ${translate(body(policy,'uint32_t windowHop(')).replace('sampleRate * INTERVAL_MS / 1000','Math.trunc(sampleRate * INTERVAL_MS / 1000)')} };
    const INTERVAL_MS=${Number(policy.match(/INTERVAL_MS = (\d+)/)[1])};
    class Clock {
      constructor(){this.ready=false;this.anchorMs=0;this.frames=0;this.epoch=0;}
      timeAt(frame,rate) ${clockMethod('uint32_t timeAt(')}
      discontinuity(firstFrame,outputEpoch) ${clockMethod('bool discontinuity(')}
      observe(firstFrame,count,endedMs,rate,outputEpoch) ${clockMethod('void observe(').replace('this.frames * 1000 / rate','Math.trunc(this.frames * 1000 / rate)')}
    }
    let frames_=Array.from({length:BUFFERS},()=>({samples:new Int32Array(N*2),state:State.Free}));
    let initialized_=true,enabled_=true,visible_=true, generation_=1, sampleRate_=rate;
    let playbackGainDb_=-20, captureClock_=new Clock(),nextWindowFrame_=0,writeBuffer_=-1,writePosition_=0;
    let published_={},firstFrame_=true,lastPcmMs_=0,task_=1,mux_=0,notifications=0,lastMinDb_=0,lastMaxDb_=-120;
    let timing_={},timingStartedMs_=0;
    let diagnostics_={callbacks:0,pcmFrames:0,captured:0,processed:0,presented:0,merged:0,busyDrops:0,staleDrops:0,resets:0,maxCaptureUs:0};
    let resultStorage_=Array(BUFFERS), traces=new Map();
    const clone=x=>({...x,bandDb:[...(x.bandDb||Array(24).fill(-120))]});
    const millis=()=>now,micros=()=>now*1000;
    function portENTER_CRITICAL(){} function portEXIT_CRITICAL(){}
    function xTaskNotifyGive(){++notifications;}
    function resetLocked() ${reset}
    function capture(samples,frames,firstFrame,endedMs,outputEpoch=epoch,outputRate=rate) ${capture.replace(/&mux_/g,'mux_')}
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
    function stats(){return {...diagnostics_,notifications};}
    function setVisible(value){visible_=value;resetLocked();++epoch;}
    function restart(){resetLocked();++epoch;}
  `, context);
  return context;
}
function pcm(first, count) {
  return Int32Array.from({length:count*2},(_,i)=>Math.floor(i/2)+first+(i%2 ? 1000000 : 0));
}
function feed(a,first,count,endedMs,arrivedMs=endedMs) {
  a.now=arrivedMs; const input=pcm(first,count), before=new Int32Array(input);
  a.capture(input,count,first,endedMs);
  assert.deepEqual(input,before);
}

test('window timestamps follow sent samples regardless of callback/task arrival delay',()=>{
  for(const handoff of [0,3,17,40]) {
    const a=analyzer();
    feed(a,0,1024,1023,1023+handoff);a.worker();
    assert.equal(a.snapshot().updatedMs,1011);
    assert.equal(a.stats().captured,1);
  }
});

test('small DMA blocks make complete contiguous stereo windows across all boundaries',()=>{
  for(const rate of [44100,48000]) {
    const a=analyzer(rate);
    for(let first=0;first<rate;++first) {
      // Deliberately uneven segments, independent of decoder packet sizes.
      const count=Math.min(37+(first%220),rate-first);
      feed(a,first,count,1000+Math.floor((first+count)*1000/rate));
      first+=count-1;a.worker();a.snapshot();
    }
    const windows=Array.from(vm.runInContext('traces.values().toArray ? traces.values().toArray() : Array.from(traces.values())',a));
    assert.ok(windows.length>=39 && windows.length<=41);
    for(const w of windows)for(let i=0;i<N;++i) {
      assert.equal(w.pcm[i*2],w.pcm[0]+i);
      assert.equal(w.pcm[i*2+1],w.pcm[0]+i+1000000);
    }
    assert.equal(a.stats().busyDrops,0);assert.equal(a.stats().resets,0);
  }
});

test('a dropped DMA hand-off discards the incomplete FFT window and resumes current PCM',()=>{
  const a=analyzer();feed(a,0,700,1015);
  feed(a,956,1024,1044);a.worker();
  assert.equal(a.stats().resets,1);
  const windows=Array.from(vm.runInContext('Array.from(traces.values())',a));
  assert.equal(windows.length,1);assert.equal(windows[0].pcm[0],956);
  assert.equal(windows[0].pcm.at(-2),956+1023);
});

test('output restart, visibility change and old DMA epochs cannot leak a previous track',()=>{
  const a=analyzer();feed(a,0,1024,1023);a.worker();
  a.restart();a.now=1030;
  a.capture(pcm(1024,1024),1024,1024,1046,1);a.worker();
  assert.equal(a.snapshot().active,undefined);
  feed(a,0,1024,1053);a.worker();assert.equal(a.snapshot().updatedMs,1041);
  a.setVisible(false);a.now=1060;assert.equal(a.snapshot().active,undefined);
  feed(a,1024,1024,1076);assert.equal(a.stats().captured,2);
});

test('opening spectrum during a song anchors to the current output frame, not frame zero',()=>{
  const a=analyzer();feed(a,441000,1024,11023);a.worker();
  assert.equal(a.snapshot().updatedMs,11011);
  const windows=Array.from(vm.runInContext('Array.from(traces.values())',a));
  assert.equal(windows[0].pcm[0],441000);
  assert.equal(a.stats().busyDrops,0);
});

test('MP3 and FLAC decoder batching cannot change output timing or discard visual peaks',t=>{
  for(const rate of [44100,48000])for(const decoderPacket of [1152,4096,4608]) {
    const a=analyzer(rate);
    let first=0,pending=-1,done=0,nextLcd=1000,last=-1,updates=0;
    // Decoder delivery deliberately varies by codec. The simulated I2S device
    // has the same output clock; production capture never receives its packets.
    const decoderArrivals=[];
    for(let n=0;n<rate*5;n+=decoderPacket)decoderArrivals.push(n*1000/rate);
    for(let ms=1000;ms<=6000;++ms) {
      a.now=ms;
      if(first<rate*5 && ms>=1000+Math.floor((first+256)*1000/rate)) {
        feed(a,first,256,1000+Math.floor((first+256)*1000/rate),ms);first+=256;
      }
      if(pending>=0 && ms>=done){a.finishWork(pending);pending=-1;}
      if(ms>=nextLcd) {
        const value=a.snapshot();
        if(value.active && value.updatedMs!==last){++updates;last=value.updatedMs;}
        nextLcd+=36;
      }
      if(pending<0){pending=a.takeFrame();if(pending>=0)done=ms+12;}
    }
    const s=a.stats();
    assert.ok(s.processed>=196 && s.processed<=201,`${rate}/${decoderPacket}: ${JSON.stringify(s)}`);
    assert.ok(updates>=135 && updates<=139,`fresh LCD ${updates}`);
    assert.equal(s.busyDrops,0);assert.equal(s.staleDrops,0);assert.equal(s.resets,0);
    assert.ok(s.presented>=195);assert.ok(s.merged>50);
    assert.ok(decoderArrivals.length>40);
    t.diagnostic(`${rate}/${decoderPacket}: FFT=${s.processed}, fresh-LCD=${updates}, merged=${s.merged}, obsolete=${s.staleDrops}`);
  }
});

test('peak merge preserves a short measured beat without keeping it as the baseline',()=>{
  const a=analyzer();feed(a,0,4096,1092);
  a.finishWork(a.takeFrame(),-4);a.finishWork(a.takeFrame(),-42);a.finishWork(a.takeFrame(),-42);
  a.now=1045;const beat=a.snapshot(); // First two window centers have passed.
  assert.equal(beat.bandDb[0],-4);
  a.now=1046;assert.equal(a.snapshot().bandDb[0],-42);
  a.now=1100;assert.equal(a.snapshot().bandDb[0],-42);
});

test('a stalled LCD skips old beats, then returns the current quiet measurement',()=>{
  const a=analyzer();feed(a,0,4096,1092);
  a.finishWork(a.takeFrame(),-4);a.finishWork(a.takeFrame(),-42);a.finishWork(a.takeFrame(),-42);
  a.now=1090;assert.equal(a.snapshot().bandDb[0],-42);
  assert.equal(a.stats().staleDrops,1);
  a.now=1800; // Existing snapshot freshness policy releases the display.
  assert.ok(a.now-a.snapshot().updatedMs>180);
});

test('a full FFT queue never changes output; old input expires and current input recovers',()=>{
  const a=analyzer();feed(a,0,30000,1680);
  assert.equal(a.stats().captured,BUFFERS);assert.ok(a.stats().busyDrops>0);
  a.now=3000;a.worker();assert.equal(a.snapshot().active,undefined);
  feed(a,90000,1024,3023);a.worker();assert.equal(a.snapshot().updatedMs,3011);
});

test('DMA ISR only copies to internal RAM and notifies; FFT/input work remains in tasks',()=>{
  const isr=body(output,'bool IRAM_ATTR onSent(');
  assert.match(output,/DRAM_ATTR int32_t pcm/);
  assert.match(output,/DRAM_ATTR SpectrumOutput::Queue queue/);
  assert.match(isr,/memcpy\(pcm\[index\], event->dma_buf, event->size\)/);
  assert.match(isr,/frames <= SpectrumOutput::BLOCK_FRAMES/);
  assert.match(isr,/vTaskNotifyGiveFromISR/);
  assert.doesNotMatch(isr,/SpectrumLog|Serial|heap_caps|malloc|log10|transform|\.capture|vTaskDelay|i2s_channel_write/);
  const bridge=body(output,'void inputLoop(');
  assert.match(bridge,/spectrum.capture/);assert.match(bridge,/portMAX_DELAY/);
  assert.match(output,/"spectrum-in", 2048, &spectrum, 1/);
});

test('FFT windows and results stay in PSRAM and LCD consumption contains no processing or IO',()=>{
  const header=fs.readFileSync(path.join(root,'src/audio/audio_spectrum.h'),'utf8');
  assert.match(header,/float\* window_ = nullptr/);
  assert.match(source,/heap_caps_aligned_alloc\(16,\s*SpectrumMath::POINT_COUNT \* sizeof\(float\), MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT\)/);
  assert.match(header,/alignas\(16\) std::array<float, SpectrumMath::POINT_COUNT \* 2> work_/);
  assert.match(source,/frames_\.size\(\) \* sizeof\(AudioSpectrumSnapshot\), MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT/);
  const process=body(source,'void AudioSpectrum::processFrame(');
  assert.match(process,/resultStorage_\[index\] = result/);
  assert.match(process,/frame.state = BufferState::Analyzed/);
  assert.doesNotMatch(body(source,'AudioSpectrumSnapshot AudioSpectrum::snapshot('),/prepareFrame|transform\(|SpectrumLog|Serial|malloc|vTaskDelay/);
});
