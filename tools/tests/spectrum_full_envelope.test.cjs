const assert = require('node:assert/strict');
const test = require('node:test');
const { loadProduction, createRenderer, generateFrames, simulate, simulateV4, contrast } = require('../spectrum_rhythm_audit.cjs');
const runtime = loadProduction(), p = runtime.production;
const sample = (db, time) => ({ bandDb: Array.from({ length: 24 }, (_, b) => db - p.visualCorrectionDb(b)),
  updatedMs: time, generation: 1, active: true });

test('the full-height envelope uses 25ms rise and 95ms fall in elapsed time without overshoot', () => {
  for (let ms = 0; ms <= 100; ++ms) {
    assert.ok(Math.abs(p.smoothRhythmLevel(50, 150, ms) - (150 - 100 * Math.exp(-ms / 25))) < .001);
    const down = 50 + 100 * Math.exp(-ms / 95);
    assert.ok(Math.abs(p.smoothRhythmLevel(150, 50, ms) - down) < .001);
  }
  for (const current of [0, 1, 50, 100, 200, 255]) for (const target of [0, 1, 50, 100, 200, 255]) {
    const next = p.smoothRhythmLevel(current, target, 33);
    assert.ok(next >= Math.min(current, target) && next <= Math.max(current, target));
  }
});

test('opening the screen seeds its real level; subsequent small AND large changes are smoothed on all 24 columns', () => {
  const renderer = createRenderer(p);
  renderer.frame(sample(-30, 33), true, 33);
  const first = renderer.state.envelope.slice();
  const row = renderer.frame(sample(-12, 66), true, 66);
  for (let b = 0; b < 24; ++b) {
    const target = p.steadyLevel(renderer.state.rhythm[b].previousLevel) + row.accents[b];
    assert.ok(renderer.state.envelope[b] > first[b]);
    assert.ok(renderer.state.envelope[b] < target); // No amplitude-dependent bypass.
    assert.equal(renderer.state.envelope[b], renderer.state.envelope[0]);
  }
  const peak = renderer.state.envelope.slice();
  renderer.frame(sample(-120, 99), true, 99);
  for (let b = 0; b < 24; ++b) assert.ok(renderer.state.envelope[b] < peak[b] && renderer.state.envelope[b] > 0);
});

test('the captured-music comparison reference retains the preceding v4 peak contrast', () => {
  const frames = generateFrames(runtime, { bed: .22, kick: .22 });
  const before = simulateV4(runtime, frames), after = simulate(runtime, frames);
  assert.deepEqual([0, 1, 2].map(b => Math.round(contrast(before, b).travelFullPx)), [10, 16, 10]);
  for (let b = 0; b < 3; ++b) {
    assert.ok(contrast(after, b).travelFullPx >= contrast(before, b).travelFullPx * .7);
    const onset = rows => rows.find(row => row.t >= 500 && row.heights[b] >= contrast(rows, b).base + 1)?.t;
    assert.ok(onset(after) >= onset(before) && onset(after) <= onset(before) + 33);
  }
});

test('clear quieter hits after stronger ones stay visible; borderline one-pixel events are reported separately', () => {
  let clear = 0, borderline = 0, borderlineLost = 0;
  for (const sampleRate of [44100, 48000]) for (const beatInterval of [.125, .25]) {
    const frames = generateFrames(runtime, { bed: .22, kickPattern: [.22, .07], sampleRate, beatInterval, duration: 3 });
    const before = simulateV4(runtime, frames, { durationMs: 3000 }), after = simulate(runtime, frames, { durationMs: 3000 });
    for (let at = 500 + beatInterval * 1000; at < 2700; at += beatInterval * 2000) {
      const swing = rows => Math.max(...[0, 1, 2].map(b => {
        const pre = rows.filter(row => row.t >= at && row.t < at + 45).map(row => row.heights[b]);
        const hit = rows.filter(row => row.t >= at + 45 && row.t < at + 110).map(row => row.heights[b]);
        return Math.max(...hit) - Math.min(...pre);
      }));
      const old = swing(before), next = swing(after);
      if (old >= 2) { ++clear; assert.ok(next >= 1, `${sampleRate}Hz, ${beatInterval}s, ${at}ms`); }
      else if (old === 1) { ++borderline; if (next < 1) ++borderlineLost; }
    }
  }
  assert.ok(clear >= 15 && borderline > 0);
  // A material limit of smoothing on a 32px half-height display, deliberately
  // visible in the report rather than a claim that every faint beat is retained.
  console.log(JSON.stringify({ clearBeatCases: clear, borderlineBeatCases: borderline, borderlineLost }));
});
