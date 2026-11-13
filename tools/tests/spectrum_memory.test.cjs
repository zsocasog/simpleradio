const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/audio/audio_spectrum.cpp'), 'utf8');
const header = fs.readFileSync(path.join(root, 'src/audio/audio_spectrum.h'), 'utf8');

function body(text, marker) {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, marker);
  const start = text.indexOf('{', at);
  let depth = 0;
  for (let i = start; i < text.length; ++i) {
    if (text[i] === '{') ++depth;
    if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(marker);
}

// Execute the production allocation branch with an injected allocator. The
// failing radio had 40964 bytes free but no internal block >= 12288 bytes;
// a tiny pointer must replace the 4096-byte static internal coefficient array.
const allocate = new Function('coefficients_', 'heap_caps_aligned_alloc', 'SpectrumLog',
  'SpectrumMath', 'MALLOC_CAP_SPIRAM', 'MALLOC_CAP_8BIT', `
  const floatCast = value => value;
  if (!coefficients_) ${body(source, 'if (!coefficients_)')
    .replace(/static_cast<float\*>/g, 'floatCast').replace(/sizeof\(float\)/g, '4')
    .replace(/SpectrumMath::/g, 'SpectrumMath.').replace(/SpectrumLog::/g, 'SpectrumLog.')}
  return coefficients_;
`);

test('FFT coefficients allocate only aligned PSRAM and remain reusable across initialization retries', () => {
  const calls = [];
  const table = {};
  const run = value => allocate(value, (...args) => { calls.push(args); return table; },
    { printf() { assert.fail('unexpected allocation failure'); } }, { POINT_COUNT: 1024 }, 1, 2);
  assert.equal(run(null), table);
  assert.deepEqual(calls, [[16, 4096, 3]]);
  assert.equal(run(table), table);
  assert.equal(calls.length, 1);
});

test('failed PSRAM allocation stops initialization without trying the fragmented internal heap', () => {
  const calls = [], messages = [];
  const result = allocate(null, (...args) => { calls.push(args); return null; },
    { printf: message => messages.push(message) }, { POINT_COUNT: 1024 }, 1, 2);
  assert.equal(result, false);
  assert.deepEqual(calls, [[16, 4096, 3]]);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /PSRAM FFT coefficients unavailable/);
  const begin = body(source, 'bool AudioSpectrum::begin(');
  assert.ok(begin.indexOf('if (!coefficients_)') < begin.indexOf('if (!fftSelfTest())'));
  assert.ok(begin.indexOf('if (!fftSelfTest())') < begin.indexOf('SpectrumOutput::begin'));
  assert.ok(begin.indexOf('SpectrumOutput::begin') < begin.indexOf('xTaskCreatePinnedToCore'));
});

test('task-owned FFT work stays aligned in PSRAM; the cache-safe DMA observer remains internal', () => {
  assert.match(header, /float\* coefficients_ = nullptr/);
  assert.doesNotMatch(header, /std::array[^;]+coefficients_/);
  assert.match(header, /float\* work_ = nullptr/);
  const transform = body(source, 'int AudioSpectrum::transform(');
  assert.match(transform, /dsps_fft2r_fc32_aes3_\(work_, SpectrumMath::POINT_COUNT, coefficients_\)/);
  assert.match(transform, /dsps_fft2r_fc32_ansi_\(work_, SpectrumMath::POINT_COUNT, coefficients_\)/);
  const output = fs.readFileSync(path.join(root, 'src/audio/audio_output.cpp'), 'utf8');
  assert.match(output, /DRAM_ATTR int32_t pcm/);
  const isr = body(output, 'bool IRAM_ATTR onSent(').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(isr, /coefficients_|window_|PSRAM|heap_caps|transform\(/);
});

test('the 8 KiB FFT work buffer reuses aligned external storage and fails without an internal fallback',()=>{
 const run=new Function('work_','heap_caps_aligned_alloc','SpectrumLog','SpectrumMath','MALLOC_CAP_SPIRAM','MALLOC_CAP_8BIT',
  'const floatCast=value=>value; if(!work_) '+body(source,'if (!work_)')
   .replace(/static_cast<float\*>/g,'floatCast').replace(/sizeof\(float\)/g,'4')
   .replace(/SpectrumMath::/g,'SpectrumMath.').replace(/SpectrumLog::/g,'SpectrumLog.')+';return work_;');
 const calls=[],logs=[],buffer={};
 const allocate=()=>run(null,(...args)=>{calls.push(args);return buffer;},{printf:m=>logs.push(m)},{POINT_COUNT:1024},1,2);
 assert.equal(allocate(),buffer);assert.deepEqual(calls,[[16,8192,3]]);
 assert.equal(run(buffer,()=>assert.fail('initialization retry reallocated work'),{}, {},1,2),buffer);
 assert.equal(run(null,()=>null,{printf:m=>logs.push(m)},{POINT_COUNT:1024},1,2),false);
 assert.equal(logs.length,1);assert.match(logs[0],/PSRAM FFT work buffer unavailable/);
 assert.ok(body(source,'bool AudioSpectrum::begin(').indexOf('if (!work_)')<body(source,'bool AudioSpectrum::begin(').indexOf('if (!fftSelfTest())'));
});
