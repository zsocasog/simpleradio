const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { Gate } = require('./helpers/artwork_memory_gate.cjs');
const root = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(root, 'data/app.js'), 'utf8');
const web = fs.readFileSync(path.join(root, 'src/web/web_server.cpp'), 'utf8');
const artwork = fs.readFileSync(path.join(root, 'src/artwork/artwork_cache.cpp'), 'utf8');
function body(source, name) {
  const text = source.match(new RegExp('^(?:async function|static (?:void|bool)|bool ArtworkCache::) ?' + name + '\\([^]*?^}', 'm'))?.[0];
  assert.ok(text, name); return text.slice(text.indexOf('{'));
}
const plain = code => code.replace(/->/g, '.').replace(/nullptr/g, 'null')
  .replace(/port(?:ENTER|EXIT)_CRITICAL\(&stationSaveMux\);/g, '')
  .replace(/\.c_str\(\)/g, '').replace(/\b(?:const uint32_t|const size_t|const String|const auto) /g, 'const ')
  .replace(/static_cast<unsigned long>\(([^)]+)\)/g, '$1')
  .replace(/\b(?:uint32_t|size_t|bool) /g, 'let ');

for (const playing of [true, false]) {
  test(`browser PNG conversion remains active with playing=${playing}, before radio fallback`, async () => {
    const calls = [], input = { id: '', name: 'Radio', url: 'https://stream.example', logo: 'https://logo.example/icon.png' };
    const c = vm.createContext({ playing, URLSearchParams, remoteUrl: s => /^https?:/.test(s), console,
      postStation: async data => { calls.push({ save: { ...data } }); return { id: 7 }; },
      uploadStationLogo: async (id, source) => { calls.push({ upload: { id, source } }); return '/logos/station-7-radio.png'; },
      fetch: async () => { throw Error('successful browser conversion must not start a remote fallback'); }
    });
    vm.runInContext('async function saveStationData(data) ' + body(app, 'saveStationData'), c);
    const saved = await c.saveStationData(input);
    assert.equal(saved.id, 7); assert.equal(calls.length, 3);
    assert.equal(calls[0].save.logo, input.logo); assert.equal(calls[0].save.prepareLogo, '0');
    assert.equal(calls[1].upload.source, input.logo);
    assert.equal(calls[2].save.logo, '/logos/station-7-radio.png');
    assert.equal(input.logo, 'https://logo.example/icon.png');
  });
}

for (const failure of ['conversion', 'link-null', 'link-network']) {
  test(`a browser ${failure} failure still queues the saved original for firmware fallback`, async () => {
    const fallback = []; let posts = 0;
    const c = vm.createContext({ URLSearchParams, remoteUrl: () => true, console: { warn() {} },
      postStation: async () => {
        if (++posts === 1) return { id: 3 };
        if (failure === 'link-network') throw Error('network'); return null;
      },
      uploadStationLogo: async () => failure === 'conversion' ? '' : '/logos/station-3.png',
      fetch: async (url, options) => { fallback.push({ url, id: options.body.get('id') }); return { ok: true }; }
    });
    vm.runInContext('async function saveStationData(data) ' + body(app, 'saveStationData'), c);
    assert.equal((await c.saveStationData({ logo: 'https://original.example/logo.ico' })).id, 3);
    assert.deepEqual(fallback, [{ url: '/api/station/logo/prepare', id: '3' }]);
  });
}

test('a failed initial station save starts neither conversion nor logo preparation', async () => {
  const c = vm.createContext({ remoteUrl: () => true, postStation: async () => null,
    uploadStationLogo: () => { throw Error('unexpected conversion'); }, fetch: () => { throw Error('unexpected fallback'); } });
  vm.runInContext('async function saveStationData(data) ' + body(app, 'saveStationData'), c);
  assert.equal(await c.saveStationData({ logo: 'https://logo.example' }), null);
});

test('an existing local logo keeps the single-save path without browser conversion or upload', async () => {
  const calls = [], c = vm.createContext({ remoteUrl: s => /^https?:/.test(s),
    postStation: async data => { calls.push(data); return { id: 7 }; },
    logoPngBlob: () => { throw Error('local files need no conversion'); },
    fetch: () => { throw Error('local files need no upload or fallback request'); }
  });
  vm.runInContext('async function uploadStationLogo(stationId, logoUrl) ' + body(app, 'uploadStationLogo') +
    '\nasync function saveStationData(data) ' + body(app, 'saveStationData'), c);
  await c.saveStationData({ id: '7', logo: '/logos/existing.png' });
  assert.equal(calls.length, 1); assert.equal(calls[0].prepareLogo, '1');
});

function workerHarness() {
  const saves = [], prewarm = [], reload = [], replies = [], disposed = [], starts = [];
  const gate = new Gate();
  let connected = true;
  const request = { pause: () => weak, send: (status, type, value) => replies.push({ status, type, value }) };
  const weak = { expired: () => !connected, lock: () => connected ? request : null };
  const c = vm.createContext({ pendingStationSave: null, now: 100, pdPASS: 1, taskOk: true, ioOk: true,
    millis: () => c.now++, Serial: { printf() {} }, vTaskDelete() {},
    ArtworkMemory: { gate: () => gate },
    createTask: job => { starts.push(job); return c.taskOk ? 1 : 0; },
    dispose: job => { disposed.push(job); if (job.memoryClaimed) gate.endStationSave(); },
    StationManager: { instance: () => ({ saveStation: (id, name, url, logo, job) => {
      saves.push({ id, name, url, logo }); job.outId = id < 0 ? 7 : id; return c.ioOk;
    } }) },
    storeStationLogo: job => { job.logo = '/logos/station-7-radio.png'; return c.ioOk; },
    ArtworkCache: { instance: () => ({ requestPrewarm: p => prewarm.push(p) }) },
    PlayerState: { instance: () => ({ snapshot: () => ({ stationId: 2, streamUrl: 'old' }) }) },
    queueLoadStation: (...args) => reload.push(args), serializeJson() {}
  });
  let worker = plain(body(web, 'stationSaveTask'))
    .replace('auto* job = static_cast<StationSaveJob*>(parameter);', 'const job = parameter;')
    .replace('job.outId);', 'job);').replace('(*job)', '(job)').replace(/::/g, '.');
  const start = plain(body(web, 'startStationSaveJob')).replace(/delete job;/g, 'dispose(job);');
  const dispatch = plain(body(web, 'dispatchPendingStationSave'))
    .replace('StationSaveJob* job = null;', 'let job = null;')
    .replace(/xTaskCreatePinnedToCore\([^]*?tskNO_AFFINITY\)/, 'createTask(job)').replace(/::/g, '.');
  let complete = plain(body(web, 'completeStationSave'))
    .replace('StationSaveJob* completed = null;', 'let completed = null;')
    .replace('std::unique_ptr<StationSaveJob> job(completed);', 'const job = completed;')
    .replace('job.logo.length()', 'job.logo.length')
    .replace('job.error.length()', 'job.error.length')
    .replace('if (auto request = job.request.lock())', 'const request = job.request.lock(); if (request)')
    .replace(/ArtworkJson::Allocator jsonAllocator;\s*JsonDocument doc\(&jsonAllocator\);/, 'const doc = {};').replace('String out;', 'let out;')
    .replace('serializeJson(doc, out);', 'out = JSON.stringify(doc);').replace(/::/g, '.');
  complete = complete.slice(0, -1) + 'dispose(job); }'; // C++ unique_ptr releases the job and its memory claim.
  vm.runInContext(`function run(parameter) ${worker}\nfunction enqueue(request, job) ${start}
    function dispatch() ${dispatch}
    function start(request, job) { enqueue(request, job); dispatch(); }
    function complete() ${complete}`, c);
  const job = (extra = {}) => ({ request: weak, id: -1, outId: -1, name: 'Radio', url: 'https://stream', logo: 'https://logo',
    prepareLogo: true, saved: false, done: false, started: false, memoryClaimed: false, errorStatus: 500, error: '', ...extra });
  return { c, job, request, saves, prewarm, reload, replies, disposed, starts, gate, disconnect: () => { connected = false; } };
}

test('flash save runs in the worker and success is acknowledged only after completion', () => {
  const h = workerHarness(), job = h.job(); h.c.start(h.request, job);
  assert.equal(h.saves.length, 0); h.c.complete(); assert.deepEqual(h.replies, []);
  h.c.run(job); assert.equal(job.done, true); assert.equal(job.saved, true); assert.deepEqual(h.replies, []);
  h.c.complete(); assert.equal(h.c.pendingStationSave, null);
  assert.deepEqual(h.prewarm, ['https://logo']); assert.deepEqual(h.reload, []);
  assert.equal(h.replies[0].status, 200); assert.deepEqual(JSON.parse(h.replies[0].value), { id: 7 });
});

test('browser normalization suppresses only the initial remote logo job', () => {
  const h = workerHarness(), job = h.job({ prepareLogo: false }); h.c.start(h.request, job); h.c.run(job); h.c.complete();
  assert.equal(h.replies[0].status, 200); assert.deepEqual(h.prewarm, []);
});

test('only one station or PNG save job is admitted; stack failure frees the slot', () => {
  const h = workerHarness(), first = h.job(), second = h.job();
  h.c.start(h.request, first); h.c.start(h.request, second);
  assert.equal(h.c.pendingStationSave, first); assert.deepEqual(h.disposed, [second]); assert.equal(h.starts.length, 1);
  assert.equal(h.replies[0].status, 503);
  const failed = workerHarness(); failed.c.taskOk = false;
  const job = failed.job({ upload: { bytes: [1] } }); failed.c.start(failed.request, job);
  failed.c.complete();
  assert.equal(failed.c.pendingStationSave, null); assert.deepEqual(failed.disposed, [job]);
  assert.equal(failed.saves.length, 0); assert.equal(failed.replies[0].status, 503);
});

test('disconnect before the worker starts creates no station and does not retain the slot', () => {
  const h = workerHarness(), job = h.job(); h.c.start(h.request, job); h.disconnect(); h.c.run(job); h.c.complete();
  assert.deepEqual(h.saves, []); assert.deepEqual(h.prewarm, []); assert.deepEqual(h.replies, []);
  assert.equal(h.c.pendingStationSave, null);
});

test('disconnect after persistence keeps the durable station but never dereferences an expired request', () => {
  const h = workerHarness(), job = h.job(); h.c.start(h.request, job); h.c.run(job); h.disconnect(); h.c.complete();
  assert.equal(h.saves.length, 1); assert.deepEqual(h.prewarm, ['https://logo']); assert.deepEqual(h.replies, []);
  assert.equal(h.c.pendingStationSave, null);
});

test('editing the playing station with the same stream preserves metadata and playback', () => {
  const h = workerHarness(), job = h.job({ id: 2, url: 'old' }); h.c.start(h.request, job); h.c.run(job); h.c.complete();
  assert.deepEqual(h.reload, [[2, false]]); assert.equal(h.replies[0].status, 200);
});

test('a failed durable save never returns success or schedules artwork', () => {
  const h = workerHarness(), job = h.job(); h.c.ioOk = false; h.c.start(h.request, job); h.c.run(job); h.c.complete();
  assert.equal(h.replies[0].status, 500); assert.deepEqual(h.prewarm, []);
});

test('browser-prepared PNG is stored by the same worker and returns a path without loading a station', () => {
  const h = workerHarness(), job = h.job({ id: 7, upload: { bytes: [1, 2] } });
  h.c.start(h.request, job); h.c.run(job); h.c.complete();
  assert.deepEqual(h.saves, []); assert.deepEqual(h.reload, []);
  assert.deepEqual(h.prewarm, ['/logos/station-7-radio.png']);
  assert.deepEqual(JSON.parse(h.replies[0].value), { path: '/logos/station-7-radio.png' });
});

test('file operations are absent from network save/upload callbacks and the prewarm entry point', () => {
  const prewarm = body(artwork, 'requestPrewarm').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(prewarm, /LittleFS|findExisting|validLcdThumbnail|preferredLocal/);
  assert.match(prewarm, /queuePrewarmItem\(item, highPriority\)/);
  const route = web.slice(web.indexOf('server.on("/api/station/save"'), web.indexOf('server.on("/api/station/delete"'));
  assert.doesNotMatch(route, /\.saveStation\(|LittleFS|commitLogoUpload/);
  assert.match(route, /queueStationSave\(request/);
  const receive = body(web, 'receiveStationLogo'), queue = body(web, 'queueStationLogoUpload');
  assert.doesNotMatch(receive + queue, /LittleFS|File |drawPng|commitLogoUpload|removeOldStationLogoUploads/);
  assert.match(receive, /MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT/); assert.match(receive, /120 \* 1024/);
  assert.match(queue, /request->_tempObject = nullptr/);
  assert.match(web, /~StationSaveJob\(\) \{\s*free\(upload\);/);
  assert.match(body(web, 'dispatchPendingStationSave'), /job, 0, nullptr, tskNO_AFFINITY/);
});

test('queued station saves allocate no task stack while album preparation owns memory', () => {
  const h = workerHarness(), job = h.job(); assert.equal(h.gate.beginAlbumPrepare(), true);
  h.c.enqueue(h.request, job); h.c.dispatch(); h.c.dispatch();
  assert.equal(h.starts.length, 0); assert.equal(h.c.pendingStationSave, job); assert.equal(job.started, false);
  h.gate.endAlbumPrepare(); h.c.dispatch(); assert.equal(h.starts.length, 1);
  h.c.run(job); h.c.complete(); assert.equal(h.replies[0].status, 200);
  assert.equal(h.gate.beginAlbumPrepare(), true);
});

test('an album waiting for one save goes before the next PNG or station save', () => {
  const h = workerHarness(), first = h.job(); h.c.start(h.request, first);
  assert.equal(h.gate.beginAlbumPrepare(), false);
  h.c.run(first); h.c.complete();
  const second = h.job({ upload: { bytes: [1] } }); h.c.enqueue(h.request, second); h.c.dispatch();
  assert.equal(h.starts.length, 1); assert.equal(h.gate.beginAlbumPrepare(), true);
  h.c.dispatch(); assert.equal(h.starts.length, 1);
  h.gate.endAlbumPrepare(); h.c.dispatch(); assert.equal(h.starts.length, 2);
});

test('disconnect while waiting for album memory releases the pending save without allocating a stack', () => {
  const h = workerHarness(); h.gate.beginAlbumPrepare();
  h.c.enqueue(h.request, h.job()); h.disconnect(); h.c.dispatch(); h.c.complete();
  assert.equal(h.starts.length, 0); assert.equal(h.c.pendingStationSave, null); assert.deepEqual(h.replies, []);
  assert.equal(h.gate.beginStationSave(), false); h.gate.endAlbumPrepare(); assert.equal(h.gate.beginStationSave(), true);
});

function uploadHarness() {
  const jobs = [], allocations = [], freed = [], c = vm.createContext({
    activeStationLogoUpload: 0, stationLogoUploadSequence: 0, allocationOk: true,
    MALLOC_CAP_SPIRAM: 1, MALLOC_CAP_8BIT: 2,
    heap_caps_malloc: (size, flags) => {
      allocations.push({ size, flags });
      return c.allocationOk ? { bytes: new Uint8Array(size - 16) } : null;
    },
    strtoul: value => Number(value || 0),
    free: value => { if (value) freed.push(value); },
    memcmp: (a, b, size) => Buffer.compare(Buffer.from(a).subarray(0, size), Buffer.from(b)),
    startStationSaveJob: (_request, job) => jobs.push(job)
  });
  let receive = body(web, 'receiveStationLogo')
    .replace('static constexpr size_t ', 'const ')
    .replace('auto* upload = static_cast<StationLogoUploadBuffer*>(heap_caps_malloc(', 'const upload = heap_caps_malloc(')
    .replace('MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));', 'MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);')
    .replace('offsetof(StationLogoUploadBuffer, bytes)', '16')
    .replace('auto* upload = static_cast<StationLogoUploadBuffer*>(request->_tempObject);', 'const upload = request->_tempObject;')
    .replace('request->onDisconnect([token]() { releaseStationLogoUpload(token); });', 'request->onDisconnect(() => releaseStationLogoUpload(token));')
    .replace('memcpy(upload->bytes + index, data, len);', 'upload->bytes.set(data.subarray(0, len), index);');
  let queue = body(web, 'queueStationLogoUpload')
    .replace('auto* upload = static_cast<StationLogoUploadBuffer*>(request->_tempObject);', 'const upload = request->_tempObject;')
    .replace("const uint8_t pngSignature[8] = {0x89, 'P', 'N', 'G', 13, 10, 26, 10};", 'const pngSignature = Uint8Array.from([137,80,78,71,13,10,26,10]);')
    .replace(/sizeof\(pngSignature\)/g, '8')
    .replace('auto* job = new (std::nothrow) StationSaveJob;', 'const job = {};')
    .replace('error.length()', 'error.length');
  const finish = code => plain(code).replace(/request\.getParam\("id"\)\.value\(\)\.toInt\(\)/g, 'Number(request.getParam("id").value())');
  vm.runInContext(`function releaseStationLogoUpload(token) ${plain(body(web, 'releaseStationLogoUpload'))}
    function receive(request, data, len, index, total) ${finish(receive)}
    function discardStationLogoUpload(request) ${plain(body(web, 'discardStationLogoUpload'))}
    function queue(request) ${finish(queue)}`, c);
  const request = () => {
    const attrs = {}, replies = []; let disconnect = () => {};
    return { _tempObject: null, attrs, replies, hasAttribute: k => k in attrs, getAttribute: k => attrs[k] || '',
      setAttribute: (k, v) => { attrs[k] = v; }, hasParam: k => k === 'id', getParam: () => ({ value: () => '7' }),
      onDisconnect: fn => { disconnect = fn; }, disconnect: () => disconnect(),
      send: (status, _type, message) => replies.push({ status, message }) };
  };
  return { c, jobs, allocations, freed, request };
}

test('fragmented browser PNG bytes arrive in PSRAM and ownership transfers exactly once', () => {
  for (const size of [8, 513, 120 * 1024]) {
    const h = uploadHarness(), request = h.request(), image = Buffer.alloc(size, 47);
    Buffer.from([137,80,78,71,13,10,26,10]).copy(image);
    for (let index = 0; index < size; index += 311) {
      const data = image.subarray(index, index + 311); h.c.receive(request, data, data.length, index, size);
    }
    assert.equal(h.allocations.length, 1); assert.equal(h.allocations[0].flags, 3);
    const staged = request._tempObject; assert.deepEqual(Buffer.from(staged.bytes), image);
    h.c.queue(request); assert.equal(request._tempObject, null); assert.equal(h.jobs.length, 1);
    assert.equal(h.jobs[0].upload, staged); assert.equal(h.c.activeStationLogoUpload, 0);
  }
});

test('oversized or empty PNG bodies never allocate or start a storage worker', () => {
  for (const total of [0, 7, 120 * 1024 + 1]) {
    const h = uploadHarness(), request = h.request(); h.c.receive(request, Buffer.alloc(0), 0, 0, total); h.c.queue(request);
    assert.equal(h.allocations.length, 0); assert.equal(h.jobs.length, 0); assert.equal(request.replies[0].status, 400);
  }
});

test('PSRAM exhaustion does not consume audio internal RAM or leave the upload slot busy', () => {
  const h = uploadHarness(), request = h.request(); h.c.allocationOk = false;
  h.c.receive(request, Buffer.alloc(8), 8, 0, 8); h.c.queue(request);
  assert.equal(h.c.activeStationLogoUpload, 0); assert.equal(h.jobs.length, 0);
  assert.equal(request._tempObject, null); assert.match(request.attrs.error, /PSRAM/);
});

test('concurrent and aborted uploads cannot corrupt another upload or clear its admission token', () => {
  const h = uploadHarness(), first = h.request(), busy = h.request(), next = h.request();
  h.c.receive(first, Buffer.from([137]), 1, 0, 8);
  h.c.receive(busy, Buffer.alloc(8), 8, 0, 8); assert.match(busy.attrs.error, /Another/); assert.equal(h.allocations.length, 1);
  first.disconnect(); assert.equal(h.c.activeStationLogoUpload, 0);
  h.c.receive(next, Buffer.from([137]), 1, 0, 8); const token = h.c.activeStationLogoUpload;
  first.disconnect(); assert.equal(h.c.activeStationLogoUpload, token); assert.ok(token > 0);
});

test('out-of-order, overflowing, incomplete and invalid PNG uploads never reach flash persistence', () => {
  for (const kind of ['offset', 'overflow', 'incomplete', 'signature']) {
    const h = uploadHarness(), request = h.request();
    if (kind === 'signature') h.c.receive(request, Buffer.alloc(8), 8, 0, 8);
    else {
      h.c.receive(request, Buffer.from([137]), 1, 0, 8);
      if (kind === 'offset') h.c.receive(request, Buffer.from([80]), 1, 3, 8);
      if (kind === 'overflow') h.c.receive(request, Buffer.alloc(9), 9, 1, 8);
    }
    h.c.queue(request); assert.equal(h.jobs.length, 0); assert.equal(request.replies[0].status, 400);
    assert.equal(request._tempObject, null); assert.equal(h.freed.length, 1);
  }
});

function persistenceHarness() {
  const source = fs.readFileSync(path.join(root, 'src/stations/station_manager.cpp'), 'utf8').replace(/\r/g, '');
  let code = source.match(/^bool StationManager::saveStation\([^]*?^}/m)[0]; code = code.slice(code.indexOf('{'));
  code = code.replace('StationWriteLock writeLock;', 'const writeLock = { ok: () => writerAvailable };')
    .replace(/  \{\n    StationLock lock(?:\(portMAX_DELAY\))?;\n([^]*?)\n  \}/g,
      '  { readDepth++; const lock = { ok: () => true }; try {\n$1\n} finally { readDepth--; } }')
    .replace('JsonDocument next;', 'let next;').replace('next.set(_doc)', '(next = structuredClone(_doc))')
    .replace('int savedId = id;', 'let savedId = id;')
    .replace('JsonArray stations = next["stations"].as<JsonArray>();', 'let stations = next.stations;')
    .replace('stations.isNull()', '!stations').replace('next["stations"].to<JsonArray>()', '(next.stations = [])')
    .replace('JsonObject target;', 'let target = null;').replace('for (JsonObject s : stations)', 'for (const s of stations)')
    .replace('s["id"].as<int>()', 's.id').replace('target.isNull()', '!target')
    .replace('stations.add<JsonObject>()', '(stations[stations.length] = {})')
    .replace('next.overflowed()', 'copyOverflowed').replace('swap(_doc, next);', '[_doc, next] = [next, _doc];')
    .replace(/\.length\(\)/g, '.length');
  const writes = [], c = vm.createContext({ structuredClone, readDepth: 0, writerAvailable: true, copyOverflowed: false,
    ioOk: true, _revision: 4, outId: -9, _doc: { stations: [{ id: 2, name: 'Existing', url: 'old', logo: 'old.png' }] },
    cleanLogoValue: s => s.trim(), nextId: () => Math.max(...c._doc.stations.map(s => s.id), -1) + 1,
    writeJsonAtomic: (_path, next) => {
      assert.equal(c.readDepth, 0, 'network readers must not block or promote the flash writer');
      writes.push(JSON.parse(JSON.stringify(next)));
      assert.equal(c._revision, 4); assert.equal(c._doc.stations[0].name, 'Existing');
      return c.ioOk;
    }
  });
  vm.runInContext('function save(id, name, url, logo) ' + code, c);
  return { c, writes };
}

test('station flash persistence releases the reader lock and publishes a durable snapshot', () => {
  const h = persistenceHarness(); assert.equal(h.c.save(-1, 'New', 'https://new', ' https://logo '), true);
  assert.equal(h.writes.length, 1); assert.equal(h.c._revision, 5); assert.equal(h.c.outId, 3);
  assert.equal(h.c._doc.stations.length, 2); assert.equal(h.c._doc.stations[1].logo, 'https://logo');
});

test('a station write failure preserves both the visible list and its revision', () => {
  const h = persistenceHarness(); h.c.ioOk = false;
  assert.equal(h.c.save(2, 'Changed', 'https://changed', 'new.png'), false);
  assert.equal(h.c._doc.stations[0].name, 'Existing'); assert.equal(h.c._revision, 4); assert.equal(h.c.outId, -9);
});

test('busy writers, allocation failure and invalid station data cause no persistence or live-list changes', () => {
  for (const reason of ['busy', 'memory', 'empty']) {
    const h = persistenceHarness();
    if (reason === 'busy') h.c.writerAvailable = false;
    if (reason === 'memory') h.c.copyOverflowed = true;
    assert.equal(h.c.save(-1, reason === 'empty' ? '' : 'New', 'url', 'logo'), false);
    assert.equal(h.writes.length, 0); assert.equal(h.c._revision, 4); assert.equal(h.c._doc.stations.length, 1);
  }
});
