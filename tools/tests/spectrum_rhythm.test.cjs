const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { loadProduction, fft, generateFrames, createRenderer, simulate, contrast, audit } = require('../spectrum_rhythm_audit.cjs');
const runtime = loadProduction(), p = runtime.production;
const sample = (db, time, generation = 1) => ({ bandDb: Array(24).fill(db), updatedMs: time, generation, active: true });

test('independent desktop FFT agrees with the direct DFT used by the signal tests', () => {
  const input = Float64Array.from({ length: runtime.N * 2 }, (_, i) =>
    Math.sin(i * 0.031) * 0.2 + Math.cos(i * 0.017 + (i & 1)) * 0.1);
  const actual = fft(input), expected = runtime.dft(input);
  for (let i = 0; i < actual.length; ++i) assert.ok(Math.abs(actual[i] - expected[i]) < 1e-8);
});

test('steady energy is quieter; a new smaller rise still adds to a previous accent', () => {
  const band = new p.RhythmBand(); band.update(100, true, true, 1, 0);
  for (let i = 0; i < 30; ++i) band.update(100, true, false, p.accentDecayFactor(33), 0);
  assert.equal(band.accent, 0); assert.equal(p.steadyLevel(100), 72);
  band.update(120, true, false, 1, 0); assert.equal(band.accent, 45);
  band.update(119, true, false, 1, 0); const tail = band.accent;
  band.update(123, true, false, 1, 0); assert.ok(band.accent > tail);
  band.update(124, true, false, 1, 0); // The sub-pixel allowance does not gate the base.
  assert.ok(p.steadyLevel(124) > p.steadyLevel(123));
});

test('accent decays in elapsed time and cannot grow on a repeated LCD sample', () => {
  for (let elapsed = 0; elapsed <= 250; ++elapsed) {
    assert.ok(Math.abs(p.accentDecayFactor(elapsed) - Math.exp(-elapsed / 35)) < 0.0001);
  }
  const band = new p.RhythmBand(); band.update(100, true, true, 1, 0); band.update(120, true, false, 1, 0);
  let previous = band.accent;
  for (let i = 0; i < 15; ++i) {
    band.update(120, false, false, p.accentDecayFactor(33), 0);
    assert.ok(band.accent <= previous); previous = band.accent;
  }
  assert.equal(band.accent, 0);
});

test('the exact LCD update uses the same rhythm policy for all 24 ERB bands', () => {
  const renderer = createRenderer(p);
  for (const [time, db] of [[33, -30], [66, -24], [99, -30], [132, -21]]) {
    const value = sample(db, time);
    value.bandDb = value.bandDb.map((v, band) => v - p.visualCorrectionDb(band));
    const frame = renderer.frame(value, true, time);
    assert.ok(frame.heights.every(height => height === frame.heights[0]));
    assert.ok(frame.accents.every(accent => accent === frame.accents[0]));
  }
});



test('stop and digital silence decay to zero without new PCM, spikes or a residual baseline', () => {
  for (const playing of [false, true]) {
    const renderer = createRenderer(p); renderer.frame(sample(-30, 33), true, 33);
    let previous = renderer.frame(sample(-6, 66), true, 66).heights;
    for (let time = 99; time <= 900; time += 33) {
      const frame = renderer.frame(sample(-120, time), playing, time);
      frame.heights.forEach((height, i) => assert.ok(height <= previous[i])); previous = frame.heights;
    }
    assert.ok(previous.every(value => value === 0));
  }
});

test('a stale sample cannot retrigger, and a new generation initializes without an artificial beat', () => {
  const renderer = createRenderer(p); renderer.frame(sample(-30, 33), true, 33);
  renderer.frame(sample(-12, 66), true, 66);
  const stale = renderer.frame(sample(-12, 66), true, 400);
  assert.equal(renderer.state.hasSample, false);
  const returned = renderer.frame(sample(-6, 433, 2), true, 433);
  assert.ok(returned.accents.every(value => value === 0));
  assert.ok(stale.heights.every(Number.isFinite));
  // A delayed LCD resumes with a current sample; it must not reinterpret the
  // unobserved level change as a beat or replay the previous accent.
  const resumed = renderer.frame(sample(-3, 1200, 2), true, 1200);
  assert.ok(resumed.accents.every(value => value === 0));
});

test('accent and pixel bounds hold at the fixed scale, including very small or invalid inputs', () => {
  {
    const band = new p.RhythmBand(); band.update(0, true, true, 1, 0);
    for (const level of [NaN, 0, 0.5, 2, 3, 20, 255, 0, 255, 0, 255]) {
      const safe = Number.isFinite(level) ? level : 0;
      band.update(level, true, false, p.accentDecayFactor(33), 0);
      const displayed = p.rhythmicDisplayLevel(p.steadyLevel(safe), band.accent);
      assert.ok(Number.isFinite(displayed) && displayed >= 0 && displayed <= 255);
      assert.ok(band.accent >= 0 && band.accent <= 64);
    }
  }
});

test('calmer rendering retains clear beat contrast; a quieter kick is visible on the neighbouring ERB bands', () => {
  const report = audit();
  const strong = report.find(row => row.case === 'equal-kick-over-bass');
  for (const band of strong.bands.slice(0, 3)) assert.ok(band.rhythm.travelFullPx >= 8);
  const quiet = report.find(row => row.case === 'quiet-kick-over-bass');
  // A longer release can bury the tiniest first-bar rise in its existing bed.
  // Require an actual visible beat across the bass region, not every column.
  assert.ok(quiet.bands.slice(0, 3).filter(band => band.rhythm.travelFullPx >= 2).length >= 2);
  const click = report.find(row => row.case === 'click-over-bass');
  for (const band of click.bands.slice(0, 3)) assert.ok(band.rhythm.travelFullPx <= 2);
  assert.ok(click.bands.slice(10).some(band => band.rhythm.travelFullPx > 10));
});

test('constant tones across the range do not acquire a rhythmic accent or large extra jitter', () => {
  for (const hz of [44, 63, 85, 110, 250, 1000, 4000]) {
    const frames = generateFrames(runtime, { bed: 0.22, bedHz: hz, duration: 0.75 });
    const old = simulate(runtime, frames, { rhythm: false, durationMs: 750 });
    const next = simulate(runtime, frames, { durationMs: 750 });
    for (let band = 0; band < 24; ++band) {
      const a = contrast(old, band), b = contrast(next, band);
      assert.ok(b.steadyRangeFullPx <= a.steadyRangeFullPx + 2, `${hz}Hz, bar ${band + 1}`);
      assert.ok(Math.max(...next.slice(8).map(row => row.accents[band])) < 8, `${hz}Hz, false accent in bar ${band + 1}`);
    }
  }
});

test('visibility clear resets all motion state; audio capture and raw band dB are not part of this policy', () => {
  const display = fs.readFileSync(path.join(__dirname, '../../src/display/display.cpp'), 'utf8');
  const clear = display.match(/static void clearVuBars\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(clear, /spectrumRhythm.fill\(\{\}\)/); assert.match(clear, /hasSpectrumMeasurement = false/);
  const source = fs.readFileSync(path.join(__dirname, '../../src/audio/spectrum_dynamics.h'), 'utf8');
  assert.doesNotMatch(source.replace(/\/\/[^\n]*/g, ''), /malloc|new |Serial\.|i2s_|PlayerState|AudioSpectrum::/);
});

test('the added startup marker fits the existing asynchronous log buffer without truncating sync diagnostics', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/audio/audio_spectrum.cpp'), 'utf8');
  const start = source.indexOf('if (report) SpectrumLog::printf(');
  const end = source.indexOf('static_cast<unsigned long>(frame.sampleRate)', start);
  const format = [...source.slice(start, end).matchAll(/"(?:[^"\\]|\\.)*"/g)].map(match => JSON.parse(match[0])).join('');
  const worstCase = format.replace(/%%/g, '\0').replace(/%lu/g, '4294967295').replace(/\0/g, '%');
  assert.ok(Buffer.byteLength(worstCase) + 1 <= 512);
  assert.ok(worstCase.includes('[spectrum] rhythm v6:'));
  assert.ok(worstCase.endsWith('no PSRAM/FFT in ISR\n'));
});
