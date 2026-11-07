// Offline, deterministic Q31 -> FFT -> ERB -> production LCD motion audit.
// No serial/device access. Run from any directory with Node.js.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
function body(source, marker) {
  const at = source.indexOf(marker); assert.ok(at >= 0, marker);
  const start = source.indexOf('{', at); let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(marker);
}
function loadProduction() {
  // Share the numerical tests' type-erasure bridge instead of reimplementing
  // any FFT weighting, sensitivity, accent or envelope rule in the audit.
  const tests = path.join(root, 'tools/tests');
  const source = fs.readFileSync(path.join(tests, 'spectrum_signal.test.cjs'), 'utf8');
  const end = source.indexOf('test("full Q31'); assert.ok(end > 0);
  const context = { require, __dirname: tests }; vm.createContext(context);
  vm.runInContext(source.slice(0, end) + '\nglobalThis.runtime={production,N,window,windowEnergy,dft};', context);
  return context.runtime;
}
// Independent desktop FFT for longer time-series fixtures. A direct DFT in
// the numerical tests checks this backend too; ESP32 still uses ESP-DSP.
function fft(input) {
  const a = Float64Array.from(input), n = a.length / 2;
  for (let i = 1, j = 0; i < n; ++i) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) for (let component = 0; component < 2; ++component) {
      const x = 2 * i + component, y = 2 * j + component;
      [a[x], a[y]] = [a[y], a[x]];
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = -2 * Math.PI / size, c = Math.cos(angle), s = Math.sin(angle);
    for (let i = 0; i < n; i += size) {
      let wr = 1, wi = 0;
      for (let j = 0; j < size / 2; ++j) {
        const u = 2 * (i + j), v = 2 * (i + j + size / 2);
        const real = a[v] * wr - a[v + 1] * wi, imag = a[v] * wi + a[v + 1] * wr;
        a[v] = a[u] - real; a[v + 1] = a[u + 1] - imag;
        a[u] += real; a[u + 1] += imag;
        const next = wr * c - wi * s; wi = wr * s + wi * c; wr = next;
      }
    }
  }
  return a;
}
function generateFrames(runtime, { bed = 0, kick = 0, click = 0, bedHz = 63, kickHz = 85,
                                  duration = 1.5, sampleRate = 44100, beatInterval = 0.5, kickPattern } = {}) {
  const { production: p, N, window, windowEnergy } = runtime;
  const frames = [], hop = Math.max(N, Math.floor(sampleRate / 40));
  for (let start = 0; start < sampleRate * duration; start += hop) {
    const samples = Int32Array.from({ length: N * 2 }, (_, i) => {
      const t = (start + (i >> 1)) / sampleRate, phase = t < 0.5 ? 0 : (t - 0.5) % beatInterval;
      const kickLevel = kickPattern?.length ? kickPattern[Math.max(0, Math.floor((t - 0.5) / beatInterval)) % kickPattern.length] : kick;
      const pulse = t < 0.5 ? 0 : Math.min(1, phase / 0.002) * Math.exp(-phase / 0.045);
      return Math.round((bed * Math.sin(2 * Math.PI * bedHz * t) + pulse *
        (kickLevel * Math.sin(2 * Math.PI * kickHz * t + 0.3) + click * Math.sin(2 * Math.PI * 3000 * t + 0.1))) * 2147483648);
    });
    const work = new Float64Array(N * 2); p.prepareFrame(samples, window, work, 2147483648);
    const powers = p.bandPowers(fft(work), sampleRate, windowEnergy);
    frames.push({ ready: (start + N) * 1000 / sampleRate + 10,
      captured: Math.floor((start + N / 2) * 1000 / sampleRate),
      db: Array.from(powers, value => p.powerDb(value, 0)) });
  }
  return frames;
}
function createRenderer(p, sensitivity = 100) {
  const display = fs.readFileSync(path.join(root, 'src/display/display.cpp'), 'utf8');
  const translated = body(display, 'static bool updateSpectrumBars(')
    .replace('spectrum = AudioSpectrum::instance().snapshot();', 'spectrum = input;')
    .replace(/SpectrumMath::|SpectrumDynamics::/g, 'p.')
    .replace('AppConfig::instance().displayVuSensitivity', 'state.sensitivity')
    .replace(/const (?:unsigned long|bool|uint32_t|uint16_t|float|uint8_t) /g, 'const ')
    .replace(/\b(?:bool|uint32_t|size_t) /g, 'let ')
    .replace(/min<uint32_t>/g, 'Math.min')
    .replace(/static_cast<uint8_t>\(lroundf\(([^;]+)\)\)/g, 'Math.round($1)')
    .replace(/([0-9]+(?:\.[0-9]*)?)f\b/g, '$1');
  const state = { sensitivity, envelope: Array(24).fill(0),
    rhythm: Array.from({ length: 24 }, () => new p.RhythmBand()), bars: Array(24).fill(0),
    lastEnvelope: 0, lastSample: 0, lastGeneration: 0, hasSample: false };
  const frame = new Function('p', 'state', 'input', 'playing', 'now', `
    const spectrumEnvelope=state.envelope, spectrumRhythm=state.rhythm, vuBars=state.bars;
    const VU_SYMMETRIC_MAX_H=32, VU_BAR_COUNT=24, SPECTRUM_RENDER_MS=33;
    const millis=()=>now, constrain=p.clamp;
    let spectrum, lastSpectrumEnvelopeMs=state.lastEnvelope, lastSpectrumSampleMs=state.lastSample;
    let lastSpectrumGeneration=state.lastGeneration, hasSpectrumMeasurement=state.hasSample;
    const active=(()=>${translated})();
    state.lastEnvelope=lastSpectrumEnvelopeMs; state.lastSample=lastSpectrumSampleMs;
    state.lastGeneration=lastSpectrumGeneration; state.hasSample=hasSpectrumMeasurement;
    return {active, heights:[...vuBars], accents:state.rhythm.map(band=>band.accent)};
  `);
  return { state, frame: (input, playing, now) => frame(p, state, input, playing, now) };
}
function simulate(runtime, frames, { rhythm = true, sensitivity = 100, durationMs = 1500 } = {}) {
  const p = runtime.production, renderer = createRenderer(p, sensitivity), oldEnvelope = Array(24).fill(0);
  const rendered = []; let used = -1;
  for (let t = 33; t < durationMs; t += 33) {
    const newest = frames.findLastIndex(frame => frame.ready <= t);
    if (newest < 0) continue;
    const db = [...frames[newest].db];
    for (let j = used + 1; j < newest; ++j) if (frames[newest].ready - frames[j].ready <= 33) {
      for (let band = 0; band < 24; ++band) db[band] = Math.max(db[band], frames[j].db[band]);
    }
    used = newest;
    const sample = { bandDb: db, updatedMs: frames[newest].captured, generation: 1, active: true };
    let result;
    if (rhythm) result = renderer.frame(sample, true, t);
    else {
      for (let band = 0; band < 24; ++band) oldEnvelope[band] = p.smoothLevel(oldEnvelope[band], p.bandDisplayLevel(db[band], band, sensitivity), 33);
      result = { heights: oldEnvelope.map(value => Math.round(value * 32 / 255)), accents: Array(24).fill(0) };
    }
    rendered.push({ t, ...result });
  }
  return rendered;
}
function contrast(rows, band, beatAt = 500) {
  const quiet = rows.filter(row => row.t >= beatAt - 170 && row.t < beatAt - 5).map(row => row.heights[band]);
  const hit = rows.filter(row => row.t >= beatAt && row.t <= beatAt + 160).map(row => row.heights[band]);
  const base = quiet.reduce((sum, value) => sum + value, 0) / quiet.length, peak = Math.max(...hit);
  return { base, peak, travelFullPx: (peak - base) * 2,
    steadyRangeFullPx: (Math.max(...quiet) - Math.min(...quiet)) * 2 };
}

// Frozen v4 composition for A/B checks: the production 45ms envelope was on
// steady energy only, with the 35ms accent added afterwards. Reuse those
// production calculations; only their former order is retained here.
function simulateV4(runtime, frames, options = {}) {
  const p = runtime.production, states = [], steady = [];
  let column = 0;
  class ReferenceBand extends p.RhythmBand {
    constructor() { super(); this.referenceIndex = states.length; states.push(this); steady.push(NaN); }
    update(...args) {
      super.update(...args);
      if (!Number.isFinite(steady[this.referenceIndex])) steady[this.referenceIndex] = p.steadyLevel(this.previousLevel);
    }
  }
  const production = { ...p, RhythmBand: ReferenceBand,
    smoothRhythmLevel(current, target, elapsedMs) {
      const band = column++ % 24, accent = states[band].accent;
      steady[band] = p.smoothLevel(steady[band], Math.max(0, target - accent), elapsedMs);
      return steady[band] + accent;
    } };
  return simulate({ ...runtime, production }, frames, options);
}
function audit() {
  const runtime = loadProduction(), scenarios = [
    { name: 'isolated-kick', kick: 0.22 }, { name: 'equal-kick-over-bass', bed: 0.22, kick: 0.22 },
    { name: 'quiet-kick-over-bass', bed: 0.22, kick: 0.07 },
    { name: 'steady-bass', bed: 0.22 }, { name: 'click-over-bass', bed: 0.22, click: 0.22 }
  ];
  return scenarios.map(scenario => {
    const frames = generateFrames(runtime, scenario), old = simulate(runtime, frames, { rhythm: false }), next = simulate(runtime, frames);
    return { case: scenario.name, bands: Array.from({ length: 24 }, (_, band) => ({ bar: band + 1,
      old: contrast(old, band), rhythm: contrast(next, band) })), trace: next };
  });
}
module.exports = { loadProduction, fft, generateFrames, createRenderer, simulate, simulateV4, contrast, audit };
if (require.main === module) {
  const variant = fs.readFileSync(path.join(root, 'src/audio/audio_spectrum.cpp'), 'utf8')
    .match(/\[spectrum\] rhythm (v\d+):/)?.[1] || 'current';
  const results = audit(), output = path.join(root, `.pio/artifacts/spectrum-rhythm-${variant}`);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'production-comparison.json'), JSON.stringify(results, null, 2));
  for (const row of results) console.log(row.case, JSON.stringify(row.bands.slice(0, 3)));
}
