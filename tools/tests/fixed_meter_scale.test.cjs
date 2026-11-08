const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
test('removed sensitivity has no setting, route, slider, save state or DSP gain parameter left', () => {
  for (const file of ['src/config/app_config.h', 'src/config/app_config.cpp', 'src/web/web_server.cpp',
    'src/display/display.cpp', 'data/app.js', 'data/ui.js', 'data/index.html']) {
    const s = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(s, /displayVuSensitivity|meterSensitivity|previewMeterSensitivity|commitMeterSensitivity|\/api\/display\/sensitivity/);
  }
  const math = fs.readFileSync(path.join(root, 'src/audio/spectrum_dynamics.h'), 'utf8');
  assert.doesNotMatch(math, /sensitivity/);
  assert.match(math, /return clamp\(height \* gate, 0, 255\)/);
  assert.match(math, /return clamp\(steady \+ accent, 0, 255\)/);
  assert.match(math, /timeConstant = target > current \? 25.0f : 95.0f/);
});
