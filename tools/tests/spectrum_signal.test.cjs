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
    .replace(/\b(?:float|size_t|uint32_t|uint64_t|int64_t|unsigned|int)\s+/g, "let ")
    .replace(/\b([0-9]+(?:\.[0-9]*)?(?:e[+-]?[0-9]+)?)f\b/gi, "$1")
    .replace(/HEIGHT\.size\(\)/g, "HEIGHT.length")
    .replace(/HEIGHT\.back\(\)/g, "HEIGHT[HEIGHT.length - 1]")
    .replace(/ERB_KNOTS_HZ\.back\(\)/g, "ERB_KNOTS_HZ[ERB_KNOTS_HZ.length - 1]")
    .replace(/Curve::/g, "Curve.")
    .replace(/SpectrumMath::SILENCE_DB/g, "SILENCE_DB")
    .replace(/\blog10f\(/g, "Math.log10(")
    .replace(/\bmax\(/g, "Math.max(");
}

const constants = [...math.matchAll(/constexpr (?:size_t|uint32_t|float) (\w+) = ([^;]+);/g)]
  .map((m) => `const ${m[1]} = ${translate(m[2])};`).join("\n");
const knots = translate(math.match(/ERB_KNOTS_HZ = \{([^]*?)\};/)[1]);
const heights = translate(dynamics.match(/HEIGHT = \{([^]*?)\};/)[1]);
const functions = [
  ["bandForFrequency", "hz"], ["bandUpperHz", "band, sampleRate"],
  ["bandCenterHz", "band"], ["triangleWeight", "hz, band"],
  ["binBandWeight", "bin, band, sampleRate"], ["rmsBandPower", "weightedPower, windowEnergy"],
  ["stereoBinPower", "real, imag, mirrorReal, mirrorImag"],
  ["prepareFrame", "samples, window, work, fullScale = 32768"],
  ["bandPowers", "transformed, sampleRate, windowEnergy"],
  ["cachedBandPowers", "transformed, plan, windowEnergy"],
  ["smoothLevel", "current, target, elapsedMs"],
].map(([name, args]) => `function ${name}(${args}) ${translate(body(math, name))}`).join("\n");
const rangeBody = translate(body(math, "binsForBand"))
  .replace(/return \{([^,{}]*),([^{}]*)\}/g, "return { first: $1, last: $2 }")
  .replace(/return \{\}/g, "return { first: 1, last: 0 }");
const configureBody = translate(body(math, "configure"))
  .replace(/\b(sampleRate|ranges|weights)\b/g, 'this.$1');
const production = vm.runInNewContext(`
  ${constants}
  const ERB_KNOTS_HZ = [${knots}], HEIGHT = [${heights}];
  const DISPLAY_SILENCE_DB = ${translate(dynamics.match(/constexpr float SILENCE_DB = ([^;]+);/)[1])};
  const Curve = { Soft: 0, Linear: 1, Log: 2 };
  function clamp(value, low, high) ${translate(body(dynamics, "clamp"))}
  function displayLevel(measuredDb, sensitivity) ${translate(body(dynamics, "displayLevel")).replace(/\bSILENCE_DB\b/g, "DISPLAY_SILENCE_DB")}
  function visualCorrectionDb(band) ${translate(body(dynamics, "visualCorrectionDb"))}
  function bandDisplayLevel(measuredDb, band, sensitivity) ${translate(body(dynamics, "bandDisplayLevel"))}
  function binsForBand(band, sampleRate) ${rangeBody}
  function gainDb(volume, curve) ${translate(body(read("src/audio/volume_math.h"), "gainDb"))}
  function powerDb(power, playbackGainDb = 0) ${translate(body(read("src/audio/audio_spectrum.cpp"), "powerDb"))}
  ${functions}
  class BandPlan {
    constructor(){ this.sampleRate=0;this.ranges=Array.from({length:BAND_COUNT},()=>({first:1,last:0}));
      this.weights=Array.from({length:BAND_COUNT},()=>new Float64Array(POINT_COUNT/2)); }
    configure(rate) ${configureBody}
  }
  ({ POINT_COUNT, BAND_COUNT, ERB_KNOTS_HZ, prepareFrame, bandPowers, cachedBandPowers, BandPlan,
     bandForFrequency, bandCenterHz, binBandWeight, displayLevel, bandDisplayLevel, smoothLevel, gainDb, powerDb, Curve });
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
    levels: db.map((value, band) => production.bandDisplayLevel(value, band, 100)) };
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

test("one LCD frame catches a beat and the envelope recedes before the next beat", () => {
  const beat = production.displayLevel(-12, 100);
  const first = production.smoothLevel(0, beat, 33);
  assert.ok(first > beat * 0.70);
  const released = production.smoothLevel(first, 0, 33);
  assert.ok(released > first * 0.50 && released < first * 0.65);
  let tail=released;
  for(let i=0;i<3;++i) tail=production.smoothLevel(tail,0,33);
  assert.ok(tail>0 && tail<first*0.15); // Clear valley after 132 ms; no abrupt cut.
});

test("24 ERB peaks use fixed Hz positions and uniform ERB-rate spacing", () => {
  const knots=Array.from(production.ERB_KNOTS_HZ);
  assert.equal(knots.length,26);assert.equal(knots[0],20);assert.equal(knots[25],18000);
  const erb=hz=>21.4*Math.log10(1+0.00437*hz);
  const step=(erb(18000)-erb(20))/25;
  for(let i=1;i<knots.length;++i){
    assert.ok(knots[i]>knots[i-1]);
    assert.ok(Math.abs(erb(knots[i])-erb(knots[i-1])-step)<1e-6);
  }
  assert.ok(production.bandCenterHz(0)>60 && production.bandCenterHz(0)<70);
  assert.ok(production.bandCenterHz(23)>15000 && production.bandCenterHz(23)<15200);
});

test("ERB bin weights agree with independent numerical integration of the triangles", () => {
  const knots=Array.from(production.ERB_KNOTS_HZ);
  for(const rate of [8000,22050,44100,48000,96000,192000]) for(const bin of [1,2,3,8,32,128,511]) {
    const width=rate/N, start=(bin-0.5)*width;
    for(let band=0;band<24;++band){
      const [lo,center,hi]=knots.slice(band,band+3);
      let average=0;
      for(let p=0;p<128;++p){
        const hz=start+(p+0.5)*width/128;
        average+=hz<=lo || hz>=hi ? 0 : hz<center ? (hz-lo)/(center-lo) : (hi-hz)/(hi-center);
      }
      average/=128;
      assert.ok(Math.abs(average-production.binBandWeight(bin,band,rate))<0.0001,`${rate}/${bin}/${band}`);
    }
  }
});

test("overlapping ERB bands share interior energy without doubling it", () => {
  const knots=production.ERB_KNOTS_HZ;
  for(const rate of [8000,44100,48000,192000]) for(let bin=1;bin<N/2;++bin){
    let weight=0;for(let band=0;band<24;++band) weight+=production.binBandWeight(bin,band,rate);
    assert.ok(weight>=0 && weight<1.000001);
    const low=(bin-0.5)*rate/N, high=(bin+0.5)*rate/N;
    if(low>=knots[1] && high<=knots[24]) assert.ok(Math.abs(weight-1)<1e-10);
    if(low>=18000) assert.equal(weight,0);
  }
});

test("cached ERB weights and band powers match the reference, including rate changes", () => {
  const plan=new production.BandPlan();
  const work=new Float64Array(N*2);
  production.prepareFrame(signal([[1000,0.25],[4000,0.125]]),window,work,2147483648);
  const transformed=dft(work);
  for(const rate of [44100,48000,8000,192000,44100]){
    plan.configure(rate);
    for(let band=0;band<24;++band) for(let bin=0;bin<N/2;++bin){
      assert.ok(Math.abs(plan.weights[band][bin]-production.binBandWeight(bin,band,rate))<1e-12);
    }
    const cached=production.cachedBandPowers(transformed,plan,windowEnergy);
    const direct=production.bandPowers(transformed,rate,windowEnergy);
    for(let band=0;band<24;++band) assert.ok(Math.abs(cached[band]-direct[band])<1e-12);
  }
});

test("a tone crossing an ERB boundary transfers smoothly to the neighboring bar", () => {
  const powers=[];
  for(const hz of [1250,1287,1320]) powers.push(analyze(signal([[hz,0.25]])).powers);
  assert.ok(powers[0][9]>powers[1][9] && powers[1][9]>powers[2][9]);
  assert.ok(powers[0][10]<powers[1][10] && powers[1][10]<powers[2][10]);
  for(const p of powers) assert.ok(Math.abs(p.reduce((a,b)=>a+b,0)-0.03125)<0.0001);
});

test("the ERB plan uses external RAM and leaves capture, display dynamics and FFT size intact", () => {
  const analyzer=read('src/audio/audio_spectrum.cpp');
  assert.match(analyzer,/heap_caps_malloc\(sizeof\(SpectrumMath::BandPlan\), MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT\)/);
  assert.match(analyzer,/new \(memory\) SpectrumMath::BandPlan/);
  assert.match(analyzer,/bandPlan_->configure\(frame.sampleRate\)/);
  assert.match(analyzer,/\[spectrum\] ERB v1:/);
  assert.equal(N,1024);assert.equal(production.BAND_COUNT,24);
  assert.doesNotMatch(body(analyzer,'capture'),/BandPlan|configure|binBandWeight|log10|malloc/);
});

test("the user's logged bass levels fall to about 56/56/44 percent at 100% sensitivity", () => {
  const first=production.bandDisplayLevel(-14.6,0,100)/255;
  const second=production.bandDisplayLevel(-16.6,1,100)/255;
  const third=production.bandDisplayLevel(-22.9,2,100)/255;
  assert.ok(first>0.55 && first<0.58);
  assert.ok(second>0.55 && second<0.58);
  assert.ok(third>0.43 && third<0.46);
  for(let band=3;band<24;++band) for(const db of [-55,-40,-28,-12,-6]) {
    assert.equal(production.bandDisplayLevel(db,band,100),production.displayLevel(db,100));
  }
});

test("visual bass correction retains beats, silence, decay and sensitivity", () => {
  for(let band=0;band<24;++band){
    assert.equal(production.bandDisplayLevel(-120,band,200),0);
    assert.equal(production.bandDisplayLevel(NaN,band,100),0);
    const quiet=production.bandDisplayLevel(-36,band,100), beat=production.bandDisplayLevel(-6,band,100);
    assert.ok(beat>quiet*3);
    assert.equal(production.bandDisplayLevel(-24,band,50),production.bandDisplayLevel(-24,band,100)/2);
    assert.equal(production.bandDisplayLevel(-24,band,200),Math.min(255,production.bandDisplayLevel(-24,band,100)*2));
    let envelope=production.smoothLevel(0,beat,33);
    assert.ok(envelope>beat*0.70);
    for(let i=0;i<24;++i) envelope=production.smoothLevel(envelope,0,33);
    assert.equal(envelope,0);
  }
});
