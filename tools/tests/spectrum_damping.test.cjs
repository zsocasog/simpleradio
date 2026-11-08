const assert = require('node:assert/strict');
const test = require('node:test');
const { loadProduction, generateFrames, simulate, createRenderer, contrast } = require('../spectrum_rhythm_audit.cjs');
const runtime = loadProduction(), p = runtime.production;
// Disable only the new conditioner to reproduce the preceding v3 pipeline.
const undamped = { ...runtime, production: { ...p, smallMotionDecayFactor: () => 0 } };

test('small-motion damping uses elapsed time and remains bounded in both directions', () => {
  for (let ms = 0; ms <= 250; ++ms) {
    const decay = p.smallMotionDecayFactor(ms);
    assert.ok(Math.abs(decay - Math.exp(-ms / 40)) < 0.0001);
    for (let current = 0; current <= 255; current += 17) for (let target = 0; target <= 255; target += 3) {
      const next = p.dampSmallMotion(current, target, decay);
      assert.ok(next >= Math.min(current, target) && next <= Math.max(current, target));
      assert.ok(Math.abs(next - target) <= 4 * decay + 1e-9);
      if (Math.abs(target - current) >= 8) assert.equal(next, target);
    }
  }
});

test('persistent sub-pixel changes settle without a dead zone, and clear rises or falls pass on the first frame', () => {
  for (const delta of [-20, -8, -2, -.1, .1, 2, 8, 20]) {
    let current = 100; const target = current + delta;
    for (let i = 0; i < 24; ++i) current = p.dampSmallMotion(current, target, p.smallMotionDecayFactor(33));
    assert.ok(Math.abs(current - target) < 1e-7);
  }
  for (const ms of [8, 16, 25, 33, 50, 100]) {
    for (const target of [0, 50, 92, 108, 120, 255]) {
      assert.equal(p.dampSmallMotion(100, target, p.smallMotionDecayFactor(ms)), target);
    }
  }
});

test('a repeated LCD snapshot cannot advance the conditioner or trigger another accent', () => {
  const band = new p.RhythmBand(), motion = p.smallMotionDecayFactor(33);
  band.update(100, true, true, 1, motion);
  band.update(103, true, false, 1, motion);
  assert.ok(band.previousLevel > 100 && band.previousLevel < 103);
  const level = band.previousLevel, accent = band.accent;
  band.update(103, false, false, p.accentDecayFactor(33), motion);
  assert.equal(band.previousLevel, level); assert.ok(band.accent <= accent);
  band.update(200, true, true, 1, motion);
  assert.equal(band.previousLevel, 200); assert.equal(band.accent, 0);
});

test('the actual 24-column LCD pipeline damps small flutter uniformly across the entire ERB axis', () => {
  const frames = Array.from({ length: 80 }, (_, i) => ({ ready: 25 * i, captured: 25 * i,
    db: Array.from({ length: 24 }, (_, b) => -26 + .5 * Math.sin(2 * Math.PI * 8 * i / 40) - p.visualCorrectionDb(b)) }));
  const before = simulate(undamped, frames, { durationMs: 2000 });
  const after = simulate(runtime, frames, { durationMs: 2000 });
  const travel = (rows, b) => rows.slice(10).reduce((sum, row, i) => sum + Math.abs(row.heights[b] - rows[i + 9].heights[b]), 0);
  for (let b = 0; b < 24; ++b) {
    assert.ok(travel(before, b) > 0);
    assert.ok(travel(after, b) <= travel(before, b) * .6, `bar ${b + 1}`);
    assert.ok(after.every(row => row.heights[b] === row.heights[0]));
  }
});

test('strong and quieter Q31 kicks remain visible with the intended rounded peaks', () => {
  for (const fixture of [{ kick: .22 }, { bed: .22, kick: .22 }, { bed: .22, kick: .07 }]) {
    const frames = generateFrames(runtime, fixture), before = simulate(undamped, frames), after = simulate(runtime, frames);
    let visible = 0;
    for (let b = 0; b < 3; ++b) {
      const old = contrast(before, b), next = contrast(after, b);
      if (next.travelFullPx >= 2) ++visible;
      // Full-bar attack smoothing deliberately rounds the first peak. Keep
      // strong hits at >=70% of the reference contrast and quiet ones visible.
      const minimum = old.travelFullPx >= 8 ? old.travelFullPx * .7 : 0;
      assert.ok(next.travelFullPx >= minimum, `bar ${b + 1}, kick ${fixture.kick}`);
      const onset = rows => rows.find(row => row.t >= 500 && row.accents[b] >= 3)?.t;
      assert.notEqual(onset(before), undefined);
      assert.ok(onset(after) >= onset(before) && onset(after) <= onset(before) + 33);
    }
    assert.ok(visible >= 2, "the bass region must still show the quiet kick");
  }
});

test('fast 125ms and 250ms beats stay separated at 44.1kHz and 48kHz', () => {
  for (const sampleRate of [44100, 48000]) for (const beatInterval of [.125, .25]) {
    const frames = generateFrames(runtime, { bed: .22, kick: .22, beatInterval, sampleRate, duration: 2.5 });
    const rows = simulate(runtime, frames, { durationMs: 2500 });
    for (let at = 500; at < 2300; at += beatInterval * 1000) {
      const hit = rows.filter(row => row.t >= at && row.t < at + beatInterval * 1000);
      for (const b of [0, 1]) {
        const heights = hit.map(row => row.heights[b]);
        assert.ok(Math.max(...heights) - Math.min(...heights) >= 1, `${sampleRate}Hz, ${beatInterval}s, bar ${b + 1}, ${at}ms`);
      }
    }
  }
});
