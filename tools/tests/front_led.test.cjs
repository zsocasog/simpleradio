const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const test = require('node:test');
const policy = require('../../data/led-settings.js');
const read = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
const driver = read('src/led/status_led.cpp');
function body(marker) {
  const at = driver.indexOf(marker); assert.ok(at >= 0, marker);
  const start = driver.indexOf('{', at); let depth = 0;
  for (let i = start; i < driver.length; i++) { if (driver[i] === '{') depth++; else if (driver[i] === '}' && --depth === 0) return driver.slice(start, i + 1); }
}
function harness(type = 'neopixel', count = 16) {
  const writes = [], context = vm.createContext({ Type: { NeoPixel: 'neopixel', Pwm: 'pwm' },
    configured: true, dirty: false, sentOnce: false, red: 0, green: 0, blue: 0, sentRed: 0, sentGreen: 0, sentBlue: 0, failures: 0,
    activeHardware: { type, count, order: 'GRB', dataPin: 48, redPin: 40, greenPin: 39, bluePin: 38 },
    pixelSymbols: Array.from({ length: count * 24 + 1 }, () => ({})), now: 10, completed: false, writeOk: true,
    ordered: (_order, r, g, b) => [g, r, b], highTicks: bit => bit ? 8 : 4, lowTicks: bit => bit ? 4 : 8,
  });
  context.micros = () => context.now;
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
    .replace('for (int pixel', 'for (let pixel').replace('for (uint8_t color : colors)', 'for (const color of colors)')
    .replace('for (int bit', 'for (let bit').replace(/auto& (symbol|latch)/g, 'const $1').replace(/\b1U\b/g, '1');
  vm.runInContext(`function flush() ${flush}\nfunction request(r,g,b) ${body('void StatusLed::writeFrontLed(')}`, context);
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
  assert.equal(h.context.sentRed, 90); assert.equal(h.context.sentGreen, 100); assert.equal(h.context.sentBlue, 110);
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
