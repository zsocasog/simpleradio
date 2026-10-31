const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../src/display/display.cpp'), 'utf8');

function body(signature) {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, signature);
  const start = source.indexOf('{', at);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(signature);
}

// Execute the production update dispatcher, retaining its actual cache and
// timing decisions. Only hardware/time acquisition and C++ type syntax differ.
function clock(style) {
  const calls = [];
  let sample = null, uptime = 7000;
  const draw = name => (...args) => calls.push([name, ...args]);
  const context = vm.createContext({
    configRef: { displayClockStyleId: style }, DisplayClockStyle: { Analog: 'analog' },
    getLocalTime(out) { if (!sample) return false; Object.assign(out, sample); return true; },
    millis: () => uptime, memset() {},
    drawAnalogClock: draw('analog-full'), drawDigitalClock: draw('digital-full'),
    drawAnalogClockHandsOnly: draw('hands'), drawAnalogClockCaption: draw('caption'),
    drawDigitalClockText: draw('text'), drawDigitalClockSecondBar: draw('wave'),
    resetAnalogClockHandCache() {},
  });
  const dispatcher = body('void Display::renderIdleClock(bool force)')
    .replace('AppConfig& config = AppConfig::instance();', 'const config = configRef;')
    .replace('struct tm timeinfo;', 'const timeinfo = {};')
    .replace('getLocalTime(&timeinfo, 5)', 'getLocalTime(timeinfo, 5)')
    .replace(/DisplayClockStyle::/g, 'DisplayClockStyle.')
    .replace('memset(&timeinfo, 0, sizeof(timeinfo));', '')
    .replace(/static_cast<int>\(/g, 'Math.trunc(')
    .replace(/\b(\d+)UL\b/g, '$1')
    .replace('stamp / 60', 'Math.trunc(stamp / 60)')
    .replace(/\b(?:String|bool|int) /g, 'let ');
  vm.runInContext(`let lastClockStamp=-1, lastClockMinuteStamp=-1;
    let lastClockHadTime=false, lastClockStyle=''; function render(force) ${dispatcher}`, context);
  return { calls, context,
    tick(next, force = false) { sample = next; vm.runInContext(`render(${force})`, context); },
    clear() { calls.length = 0; },
    uptime(value) { uptime = value; },
  };
}

function time(hour, minute, second, day = 301, year = 126) {
  return { tm_hour: hour, tm_min: minute, tm_sec: second, tm_yday: day, tm_year: year };
}
const names = clock => clock.calls.map(call => call[0]);

test('repeated ticks within one second do no drawing, then only moving elements update', () => {
  for (const style of ['analog', 'digital']) {
    const h = clock(style);
    h.tick(time(21, 18, 37));
    assert.deepEqual(names(h), [`${style}-full`]);
    h.clear(); h.tick(time(21, 18, 37)); assert.deepEqual(names(h), []);
    h.tick(time(21, 18, 38));
    assert.deepEqual(names(h), style === 'analog' ? ['hands'] : ['wave']);
    h.clear(); h.tick(time(21, 19, 0));
    assert.deepEqual(names(h), style === 'analog' ? ['hands', 'caption'] : ['text', 'wave']);
  }
});

test('midnight and calendar corrections refresh the date even at identical HH:MM:SS', () => {
  for (const style of ['analog', 'digital']) {
    const h = clock(style);
    h.tick(time(23, 59, 59)); h.clear(); h.tick(time(0, 0, 0, 302));
    assert.deepEqual(names(h), style === 'analog' ? ['hands', 'caption'] : ['text', 'wave']);
    h.clear(); h.tick(time(0, 0, 0, 302, 127));
    assert.deepEqual(names(h), style === 'analog' ? ['hands', 'caption'] : ['text', 'wave']);
  }
});

test('NTP acquisition/loss redraws placeholders, including the same-second coincidence', () => {
  for (const style of ['analog', 'digital']) {
    const h = clock(style);
    h.tick(null); h.clear(); h.tick(time(0, 0, 7, 0));
    assert.deepEqual(names(h), [`${style}-full`]);
    h.clear(); h.tick(null);
    assert.deepEqual(names(h), [`${style}-full`]);
  }
});

test('theme changes can force a fresh clock without changing the time', () => {
  const h = clock('digital');
  h.tick(time(21, 18, 37)); h.clear(); h.tick(time(21, 18, 37), true);
  assert.deepEqual(names(h), ['digital-full']);
});

test('seconds use the shared volume bars, progress monotonically and reset without repainting the page', () => {
  const cleared = [], drawn = [];
  const shape = source.match(/kVuShape\[VU_BAR_COUNT\] = \{([^]*?)\};/)[1];
  const context = vm.createContext({
    SCREEN_W: 480, VU_BAR_COUNT: 24, VU_BAR_W: 9, VU_BAR_GAP: 7, VU_MIN_H: 2,
    VU_SYMMETRIC_MAX_H: 25, VOLUME_METER_AXIS_Y: 186,
    clockWaveLastFilled: -1, cLine: 10, cBg: 0, cAccent: 65504, kVuSeed: Array(24).fill(0),
    sx: Math.round, sy: Math.round, ss: Math.round,
    constrain: (value, lo, hi) => Math.max(lo, Math.min(hi, value)), max: Math.max, min: Math.min,
    blend565: () => 1,
    lcd: { startWrite() {}, endWrite() {}, fillRect(...args) { cleared.push(args); },
      fillRoundRect(...args) { drawn.push(args); } },
  });
  function translate(text) {
    return text.replace(/(?:max|min)<[^>]+>/g, match => match.slice(0, match.indexOf('<')))
      .replace(/static_cast<(?:int|u?int\d+_t)>\(/g, 'Math.trunc(')
      .replace(/\b(\d+)U\b/g, '$1')
      .replace(/\b(const )?(?:int|u?int\d+_t) (\w+) = ([^;]+);/g,
        (_, constant, name, value) => `${constant || 'let '}${name} = Math.trunc(${value});`)
      .replace(/\bconst (?:int|bool|u?int\d+_t) /g, 'const ')
      .replace(/\b(?:int|u?int\d+_t) /g, 'let ')
      .replace('VuLayout layout;', 'let layout = { barWidth: VU_BAR_W, barGap: VU_BAR_GAP };')
      .replace('VuLayout layout =', 'const layout =')
      .replace('(SCREEN_W - meterW) / 2', 'Math.trunc((SCREEN_W - meterW) / 2)')
      .replace(/->/g, '.')
      .replace(/\bnullptr\b/g, 'null');
  }
  const functions = [
    ['volumeMeterLayout', '', 'static VuLayout volumeMeterLayout('],
    ['volumeMeterGhostHeight', 'index,maxH', 'static uint8_t volumeMeterGhostHeight('],
    ['volumeMeterTargetHeight', 'index,maxH,now,animate', 'static uint8_t volumeMeterTargetHeight('],
    ['drawVolumeMeterBar', 'sprite,layout,index,originX,height,color', 'static void drawVolumeMeterBar('],
    ['vuBarXInLayout', 'layout,index', 'static int vuBarXInLayout('],
    ['wave', 'timeinfo,haveTime', 'static void drawDigitalClockSecondBar('],
  ].map(([name,args,signature]) => `function ${name}(${args}) ${translate(body(signature))}`).join('\n');
  vm.runInContext(`const kVuShape=[${shape}]; ${functions}`, context, { filename: 'shared-meter.js' });
  const heights = Array(24).fill(0);
  const measure = () => {
    for (const [x] of cleared) heights[(x - 51) / 16] = 0;
    for (const [x, , , height, , color] of drawn) if (color === 65504) heights[(x - 51) / 16] = height;
    return heights.reduce((sum, height) => sum + height, 0);
  };
  const tick = (sec, valid = true) => vm.runInContext(`wave({tm_sec:${sec}}, ${valid})`, context);
  tick(0); assert.equal(drawn.length, 24);
  assert.ok(drawn.every(rect => rect[5] === 1));
  let previous = measure();
  for (let second = 1; second < 60; second++) {
    cleared.length = 0; drawn.length = 0; tick(second);
    assert.ok(cleared.length <= 2);
    assert.ok(drawn.every(rect => rect[2] === 9));
    const next = measure(); assert.ok(next >= previous); previous = next;
  }
  assert.ok(heights.every(height => height > 0));
  cleared.length = 0; drawn.length = 0; tick(0);
  assert.equal(cleared.length, 24);
  assert.ok(drawn.every(rect => rect[5] === 1));
  assert.equal(measure(), 0);
  cleared.length = 0; drawn.length = 0; tick(37, false); assert.equal(cleared.length, 0);
  tick(37); assert.ok(cleared.length > 0);
  cleared.length = 0; drawn.length = 0; tick(37); assert.equal(cleared.length, 0);
});
