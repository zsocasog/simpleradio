const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(root, "data/app.js"), "utf8");
const sync = app.match(/function syncDisplayFooterMode\(\) \{[\s\S]*?\n\}/)[0];

function visibility(mode) {
  const hidden = {};
  const fields = { displayFooterMode: { value: mode } };
  for (const id of ["displayVuStyleField", "displayVuSensitivityField"]) {
    fields[id] = { classList: { toggle: (name, enabled) => { hidden[id] = enabled; } } };
  }
  vm.runInNewContext(sync + "\nsyncDisplayFooterMode();", { $: (id) => fields[id] });
  return hidden;
}

test("spectrum is a separate footer option, not an existing VU style", () => {
  const html = fs.readFileSync(path.join(root, "data/index.html"), "utf8");
  const footer = html.match(/<select id="displayFooterMode"[\s\S]*?<\/select>/)[0];
  const styles = html.match(/<select id="displayVuStyle"[\s\S]*?<\/select>/)[0];
  assert.match(footer, /value="spectrum"/);
  for (const style of ["bars", "symmetric", "classic"]) assert.match(styles, new RegExp(`value="${style}"`));
  assert.doesNotMatch(styles, /value="spectrum"/);
});

test("spectrum shows sensitivity but hides VU style", () => {
  assert.deepEqual(visibility("spectrum"), { displayVuStyleField: true, displayVuSensitivityField: false });
});

test("existing VU controls stay visible", () => {
  assert.deepEqual(visibility("vu"), { displayVuStyleField: false, displayVuSensitivityField: false });
});

test("non-audio footers hide both audio controls", () => {
  for (const mode of ["volume", "station", "datetime", "off"]) {
    assert.deepEqual(visibility(mode), { displayVuStyleField: true, displayVuSensitivityField: true });
  }
});

test("all shipped language bundles contain the spectrum label", () => {
  for (const language of ["hu", "en", "template"]) {
    const bundle = fs.readFileSync(path.join(root, `data/i18n/${language}.js`), "utf8");
    assert.match(bundle, /"display\.footer\.spectrum":/);
  }
});

test("application version stays unchanged while modified scripts get new cache keys", () => {
  const html = fs.readFileSync(path.join(root, "data/index.html"), "utf8");
  assert.match(html, /i18n\.js\?v=0\.8\.24&amp;ui=logos2/);
  assert.match(html, /app\.js\?v=0\.8\.24&amp;ui=logos2/);
});

test("spectrum uses the complete 24-column VU grid without widening the bars", () => {
  const display = fs.readFileSync(path.join(root, "src/display/display.cpp"), "utf8");
  const layout = display.match(/struct VuLayout \{[\s\S]*?\n\};/)[0];
  const current = display.match(/static VuLayout currentVuLayout\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(layout, /barWidth = VU_BAR_W/);
  assert.match(layout, /barGap = VU_BAR_GAP/);
  assert.match(current, /spectrum \? DisplayVuStyle::Symmetric/);
  assert.match(current, /layout\.barCount = SpectrumMath::BAND_COUNT/);
  assert.doesNotMatch(current, /layout\.barWidth\s*=/);
  assert.doesNotMatch(current, /layout\.barGap\s*=/);
  assert.match(display, /VU_BAR_COUNT = 24/);
  assert.match(fs.readFileSync(path.join(root, "src/audio/spectrum_math.h"), "utf8"), /BAND_COUNT = 24/);
});

test("analyzer sleeps until PCM arrives and retains the fractional display envelope", () => {
  const analyzer = fs.readFileSync(path.join(root, "src/audio/audio_spectrum.cpp"), "utf8");
  const display = fs.readFileSync(path.join(root, "src/display/display.cpp"), "utf8");
  assert.match(analyzer, /active \? max<TickType_t>\(1, pdMS_TO_TICKS\(waitMs\)\) : portMAX_DELAY/);
  assert.match(display, /std::array<float, SpectrumMath::BAND_COUNT> spectrumEnvelope/);
  assert.match(display, /SpectrumMath::smoothLevel\(spectrumEnvelope\[i\], level, elapsedMs\)/);
});

test("FFT is below audio priority but not idle, and self-tests the linked backend", () => {
  const analyzer = fs.readFileSync(path.join(root, "src/audio/audio_spectrum.cpp"), "utf8");
  assert.match(analyzer, /SPECTRUM_TASK_PRIORITY = 1/);
  assert.match(analyzer, /if \(!fftSelfTest\(\)\)/);
  assert.match(analyzer, /SpectrumMath::bandPowers\(work_.data\(\), frame.sampleRate, windowEnergy_\)/);
  assert.doesNotMatch(analyzer, /meanBandPower|weights\[band\]/);
  assert.match(analyzer, /void AudioSpectrum::reportDiagnostics\(\)/);
});

test("drawing stalls do not clear the envelope, and sensitivity preserves spectral contrast", () => {
  const display = fs.readFileSync(path.join(root, "src/display/display.cpp"), "utf8");
  const update = display.match(/static bool updateSpectrumBars\(bool playing\) \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(update, /spectrumEnvelope\.fill\(0\)/);
  assert.match(update, /SpectrumMath::usableFrame/);
  assert.match(update, /SpectrumDynamics::displayLevel\(spectrum.bandDb\[i\], sensitivity\)/);
  assert.doesNotMatch(update, /spectrumLevelTracker|gainDb/);
  assert.doesNotMatch(update, /log10f\(sensitivity/);
  assert.doesNotMatch(update, /spectrum\.bands\[i\] \* sensitivity/);
  const visibility = display.match(/static void setSpectrumDisplayVisibility\(bool visible\) \{[\s\S]*?\n\}/)[0];
  assert.match(visibility, /spectrumDisplayVisible != visible/);
  assert.match(visibility, /clearVuBars\(\)/);
});

test("all shipped labels describe 24 analysis bands", () => {
  const html = fs.readFileSync(path.join(root, "data/index.html"), "utf8");
  assert.match(html, /Spektrum \(24 sáv, FFT\)/);
  for (const language of ["hu", "en", "template"]) {
    const bundle = fs.readFileSync(path.join(root, `data/i18n/${language}.js`), "utf8");
    assert.match(bundle, /"display\.footer\.spectrum": "[^"\n]*24/);
  }
});

test("stop releases spectrum while still clearing the conventional VU immediately", () => {
  const display = fs.readFileSync(path.join(root, "src/display/display.cpp"), "utf8");
  const render = display.match(/void Display::renderAudioMeterFrame\(bool force\) \{[\s\S]*?\n\}/)[0];
  assert.match(render, /if \(!lastModel.playing && !spectrum\) \{[\s\S]*?if \(vuRendered \|\| vuBarsHaveSignal\(\) \|\| force\)/);
  assert.match(render, /setSpectrumDisplayVisibility\(visible && spectrum\)/);
  assert.doesNotMatch(render, /setSpectrumDisplayVisibility\([^;]*lastModel.playing/);
  assert.match(render, /updateSpectrumBars\(lastModel.playing\)/);
  assert.match(render, /const bool releaseFinished = spectrum && !lastModel.playing && !vuBarsHaveSignal\(\) && vuRendered/);
  assert.match(render, /drawVuMeter\(lastModel, force\)/);
  const draw = display.match(/static void drawVuMeter\(const DisplayModel& m, bool forceFull = false\) \{[\s\S]*?\n\}/)[0];
  assert.match(draw, /spectrumRelease = footerMode\(\) == DisplayFooterMode::Spectrum && vuBarsHaveSignal\(\)/);
  assert.match(draw, /if \(!m.playing && !spectrumRelease\) \{\s*clearVuBars\(\);\s*if \(vuRendered \|\| forceFull\) \{\s*clearRenderedVuArea\(layout\);/);
  assert.doesNotMatch(draw, /!m.playing && !vuBarsHaveSignal/);
  assert.match(display, /\(audioFooterMode\(\) && previous.playing != m.playing\)/);
});

test("spectrum has no shaped VU contour or minimum-height idle bars", () => {
  const display = fs.readFileSync(path.join(root, "src/display/display.cpp"), "utf8");
  const update = display.match(/static bool updateSpectrumBars\(bool playing\) \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(update, /shapedVuHeight|classicVuHeight|VU_MIN_H|kVuShape|triWave/);
});

test("production stop branch lets spectrum decay and erases its final zero frame", () => {
  const display = fs.readFileSync(path.join(root, "src/display/display.cpp"), "utf8");
  function branch(source, condition) {
    const start = source.indexOf(condition);
    assert.ok(start >= 0);
    let nesting = 0;
    for (let i = source.indexOf("{", start); i < source.length; ++i) {
      if (source[i] === "{") ++nesting;
      if (source[i] === "}" && --nesting === 0) return source.slice(start, i + 1);
    }
    throw new Error("unclosed production branch");
  }
  const draw = display.match(/static void drawVuMeter\(const DisplayModel& m, bool forceFull = false\) \{[\s\S]*?\n\}/)[0];
  const render = display.match(/void Display::renderAudioMeterFrame\(bool force\) \{[\s\S]*?\n\}/)[0];
  // These two production branches are also valid JavaScript. Execute them with
  // a mock LCD, rather than duplicating the stop conditions in the test.
  const drawStop = branch(draw, "if (!m.playing && !spectrumRelease)");
  const renderStop = branch(render, "if (!lastModel.playing && !spectrum)");
  for (const spectrum of [false, true]) {
    const result = vm.runInNewContext(`
      let vuRendered = true, signal = true, erasures = 0;
      const lastModel = { playing: false }, force = false, spectrum = ${spectrum};
      function vuBarsHaveSignal() { return signal; }
      function clearVuBars() { signal = false; }
      function clearRenderedVuArea() { vuRendered = false; ++erasures; }
      function drawVuMeter(m, forceFull = false) {
        const layout = {}, spectrumRelease = spectrum && vuBarsHaveSignal(); ${drawStop}
      }
      function renderFrame() { ${renderStop} }
      renderFrame();
      const beforeRelease = { erasures, signal };
      // A paused spectrum may redraw its retained frame, not erase it.
      drawVuMeter(lastModel);
      const redrawErasures = erasures;
      signal = false;
      drawVuMeter(lastModel); drawVuMeter(lastModel);
      ({ erasures, signal, vuRendered, beforeRelease, redrawErasures });
    `);
    assert.equal(result.beforeRelease.signal, spectrum);
    assert.equal(result.beforeRelease.erasures, spectrum ? 0 : 1);
    assert.equal(result.redrawErasures, spectrum ? 0 : 1);
    assert.equal(result.erasures, 1);
    assert.equal(result.signal, false);
    assert.equal(result.vuRendered, false);
  }
});

test("linked DSP self-test covers the actual window, DC removal and RMS calibration", () => {
  const analyzer = fs.readFileSync(path.join(root, "src/audio/audio_spectrum.cpp"), "utf8");
  const selfTest = analyzer.match(/bool AudioSpectrum::fftSelfTest\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(selfTest, /SpectrumMath::prepareFrame/);
  assert.match(selfTest, /SpectrumMath::bandPowers/);
  assert.match(selfTest, /rmsLeft = 0.0625f, rmsRight = 0.015625f/);
  assert.match(selfTest, /std::fill_n\(frames_\[0\].samples, SpectrumMath::POINT_COUNT \* 2, 12000 << 16\)/);
  assert.match(selfTest, /powerDb\(quiet\[leftBand\], -40\)/);
  assert.match(selfTest, /powerDb\(0, -60\) == SpectrumMath::SILENCE_DB/);
  assert.match(analyzer, /result.bandDb\[band\] = db/);
  assert.doesNotMatch(analyzer, /result.bandDb\[band\].*levelFromDb/);
});

test("FFT sees post-EQ samples without truncating quiet Q31 audio or changing playback", () => {
  const meter = fs.readFileSync(path.join(root, "src/audio/audio_meter.cpp"), "utf8");
  const raw = meter.match(/void audio_process_raw_samples\([^]*?\n\}/)[0];
  const post = meter.match(/void audio_process_i2s\([^]*?\n\}/)[0];
  assert.doesNotMatch(raw, /AudioSpectrum/);
  assert.match(post, /AudioSpectrum::instance\(\).capture\(outBuff, validSamples\)/);
  assert.doesNotMatch(post, /\*continueI2S\s*=|outBuff\[.*\]\s*=/);
  const analyzer = fs.readFileSync(path.join(root, "src/audio/audio_spectrum.cpp"), "utf8");
  const capture = analyzer.match(/void AudioSpectrum::capture\([^]*?\n\}/)[0];
  assert.match(capture, /memcpy\(frames_\[index\].samples \+ start \* 2/);
  assert.doesNotMatch(capture, />> 16|log10|sqrt|malloc|Serial/);
  assert.match(capture, /SpectrumCapture::windowHop/);
  assert.match(analyzer, /copy-max=%luus near-clip=%lu/);
  assert.match(analyzer, /bands-dB low->high/);
  const player = fs.readFileSync(path.join(root, "src/audio/audio_player.cpp"), "utf8");
  assert.match(player, /VolumeMath::gainDb\(state.volume, curve\)/);
  assert.doesNotMatch(player, /audio.setOutputSampleRate\(/); // Tap rate remains SR_ORIGIN.
});
