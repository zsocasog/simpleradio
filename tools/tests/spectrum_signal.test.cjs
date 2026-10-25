const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const math = read("src/audio/spectrum_math.h");
const dynamics = read("src/audio/spectrum_dynamics.h");

// Execute the arithmetic bodies of the PRODUCTION C++ policy in a small JS
// bridge. Independently, spectrum_math.cpp compiles these headers for ESP32.
// This bridge only erases C++ types/casts; it does not reimplement the policy.
function body(source, name) {
  const match = source.match(new RegExp(`\\b${name}\\([^\\n]*\\)\\s*\\{`));
  assert.ok(match, `missing production function ${name}`);
  const start = source.indexOf("{", match.index);
  let nesting = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === "{") ++nesting;
    if (source[i] === "}" && --nesting === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unclosed function ${name}`);
}

function translate(source) {
  return source
    .replace(/std::array<float,\s*BAND_COUNT> (\w+)\{\}/g, "let $1 = new Float64Array(BAND_COUNT)")
    .replace(/static_cast<float>\(/g, "Number(")
    .replace(/static_cast<(?:unsigned|size_t|int)>\(/g, "Math.trunc(")
    .replace(/\bconst (?:float|size_t|uint32_t|uint64_t|int64_t|unsigned|BinRange)\s+/g, "const ")
    .replace(/\b(?:float|size_t|uint32_t|uint64_t|int64_t|unsigned)\s+/g, "let ")
    .replace(/\b([0-9]+(?:\.[0-9]*)?(?:e[+-]?[0-9]+)?)f\b/gi, "$1")
    .replace(/HEIGHT\.size\(\)/g, "HEIGHT.length")
    .replace(/HEIGHT\.back\(\)/g, "HEIGHT[HEIGHT.length - 1]")
    .replace(/Curve::/g, "Curve.")
    .replace(/SpectrumMath::SILENCE_DB/g, "SILENCE_DB")
    .replace(/\blog10f\(/g, "Math.log10(")
    .replace(/\bmax\(/g, "Math.max(");
}

const constants = [...math.matchAll(/constexpr (?:size_t|uint32_t|float) (\w+) = ([^;]+);/g)]
  .map((m) => `const ${m[1]} = ${translate(m[2])};`).join("\n");
const edges = translate(math.match(/BAND_EDGES_HZ = \{([^]*?)\};/)[1]);
const heights = translate(dynamics.match(/HEIGHT = \{([^]*?)\};/)[1]);
const functions = [
  ["bandForFrequency", "hz"], ["bandUpperHz", "band, sampleRate"],
  ["binBandWeight", "bin, band, sampleRate"], ["rmsBandPower", "weightedPower, windowEnergy"],
  ["stereoBinPower", "real, imag, mirrorReal, mirrorImag"],
  ["prepareFrame", "samples, window, work, fullScale = 32768"],
  ["bandPowers", "transformed, sampleRate, windowEnergy"],
  ["smoothLevel", "current, target, elapsedMs"],
].map(([name, args]) => `function ${name}(${args}) ${translate(body(math, name))}`).join("\n");
const rangeBody = translate(body(math, "binsForBand"))
  .replace(/return \{([^,{}]*),([^{}]*)\}/g, "return { first: $1, last: $2 }")
  .replace(/return \{\}/g, "return { first: 1, last: 0 }");
const production = vm.runInNewContext(`
  ${constants}
  const BAND_EDGES_HZ = [${edges}], HEIGHT = [${heights}];
  const DISPLAY_SILENCE_DB = ${translate(dynamics.match(/constexpr float SILENCE_DB = ([^;]+);/)[1])};
  const Curve = { Soft: 0, Linear: 1, Log: 2 };
  function clamp(value, low, high) ${translate(body(dynamics, "clamp"))}
  function displayLevel(measuredDb, sensitivity) ${translate(body(dynamics, "displayLevel")).replace(/\bSILENCE_DB\b/g, "DISPLAY_SILENCE_DB")}
  function binsForBand(band, sampleRate) ${rangeBody}
  function gainDb(volume, curve) ${translate(body(read("src/audio/volume_math.h"), "gainDb"))}
  function powerDb(power, playbackGainDb = 0) ${translate(body(read("src/audio/audio_spectrum.cpp"), "powerDb"))}
  ${functions}
  ({ POINT_COUNT, BAND_COUNT, BAND_EDGES_HZ, prepareFrame, bandPowers,
     bandForFrequency, displayLevel, smoothLevel, gainDb, powerDb, Curve });
`);

const N = production.POINT_COUNT;
const window = Float64Array.from({ length: N }, (_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / N)));
const windowEnergy = window.reduce((sum, value) => sum + value * value, 0);

// Independent direct DFT, not a copy of the ESP-DSP FFT or stereo unpacker.
function dft(input) {
  const out = new Float64Array(N * 2);
  for (let k = 0; k < N; ++k) {
    let real = 0, imag = 0;
    for (let i = 0; i < N; ++i) {
      const phase = -2 * Math.PI * k * i / N;
      const c = Math.cos(phase), s = Math.sin(phase);
      real += input[i * 2] * c - input[i * 2 + 1] * s;
      imag += input[i * 2] * s + input[i * 2 + 1] * c;
    }
    out[k * 2] = real;
    out[k * 2 + 1] = imag;
  }
  return out;
}

function signal(tones, { sampleRate = 44100, attenuationDb = 0, antiphase = false, dc = 0 } = {}) {
  return Int32Array.from({ length: N * 2 }, (_, index) => {
    const i = index >> 1;
    let value = dc;
    for (const [hz, amplitude] of tones) value += amplitude * Math.cos(2 * Math.PI * hz * i / sampleRate + 0.37);
    if (antiphase && (index & 1)) value = -value;
    return Math.round(value * 10 ** (attenuationDb / 20) * 2147483648);
  });
}

function analyze(samples, { sampleRate = 44100, attenuationDb = 0 } = {}) {
  const work = new Float64Array(N * 2);
  const rms = production.prepareFrame(samples, window, work, 2147483648);
  const powers = production.bandPowers(dft(work), sampleRate, windowEnergy);
  const db = Array.from(powers, (power) => production.powerDb(power, attenuationDb));
  return { powers, db, rmsDb: production.powerDb(rms, attenuationDb),
    levels: db.map((value) => production.displayLevel(value, 100)) };
}

test("full Q31 -> window -> DFT -> production bands tracks a frequency sweep", () => {
  for (const sampleRate of [44100, 48000]) {
    for (const hz of [63, 250, 1000, 4000, 10000]) {
      const result = analyze(signal([[hz, 0.25]], { sampleRate }), { sampleRate });
      const dominant = result.db.indexOf(Math.max(...result.db));
      const expected = production.bandForFrequency(hz);
      assert.ok(Math.abs(dominant - expected) <= 1, `${hz}Hz at ${sampleRate}: band ${dominant}, expected near ${expected}`);
      assert.ok(result.levels[dominant] > 50 && result.levels[dominant] < 220);
      assert.ok(result.levels.every(Number.isFinite));
    }
  }
});

test("EQ-like bass attenuation changes bass, not the unaffected treble band", () => {
  const before = analyze(signal([[250, 0.25], [4000, 0.25]]));
  const after = analyze(signal([[250, 0.25 * 10 ** (-12 / 20)], [4000, 0.25]]));
  const low = before.db.slice(0, 8).indexOf(Math.max(...before.db.slice(0, 8)));
  const high = production.bandForFrequency(4000);
  assert.ok(after.db[low] < before.db[low] - 11.8);
  assert.ok(Math.abs(after.db[high] - before.db[high]) < 0.1);
  assert.ok(after.levels[low] < before.levels[low] * 0.52);
});

test("quiet Q31 output is volume-compensated without changing spectral shape", () => {
  const baseline = analyze(signal([[1000, 0.4], [8000, 0.2]]));
  for (const curve of Object.values(production.Curve)) {
    const attenuationDb = production.gainDb(35, curve);
    const quieter = analyze(signal([[1000, 0.4], [8000, 0.2]], { attenuationDb }), { attenuationDb });
    for (const hz of [1000, 8000]) {
      const band = production.bandForFrequency(hz);
      assert.ok(Math.abs(baseline.db[band] - quieter.db[band]) < 0.05);
    }
  }
});

test("opposite-phase stereo does not cancel, and DC/silence cannot become organ pipes", () => {
  const normal = analyze(signal([[1000, 0.25]]));
  const opposite = analyze(signal([[1000, 0.25]], { antiphase: true }));
  const band = production.bandForFrequency(1000);
  assert.ok(Math.abs(normal.db[band] - opposite.db[band]) < 0.01);
  for (const dc of [0, 0.25]) {
    const result = analyze(signal([], { dc, attenuationDb: -60 }), { attenuationDb: -60 });
    assert.ok(result.levels.every((value) => value === 0));
  }
  assert.equal(production.powerDb(0, -60), -120);
});

test("visual sensitivity halves/doubles heights, and quiet tones stay visibly smaller", () => {
  for (const db of [-55, -40, -30, -24, -18, -12]) {
    const normal = production.displayLevel(db, 100);
    assert.ok(Math.abs(production.displayLevel(db, 50) - normal / 2) < 0.0001);
    assert.ok(Math.abs(production.displayLevel(db, 200) - Math.min(255, normal * 2)) < 0.0001);
  }
  assert.ok(production.displayLevel(-30, 100) > 255 * 0.30);
  assert.ok(production.displayLevel(-12.5, 100) > 255 * 0.80);
  assert.equal(production.displayLevel(-100, 200), 0);
});

test("beats rise, softer sections recede, and stop decays monotonically without new PCM", () => {
  let level = 0;
  const weak = production.displayLevel(-36, 100);
  const beat = production.displayLevel(-6, 100);
  for (let i = 0; i < 8; ++i) level = production.smoothLevel(level, weak, 42);
  const before = level;
  for (let i = 0; i < 3; ++i) level = production.smoothLevel(level, beat, 42);
  assert.ok(level > before * 3);
  for (let i = 0; i < 8; ++i) level = production.smoothLevel(level, weak, 42);
  assert.ok(level < beat * 0.3);
  for (let i = 0; i < 24; ++i) {
    const next = production.smoothLevel(level, 0, 42);
    assert.ok(next <= level && next >= 0);
    level = next;
  }
  assert.equal(level, 0);
});

test("one LCD frame catches a beat and releases it without a long plateau", () => {
  const beat = production.displayLevel(-12, 100);
  const first = production.smoothLevel(0, beat, 33);
  assert.ok(first > beat * 0.70);
  const released = production.smoothLevel(first, 0, 33);
  assert.ok(released < first * 0.75);
});
