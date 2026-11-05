const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const source = read('src/audio/audio_spectrum.cpp');

function body(text, marker) {
  const at = text.indexOf(marker); assert.ok(at >= 0, marker);
  const begin = text.indexOf('{', at); let depth = 0;
  for (let i = begin; i < text.length; ++i) {
    if (text[i] === '{') ++depth;
    if (text[i] === '}' && --depth === 0) return text.slice(begin, i + 1);
  }
  throw new Error(marker);
}

test('LCD timing ignores old generations and hidden or disabled spectrum', () => {
  const records = [];
  const code = body(source, 'void AudioSpectrum::noteDisplayFrame(')
    .replace('const uint32_t now', 'const now').replace(/&mux_/g, '0')
    .replace('SpectrumMath::usableFrame', 'usableFrame');
  const note = new Function('sample','startedUs','finishedUs','enabled_','visible_','generation_',
    'millis','portENTER_CRITICAL','portEXIT_CRITICAL','usableFrame','timing_',code);
  const timing = { recordRender: (...args) => records.push(args) };
  const sample = { active:true, generation:2, updatedMs:90, readyMs:70, analyzedMs:80 };
  const invoke = (enabled, visible, generation, value = sample) => note(value, 99000, 100000,
    enabled, visible, generation, () => 100, () => {}, () => {},
    (active, now, at) => active && ((now - at) >>> 0) <= 180, timing);
  invoke(false,true,2);invoke(true,false,2);invoke(true,true,3);
  assert.equal(records.length,0);
  invoke(true,true,2);
  assert.deepEqual(records[0],[99000,100000,100,true,90,70,80]);
  invoke(true,true,2,{...sample,updatedMs:0xfffff000});
  assert.equal(records[1][3],false);
});

test('measurement accompanies its actual LCD draw, never a second spectrum snapshot', () => {
  const display = read('src/display/display.cpp');
  const render = body(display, 'void Display::renderAudioMeterFrame(');
  const update = body(display, 'static bool updateSpectrumBars(');
  assert.match(update,/spectrum = AudioSpectrum::instance\(\).snapshot\(\)/);
  assert.match(render,/updateSpectrumBars\(lastModel.playing, measurement\)/);
  assert.ok(render.indexOf('noteDisplayFrame(') > render.indexOf('drawVuMeter(lastModel, force);'));
  assert.doesNotMatch(render,/\.snapshot\(/);
});

test('output timing retains bounded async diagnostics and makes no acoustic-latency claim', () => {
  const report = body(source, 'void AudioSpectrum::reportDiagnostics(');
  const note = body(source, 'void AudioSpectrum::noteDisplayFrame(');
  assert.match(report,/timingIntervalMs >= 1000/);
  assert.match(report,/char line\[256\]/);
  assert.equal((report.match(/SpectrumLog::postEvent\(line\)/g)||[]).length,3);
  assert.match(report,/source=sent-DMA/);
  assert.match(report,/acoustic-offset=unmeasured/);
  assert.match(report,/work-wall=/);
  assert.doesNotMatch(note,/SpectrumLog|Serial|malloc|vTaskDelay|setEnabled/);
  assert.equal(read('src/audio/spectrum_log.h').match(/char text\[(\d+)\]/)[1],'512');
});
