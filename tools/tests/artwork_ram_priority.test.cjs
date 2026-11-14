const fs = require('node:fs'), path = require('node:path'), test = require('node:test'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
function body(source, marker) {
  const start = source.indexOf('{', source.indexOf(marker)); let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(marker);
}
const source = read('src/artwork/ram_work_priority.h');
const js = s => s.replace('TaskStatus_t status{};', 'const status = {};').replace('&status', 'status')
  .replace(/nullptr/g, 'null').replace(/previous_/g, 'this.previous_').replace(/pdFALSE|eInvalid/g, '0');
const enter = new Function('vTaskGetInfo', 'vTaskPrioritySet', 'tskIDLE_PRIORITY', js(body(source, 'ArtworkRamWorkPriority()')));
const leave = new Function('vTaskPrioritySet', 'tskIDLE_PRIORITY', js(body(source, '~ArtworkRamWorkPriority()')));
function task(base, inherited = 0) {
  const calls = [], set = (_, value) => { base = value; calls.push(value); };
  return { calls, base: () => base, effective: () => Math.max(base, inherited), scope() {
    const s = {}; enter.call(s, (_, status) => { status.uxBasePriority = base; }, set, 0);
    return () => leave.call(s, set, 0);
  }};
}
test('RAM artwork shares display CPU time below audio, restoring idle after nested work/errors', () => {
  const t = task(0), outer = t.scope(), inner = t.scope();
  assert.equal(t.base(), 1); inner(); assert.equal(t.base(), 1);
  try { throw Error('network cancelled'); } catch {} finally { outer(); }
  assert.equal(t.base(), 0); assert.deepEqual(t.calls, [1, 0]);
});
test('inherited priority is never saved as the worker base; higher-priority callers stay unchanged', () => {
  const t = task(0, 10), done = t.scope(); assert.equal(t.base(), 1); done();
  assert.equal(t.base(), 0); assert.equal(t.effective(), 10);
  for (const p of [1, 2, 10]) { const t = task(p), done = t.scope(); done(); assert.equal(t.base(), p); assert.deepEqual(t.calls, []); }
  assert.doesNotMatch(source, /malloc|new |xTaskCreate|vTaskDelay/);
});
test('only network and the RAM album search are promoted; shared worker and flash jobs stay idle', () => {
  const cache = read('src/artwork/artwork_cache.cpp'), http = read('src/artwork/artwork_http.cpp');
  assert.equal((cache.match(/const ArtworkRamWorkPriority priority;/g) || []).length, 1);
  assert.match(body(cache, 'bool ArtworkCache::resolveAndDownloadAlbumArtwork('), /const ArtworkRamWorkPriority priority;/);
  assert.doesNotMatch(body(cache, 'void ArtworkCache::runDownloadJob('), /ArtworkRamWorkPriority/);
  assert.match(body(http, 'bool get('), /const ArtworkRamWorkPriority priority;/);
  const download = body(cache, 'bool ArtworkCache::download(');
  assert.ok(download.indexOf('return ready; // No filesystem fallback') < download.indexOf('LittleFS.open'));
  assert.match(cache, /ARTWORK_TASK_PRIORITY = 0;/);
});

// Execute the actual response validation/cleanup order. The simulated close
// takes the clock past the deadline, reproducing a complete 957-byte response.
const http = read('src/artwork/artwork_http.cpp');
const request = body(http, 'template<class Client> bool request(');
const tail = request.slice(request.indexOf('  const int written = http.writeToStream(&sink);'), -1)
  .replace(/const (?:int|bool) /g, 'const ').replace('static_cast<size_t>(length)', 'length').replace('&sink', 'sink');
const finishRequest = new Function('http', 'sink', 'transfer', 'finish', 'response', 'length', 'limit', tail);
function response({ bytes = 957, declared = 957, written = bytes, valid = true, overflow = false } = {}) {
  let now = 100, closes = 0;
  const sink = { size: bytes, limitExceeded: overflow, release: () => 'payload' }, result = {};
  const ok = finishRequest({ writeToStream: () => written }, sink, { service: () => valid && now < 120 },
    () => { now = 150; ++closes; }, result, declared, 1024);
  return { ok, result, closes };
}
test('a complete timely response survives slow cleanup, including chunked framing success', () => {
  for (const declared of [957, -1]) {
    const r = response({ declared }); assert.equal(r.ok, true); assert.equal(r.result.size, 957); assert.equal(r.closes, 1);
  }
});
test('late, cancelled, oversized, empty and incomplete bodies still fail and close once', () => {
  for (const options of [{valid:false}, {overflow:true}, {bytes:0}, {bytes:956}, {declared:-1,written:-10}]) {
    const r = response(options); assert.equal(r.ok, false); assert.equal(r.result.data, undefined); assert.equal(r.closes, 1);
  }
});
