const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const http = read('src/artwork/artwork_http.cpp');
const cache = read('src/artwork/artwork_cache.cpp');
function block(source, marker) {
  const at = source.indexOf(marker); assert.ok(at >= 0, marker);
  const start = source.indexOf('{', at); let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(marker);
}

// Execute the real cancellation adapter with the pinned core's timedRead loop.
// This is the loop used for HTTP headers and chunk-size/trailer lines, even
// though body reads use NetworkClient::readBytes(). Its -1 result is NOT EOF.
const streamSource = read('tools/tests/fixtures/arduino-stream-timed-read.cpp');
const timedRead = new Function('read', 'millis', 'state',
  block(streamSource, 'int Stream::timedRead()')
    .replace('int c;', 'let c;').replace(/\b_startMillis\b/g, 'state.start')
    .replace(/\b_timeout\b/g, 'state.timeout'));
const cooperativeService = new Function('transfer', 'Stream', 'base',
  block(http.slice(http.indexOf('protected:')), 'bool service()')
    .replace('Stream::setTimeout', 'Stream.setTimeout').replace('Base::stop()', 'base.stop()'));

function pendingLine({ deadline = 12000, cancelAt = Infinity, closeOnly = false } = {}) {
  let now = 11990, stopped = false;
  const state = { timeout: 6000 };
  const transfer = { service: () => now < deadline && now < cancelAt };
  const stream = { setTimeout: value => state.timeout = value };
  const base = { stop: () => stopped = true };
  const read = () => {
    if (closeOnly) { if (!transfer.service()) base.stop(); }
    else cooperativeService(transfer, stream, base);
    ++now; // one simulated millisecond of scheduling/polling
    return -1;
  };
  return { result: timedRead(read, () => now, state), get time() { return now; },
    get stopped() { return stopped; } };
}

test('reproduces the log: closing a socket alone turns a 12s deadline into an 18s read', () => {
  const old = pendingLine({ closeOnly: true });
  assert.equal(old.result, -1); assert.equal(old.stopped, true);
  assert.equal(old.time, 17990);
});

test('an expired chunk/header read exits at the deadline without six extra seconds', () => {
  const fixed = pendingLine();
  assert.equal(fixed.result, -1); assert.equal(fixed.stopped, true);
  assert.equal(fixed.time, 12001);
  assert.doesNotMatch(block(http.slice(http.indexOf('protected:')), 'bool service()'), /return ['"]/);
});

test('track changes/audio reservations also interrupt the inherited header/chunk wait', () => {
  const cancelled = pendingLine({ deadline: 35000, cancelAt: 12020 });
  assert.equal(cancelled.result, -1); assert.equal(cancelled.time, 12021);
  assert.equal(cancelled.stopped, true);
});

test('normal fragmented line reads retain their timeout and return real bytes', () => {
  let now = 0, stops = 0;
  const state = { timeout: 6000 }, transfer = { service: () => true };
  const stream = { setTimeout: value => state.timeout = value }, base = { stop: () => ++stops };
  const result = timedRead(() => {
    assert.equal(cooperativeService(transfer, stream, base), true);
    return ++now === 40 ? 0x0a : -1;
  }, () => now, state);
  assert.equal(result, 0x0a); assert.equal(state.timeout, 6000); assert.equal(stops, 0);
});

test('a stopped transfer stays bounded across repeated timedRead calls', () => {
  const state = { timeout: 6000 }, base = { stop: () => {} };
  let now = 12000;
  const read = () => {
    cooperativeService({ service: () => false }, { setTimeout: n => state.timeout = n }, base);
    ++now; return -1;
  };
  for (let i = 0; i < 5; ++i) assert.equal(timedRead(read, () => now, state), -1);
  assert.equal(now, 12005);
});

test('all artwork jobs can use either core without raising their idle priority above audio', () => {
  assert.match(cache, /ARTWORK_TASK_CORE = tskNO_AFFINITY;/);
  assert.match(cache, /ARTWORK_TASK_PRIORITY = 0;/);
  const creates = [...cache.matchAll(/xTaskCreatePinnedToCore\([\s\S]*?\);/g)];
  assert.equal(creates.length, 5);
  for (const create of creates) {
    assert.match(create[0], /ARTWORK_TASK_PRIORITY/); assert.match(create[0], /ARTWORK_TASK_CORE/);
  }
  assert.match(read('src/audio/audio_player.cpp'), /AUDIO_PUMP_TASK_PRIORITY = 2;/);
});

test('phase CPU measurements are per-task with no heap allocation or stack scanning', () => {
  const cpu = block(cache, 'static uint32_t artworkTaskCpuUs()');
  assert.match(cpu, /vTaskGetInfo\(nullptr, &status, pdFALSE, eInvalid\)/);
  assert.doesNotMatch(cpu, /malloc|uxTaskGetSystemState|pdTRUE/);
  for (const pattern of [/JSON fetch .*cpu=%lums/, /JSON parse .*cpu=%lums/, /timing %s: %lums cpu=%lums/])
    assert.match(cache, pattern);
});
