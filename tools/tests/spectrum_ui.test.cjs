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
  assert.match(html, /i18n\.js\?v=0\.8\.24&amp;ui=fft2/);
  assert.match(html, /app\.js\?v=0\.8\.24&amp;ui=fft2/);
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
  assert.match(analyzer, /active \? pdMS_TO_TICKS\(1000\) : portMAX_DELAY/);
  assert.match(display, /std::array<float, SpectrumMath::BAND_COUNT> spectrumEnvelope/);
  assert.match(display, /SpectrumMath::smoothLevel\(spectrumEnvelope\[i\], level, elapsedMs\)/);
});

test("FFT is below audio priority but not idle, and self-tests the linked backend", () => {
  const analyzer = fs.readFileSync(path.join(root, "src/audio/audio_spectrum.cpp"), "utf8");
  assert.match(analyzer, /SPECTRUM_TASK_PRIORITY = 1/);
  assert.match(analyzer, /if \(!fftSelfTest\(\)\)/);
  assert.match(analyzer, /meanBandPower\(powers\[band\], weights\[band\]\)/);
  assert.match(analyzer, /void AudioSpectrum::reportDiagnostics\(\)/);
});

test("drawing stalls do not clear the envelope, and sensitivity preserves spectral contrast", () => {
  const display = fs.readFileSync(path.join(root, "src/display/display.cpp"), "utf8");
  const update = display.match(/static bool updateSpectrumBars\(bool playing\) \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(update, /spectrumEnvelope\.fill\(0\)/);
  assert.match(update, /SpectrumMath::usableFrame/);
  assert.match(update, /SpectrumMath::levelWithGain/);
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
