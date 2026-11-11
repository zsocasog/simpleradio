const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const loader = read('src/artwork/picker_logo_loader.cpp');
const cache = read('src/artwork/artwork_cache.cpp');
function body(source, marker) {
  const at = source.indexOf(marker); assert.ok(at >= 0, marker);
  const start = source.indexOf('{', at); let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(marker);
}

// Execute the production loader orchestration; filesystem, PSRAM allocation and
// row reduction are injected so cancellation/short reads/OOM are repeatable.
// Pixel arithmetic itself runs separately in lcd_picker_pixels and the native
// constexpr tests (including the actual 176->32 and 117->21 geometries).
const load = body(loader, 'void load(Job& job)')
  .replace('String path;', "let path = '';")
  .replace('ArtworkCache::instance().findExistingLcdArtworkPath(job.source, path)',
    'resolve(job.source, value => path = value)')
  .replace(/path.length\(\)/g, 'path.length')
  .replace('LcdThumbnailRam::File file(LittleFS.mountpoint(), path.c_str());', 'const file = LittleFS.open(path, "r");')
  .replace(/const (?:time_t|size_t) /g, 'const ')
  .replace('uint8_t header[8];', 'const header = new Uint8Array(8);')
  .replace(/sizeof\(header\)/g, 'header.length')
  .replace('static_cast<size_t>(job.targetSide)', 'job.targetSide')
  .replace('sizeof(uint16_t)', '2')
  .replace(/static_cast<uint16_t\*>\(heap_caps_malloc\(bytes, MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT\)\)/, 'allocate(bytes)')
  .replace('auto read = [&](uint8_t* buffer, size_t count)', 'const read = (buffer, count) =>')
  .replace('for (int y', 'for (let y')
  .replace(/PickerLogoMath::/g, 'math.')
  .replace('std::move(path)', 'path');
function run(options = {}) {
  const image = { path: '', modified: 0, pixels: null,
    releasePixels() { const p = this.pixels; this.pixels = null; return p; } };
  const job = { ticket: 7, source: 'station-logo', knownPath: '', knownModified: 0,
    knownReady: false, sourceSide: 176, targetSide: 32, result: image, ...options.job };
  let active = !options.cancelled, allocated = 0, freed = 0, rows = 0, sleeps = 0, bytesRead = 0;
  const file = { getLastWrite: () => 123, size: () => 61960,
    read: (_buffer, count) => { bytesRead += count; return count; } };
  const deps = {
    current: ticket => ticket === job.ticket && active,
    resolve: (_source, set) => { set('/cache/ready.sr565'); return !options.missing; },
    LittleFS: { open: () => options.openFailed ? null : file },
    allocate: bytes => { ++allocated; return options.oom ? null : new Uint8Array(bytes); },
    free: pixels => { assert.ok(pixels); ++freed; },
    vTaskDelay: ticks => { assert.equal(ticks, 1); ++sleeps; if (options.cancelAfterYield) active = false; },
    math: { validHeader: () => !options.badHeader,
      readRow: (readRowBytes, _pixels, y, sourceSide, targetSide) => {
        assert.equal(sourceSide, job.sourceSide); assert.equal(targetSide, job.targetSide);
        const count = ((y + 1) * sourceSide / targetSide | 0) - (y * sourceSide / targetSide | 0);
        readRowBytes(null, count * sourceSide * 2); ++rows;
        return y !== options.shortAtRow;
      } }
  };
  new Function('job', ...Object.keys(deps), load)(job, ...Object.values(deps));
  return { image, allocated, freed, rows, sleeps, bytesRead };
}

test('the background loader publishes a complete 32px tile with unchanged source colors', () => {
  const r = run();
  assert.equal(r.rows, 32); assert.equal(r.allocated, 1); assert.equal(r.freed, 0);
  assert.equal(r.bytesRead, 8 + 176 * 176 * 2); assert.equal(r.sleeps, 16);
  assert.equal(r.image.path, '/cache/ready.sr565'); assert.equal(r.image.modified, 123);
  assert.equal(r.image.pixels.length, 32 * 32 * 2);
});

test('ready and unchanged logos perform only a metadata probe without allocating/resizing', () => {
  const r = run({ job: { knownReady: true, knownPath: '/cache/ready.sr565', knownModified: 123 } });
  assert.equal(r.allocated, 0); assert.equal(r.rows, 0); assert.equal(r.bytesRead, 0);
});

test('an updated logo at the same path is rebuilt while the existing tile remains separately owned', () => {
  const r = run({ job: { knownReady: true, knownPath: '/cache/ready.sr565', knownModified: 122 } });
  assert.equal(r.rows, 32); assert.ok(r.image.pixels); assert.equal(r.image.modified, 123);
});

test('closing the picker cancels work between rows and releases its unpublished private buffer', () => {
  const r = run({ cancelAfterYield: true });
  assert.equal(r.rows, 2); assert.equal(r.freed, 1); assert.equal(r.image.pixels, null);
  assert.equal(r.image.path, '');
  const beforeStart = run({ cancelled: true });
  assert.equal(beforeStart.rows, 0); assert.equal(beforeStart.allocated, 0);
});

test('truncated files, unavailable PSRAM and invalid headers cannot publish a partial image', () => {
  for (const shortAtRow of [0, 15, 31]) {
    const r = run({ shortAtRow });
    assert.equal(r.freed, 1); assert.equal(r.image.pixels, null); assert.equal(r.image.path, '');
  }
  const oom = run({ oom: true }); assert.equal(oom.rows, 0); assert.equal(oom.image.pixels, null);
  const invalid = run({ badHeader: true }); assert.equal(invalid.allocated, 0);
  for (const options of [{ missing: true }, { openFailed: true }]) assert.equal(run(options).allocated, 0);
});

test('compact LCD thumbnails use the same background path and exact source byte count', () => {
  const r = run({ job: { sourceSide: 117, targetSide: 21 } });
  assert.equal(r.rows, 21); assert.equal(r.bytesRead, 8 + 117 * 117 * 2);
  assert.equal(r.image.pixels.length, 21 * 21 * 2);
});

test('the loader reuses cached pixels without network traffic, flash writes or LCD access', () => {
  const code = loader.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /HTTPClient|ArtworkHttp|download\(|ensureLcdThumbnail|\.write\(|PlayerState|lcd\.|LovyanGFX/);
  assert.match(loader, /findExistingLcdArtworkPath\(job.source, path\)/);
  assert.match(loader, /MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT/);
  assert.doesNotMatch(loader, /malloc\(bytes\)|xTaskCreate|vTaskPrioritySet/);
});

test('single background image admission protects an active album lookup and retries task failures', () => {
  const dispatch = body(cache, 'void ArtworkCache::processPendingPickerLogo()');
  assert.match(dispatch, /!PickerLogoLoader::pending\(\) \|\| isDownloadActive\(\)/);
  assert.ok(dispatch.indexOf('markDownloadStarted("picker-logo")') < dispatch.indexOf('queueDownloadJob(job)'));
  assert.match(dispatch, /lastFailedStartMs < 1000/);
  assert.match(dispatch, /if \(!queueDownloadJob\(job\)\) \{\s*delete job;\s*markDownloadFinished\(\)/);
  const worker = body(cache, 'if (cache && kind == ArtworkJobKind::PickerLogo)');
  assert.match(worker, /PickerLogoLoader::process\(\);\s*return;/);
  assert.doesNotMatch(worker, /storeDownloadResult|PlayerState|Serial/);
});

test('cross-core locks protect only mailbox state, never files, deletion or pixel arithmetic', () => {
  const locks = [...loader.matchAll(/portENTER_CRITICAL\(&mux\);([\s\S]*?)portEXIT_CRITICAL\(&mux\);/g)];
  assert.equal(locks.length, 7);
  for (const lock of locks) assert.doesNotMatch(lock[1], /delete|free\(|\.read\(|\.open\(|readRow|vTaskDelay|std::move|heap_caps/);
});
