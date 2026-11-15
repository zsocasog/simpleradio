const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const test = require('node:test');
const policy = require('../../data/led-settings.js');
const read = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
const driver = read('src/led/status_led.cpp');
const nativePolicy = read('src/led/front_led_policy.h');
function body(marker, source = driver) {
  const at = source.indexOf(marker); assert.ok(at >= 0, marker);
  const start = source.indexOf('{', at); let depth = 0;
  for (let i = start; i < source.length; i++) { if (source[i] === '{') depth++; else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1); }
}
function harness(type = 'neopixel', count = 16) {
  const writes = [], context = vm.createContext({ Type: { NeoPixel: 'neopixel', Pwm: 'pwm' },
    configured: true, dirty: false, sentOnce: false, failures: 0, displayOff: false,
    config: { frontLedEnabled: true, frontLedVolumeEnabled: false, frontLedStartPixel: 1, frontLedReverse: false },
    requestedFrame: { color: [0, 0, 0], volume: 0, weight: 0, startPixel: 1, reverse: false },
    sentFrame: { color: [0, 0, 0], volume: 0, weight: 0, startPixel: 1, reverse: false },
    volumeCue: { volume: 0, value: 0, cancel() { this.value = 0; }, weight() { return this.value; } },
    activeHardware: { type, count, order: 'GRB', dataPin: 48, redPin: 40, greenPin: 39, bluePin: 38 },
    pixelSymbols: Array.from({ length: count * 24 + 1 }, () => ({})), now: 10, completed: false, writeOk: true,
    ordered: (_order, r, g, b) => [g, r, b], highTicks: bit => bit ? 8 : 4, lowTicks: bit => bit ? 4 : 8,
  });
  context.micros = () => context.now;
  context.millis = () => context.now;
  context.AppConfig = { instance: () => context.config };
  context.structuredClone = structuredClone;
  context.rmtTransmitCompleted = () => context.completed;
  context.rmtWriteAsync = (pin, data, length) => {
    writes.push({ pin, data: structuredClone(data.slice(0, length)) });
    if (context.writeOk) context.completed = false;
    return context.writeOk;
  };
  context.writePwmPin = (pin, value) => writes.push({ pin, value });
  context.fail = error => { context.configured = false; context.error = error; };
  context.transfer = { inFlight: false, startedUs: 0, started(now) { this.inFlight = true; this.startedUs = now; },
    ready(completed) { return !this.inFlight || completed; }, stalled(completed, now) { return this.inFlight && !completed && now - this.startedUs >= 100000; } };
  let flush = body('void StatusLed::flush()').replace('using namespace FrontLedPolicy;', '').replace(/Type::/g, 'Type.')
    .replace(/const bool |const auto /g, 'const ').replace('unsigned index', 'let index')
    .replace('for (int position', 'for (let position').replace('for (uint8_t color : colors)', 'for (const color of colors)')
    .replace('for (int bit', 'for (let bit').replace(/auto& (symbol|latch)/g, 'const $1').replace(/\b1U\b/g, '1')
    .replace('sentFrame = requestedFrame;', 'sentFrame = structuredClone(requestedFrame);');
  const prepare = body('void StatusLed::prepareFrame()').replace('const auto& config = AppConfig::instance();', 'const config = AppConfig.instance();').replace(/FrontLedPolicy::/g, '');
  const same = body('constexpr bool sameFrame(', nativePolicy);
  const logical = body('constexpr unsigned logicalPixel(', nativePolicy).replace('const unsigned', 'const');
  const filled = body('constexpr unsigned filledPixels(', nativePolicy).replace('return (', 'return Math.trunc((').replace('/ 100;', '/ 100);');
  const pixel = body('constexpr std::array<uint8_t, 3> pixel(', nativePolicy)
    .replace('auto result = frame.color;', 'const result = [...frame.color];').replace('const bool', 'const')
    .replace('unsigned channel', 'let channel').replace('const uint8_t cue =', 'const cue = Math.trunc(')
    .replace(' : 0;', ' : 0);').replace(/uint(?:16|32)_t\(([^)]+)\)/g, 'Number($1)')
    .replace('result[channel] = (', 'result[channel] = Math.trunc((').replace('/ 255;', '/ 255);');
  const request = body('void StatusLed::writeFrontLed(').replace('{r, g, b}', '[r, g, b]');
  vm.runInContext(`function sameFrame(a,b) ${same}\nfunction logicalPixel(physical,count,start,reverse) ${logical}\nfunction filledPixels(count,volume) ${filled}\nfunction pixel(frame,physical,count) ${pixel}\nfunction prepareFrame() ${prepare}\nfunction flush() ${flush}\nfunction request(r,g,b) ${request}`, context);
  return { context, writes, request: (r, g, b) => context.request(r, g, b), flush: () => context.flush() };
}
const cap = { maxCount: 64, pins: [38, 39, 40, 48] };
test('browser validation enforces type, count, occupied pins, separate PWM channels and all orders', () => {
  const data = { ...policy.defaults, frontLedType: 'neopixel' };
  for (const order of ['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR']) assert.equal(policy.validate({ ...data, frontLedOrder: order }, cap), '');
  for (const count of [0, 65, 1.5, NaN]) assert.equal(policy.validate({ ...data, frontLedCount: count }, cap), 'countError');
  assert.equal(policy.validate({ ...data, frontLedDataPin: 14 }, cap), 'pinError');
  assert.equal(policy.validate({ ...data, frontLedType: 'rgbw' }, cap), 'invalid');
  assert.equal(policy.validate({ ...data, frontLedType: 'pwm' }, cap), '');
  assert.equal(policy.validate({ ...data, frontLedType: 'pwm', frontLedBluePin: 39 }, cap), 'duplicatePins');
});
test('actual driver encodes every pixel MSB first plus a 300us low latch', () => {
  for (const count of [1, 16, 24, 64]) {
    const h = harness('neopixel', count); h.request(0x55, 0xaa, 0xff); h.flush();
    const frame = h.writes[0].data; assert.equal(frame.length, count * 24 + 1);
    for (let pixel = 0; pixel < count; pixel++) {
      let decoded = [];
      for (let channel = 0; channel < 3; channel++) {
        let value = 0;
        for (let bit = 0; bit < 8; bit++) { const symbol = frame[pixel * 24 + channel * 8 + bit];
          assert.equal(symbol.level0, 1); assert.equal(symbol.level1, 0); assert.equal(symbol.duration0 + symbol.duration1, 12);
          value = (value << 1) | Number(symbol.duration0 === 8);
        }
        decoded.push(value);
      }
      assert.deepEqual(decoded, [0xaa, 0x55, 0xff]);
    }
    assert.deepEqual(frame.at(-1), { level0: 0, duration0: 3000, level1: 0, duration1: 1 });
  }
});
test('pending RMT frames keep their buffer immutable and coalesce subsequent updates', () => {
  const h = harness(); h.request(1, 2, 3); h.flush(); const before = structuredClone(h.context.pixelSymbols);
  h.request(20, 30, 40); h.flush(); h.request(90, 100, 110); h.flush();
  assert.deepEqual(structuredClone(h.context.pixelSymbols), before); assert.equal(h.writes.length, 1);
  h.context.completed = true; h.flush(); assert.equal(h.writes.length, 2);
  assert.deepEqual(Array.from(h.context.sentFrame.color), [90, 100, 110]);
  h.context.completed = true; h.flush(); h.request(90, 100, 110); h.flush(); assert.equal(h.writes.length, 2);
});
test('a stalled channel and repeated transmit errors disable only LED output', () => {
  const h = harness(); h.request(1, 2, 3); h.flush(); h.context.now += 100000; h.flush();
  assert.equal(h.context.error, 'rmt-timeout'); assert.equal(h.writes.length, 1);
  const f = harness(); f.context.writeOk = false; f.request(1, 2, 3); f.flush(); f.flush(); f.flush(); f.flush();
  assert.equal(f.context.error, 'rmt-write'); assert.equal(f.writes.length, 3);
});
test('PWM sends three channels once; zero brightness and display off remain truly off', () => {
  const h = harness('pwm'); h.request(0, 0, 0); h.flush(); h.flush();
  assert.deepEqual(h.writes, [{ pin: 40, value: 0 }, { pin: 39, value: 0 }, { pin: 38, value: 0 }]);
  assert.match(body('void StatusLed::applyConfig()'), /brightness = displayOff \? 0/);
  assert.match(body('void StatusLed::writePwmPin('), /pwm\(value, activeHardware.inverted\)/);
});
test('hardware is frozen at boot; disabled LEDs allocate no pixel buffer or task', () => {
  const boot = body('void StatusLed::begin()'), setup = body('void StatusLed::configureFrontLed()');
  assert.match(boot, /activeHardware = AppConfig::instance\(\).frontLedHardware\(\)/);
  assert.ok(setup.indexOf('Type::None) { parkPwmPins(); return; }') < setup.indexOf('heap_caps_calloc'));
  assert.doesNotMatch(driver, /xTaskCreate|rmtWrite\(|RMT_WAIT_FOR_EVER/);
  assert.doesNotMatch(body('void StatusLed::flush()'), /heap_caps_|malloc|delay\(/);
});
test('no LED parks only eligible saved RGB pins at the polarity-correct off level', () => {
  const source = body('void StatusLed::parkPwmPins()').replace(/for \(int pin : \{([^}]+)\}\)/,
    'for (const pin of [$1])').replace('FrontLedPolicy::allowedPin', 'allowedPin');
  for (const inverted of [false, true]) {
    const calls = [];
    new Function('activeHardware', 'allowedPin', 'pinMode', 'digitalWrite', 'OUTPUT', 'HIGH', 'LOW', source)(
      { redPin: 40, greenPin: 39, bluePin: 14, inverted }, pin => [38, 39, 40, 48].includes(pin),
      (pin, mode) => calls.push(['mode', pin, mode]), (pin, value) => calls.push(['level', pin, value]), 'output', 1, 0);
    assert.deepEqual(calls, [['mode', 40, 'output'], ['level', 40, Number(inverted)], ['mode', 39, 'output'], ['level', 39, Number(inverted)]]);
  }
});

function decodedPixels(frame, count) {
  return Array.from({ length: count }, (_, position) => Array.from({ length: 3 }, (_, channel) => {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) value = (value << 1) | Number(frame[position * 24 + channel * 8 + bit].duration0 === 8);
    return value;
  }));
}
test('volume frames use the selected start and direction and restore the ambient frame', () => {
  for (const reverse of [false, true]) {
    const h = harness('neopixel', 8), c = h.context;
    Object.assign(c.config, { frontLedVolumeEnabled: true, frontLedStartPixel: 3, frontLedReverse: reverse });
    c.volumeCue.volume = 50; c.volumeCue.value = 255;
    h.request(100, 120, 140); h.flush();
    const expected = policy.preview(8, 3, reverse).map(item => item.lit ? [120, 100, 140] : [0, 0, 0]);
    assert.deepEqual(decodedPixels(h.writes[0].data, 8), expected);
    const buffer = structuredClone(c.pixelSymbols);
    c.volumeCue.value = 0; h.request(100, 120, 140); h.flush();
    assert.deepEqual(structuredClone(c.pixelSymbols), buffer); // In-flight frame is not overwritten.
    c.completed = true; h.flush();
    assert.deepEqual(decodedPixels(h.writes[1].data, 8), Array.from({ length: 8 }, () => [120, 100, 140]));
    c.completed = true; h.flush(); h.request(100, 120, 140); h.flush();
    assert.equal(h.writes.length, 2);
  }
});
test('single LED volume is proportional; off and disabled feedback cancel the cue', () => {
  const h = harness('pwm'), c = h.context;
  c.config.frontLedVolumeEnabled = true; c.volumeCue.volume = 50; c.volumeCue.value = 255;
  h.request(100, 120, 140); h.flush();
  assert.deepEqual(h.writes.map(w => w.value), [50, 60, 70]);
  c.config.frontLedVolumeEnabled = false; h.request(100, 120, 140); h.flush();
  assert.deepEqual(h.writes.slice(-3).map(w => w.value), [100, 120, 140]);
  c.config.frontLedVolumeEnabled = true; c.volumeCue.value = 255; c.displayOff = true;
  h.request(0, 0, 0); h.flush();
  assert.deepEqual(h.writes.slice(-3).map(w => w.value), [0, 0, 0]);
  assert.equal(c.volumeCue.value, 0);
});
test('browser mapping covers every pixel once without changing the LED count', () => {
  for (let count = 1; count <= 64; count++) for (const start of [1, count]) for (const reverse of [false, true]) {
    for (const volume of [0, 1, 50, 100]) {
      const p = policy.preview(count, start, reverse, volume);
      assert.equal(p.length, count); assert.equal(p.filter(x => x.first).length, 1);
      assert.ok(p[start - 1].first); assert.equal(p.filter(x => x.lit).length, Math.ceil(count * volume / 100));
    }
  }
});
test('volume observation never copies metadata, allocates memory, or waits for the player mutex', () => {
  const getter = body('bool PlayerState::tryVolume(', read('src/state/player_state.cpp'));
  assert.match(getter, /xSemaphoreTakeRecursive\(mutex, 0\)/);
  assert.doesNotMatch(getter.replace(/\/\/[^\n]*/g, ''), /snapshot|String|malloc|ensure|portMAX_DELAY/);
  const loop = body('void StatusLed::loop()');
  assert.ok(loop.indexOf('config.frontLedVolumeEnabled && config.frontLedEnabled') < loop.indexOf('tryVolume'));
  assert.doesNotMatch(loop, /snapshot|delay\(|xTaskCreate|malloc/);
});
