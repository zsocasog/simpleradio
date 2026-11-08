const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const read = file => fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
const display = read('src/display/display.cpp');
const policy = read('src/display/station_picker_policy.h');

function body(source, signature) {
  const index = source.indexOf(signature);
  assert.ok(index >= 0, signature);
  const start = source.indexOf('{', index);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(signature);
}

const timing = vm.runInNewContext(`
  const u32 = n => n >>> 0;
  function elapsedAtLeast(now, since, delay) ${body(policy, 'inline bool elapsedAtLeast(').replace(/static_cast<uint32_t>\(/g, 'u32(')}
  function ready(now, opened, changed, presented, openGuard, delay) ${body(policy, 'inline bool autoPlayReady(')}
  ({ ready, elapsedAtLeast });
`);

test('autoplay gives the displayed selection its full configured waiting time', () => {
  assert.equal(timing.ready(3500, 0, 1000, 3000, 700, 2500), false);
  assert.equal(timing.ready(5499, 0, 1000, 3000, 700, 2500), false);
  assert.equal(timing.ready(5500, 0, 1000, 3000, 700, 2500), true);
  assert.equal(timing.ready(5000, 0, 0, 100, 700, 2500), false);
});

test('input settling and autoplay timing survive millis rollover', () => {
  const nearWrap = 0xffffff00;
  assert.equal(timing.elapsedAtLeast(20, nearWrap, 277), false);
  assert.equal(timing.elapsedAtLeast(21, nearWrap, 277), true);
  assert.equal(timing.ready(2244, nearWrap, nearWrap, nearWrap, 700, 2500), true);
});

test('selection paints reuse ready pixels without filesystem access and invalidate another station', () => {
  const context = logoCacheHarness();
  const entries = context.pickerLogos;
  entries[0] = { station: 2, source: 'saved-logo', ready: true, probed: true, pixels: [123], path: '/cached' };
  for (let i = 0; i < 30; i++) assert.ok(context.ready(0, { id: 2, logo: 'saved-logo' }));
  assert.equal(context.ready(0, { id: 3, logo: 'different-logo' }), false);
  assert.equal(entries[0].probed, false);
  assert.equal(entries[0].path, '');
});

function logoCacheHarness() {
  const context = vm.createContext({ PICKER_VISIBLE_ROWS: 5, PICKER_LOGO_CACHE_SIZE: 10, nextSpare: 0,
    pickerLogoJob: { row: -1 }, pickerLogos: Array.from({length: 10}, () => ({
      station: -1, source: '', ready: false, probed: false, pixels: null, path: ''
    }))
  });
  const translated = (signature) => body(display, signature)
    .replace('std::swap(pickerLogos[a], pickerLogos[b]);', '[pickerLogos[a], pickerLogos[b]] = [pickerLogos[b], pickerLogos[a]];')
    .replace('static unsigned nextSpare = 0;', '')
    .replace('PickerLogo& entry', 'const entry')
    .replace(/\bconst int /g, 'const ').replace(/\bint /g, 'let ');
  vm.runInContext('function swapPickerLogos(a,b) '+translated('static void swapPickerLogos(')+
    '\nfunction reservePickerLogo(station) '+translated('static int reservePickerLogo(')+
    '\nfunction ready(row, station) '+translated('static bool pickerLogoReady('), context);
  return context;
}

test('scrolling retains station image buffers and an in-flight conversion follows its station', () => {
  const h = logoCacheHarness();
  const station = i => ({ id: i, logo: 'logo-'+i });
  for (let row = 0; row < 5; row++) {
    h.ready(row, station(row));
    h.pickerLogos[row].pixels = [row];
    h.pickerLogos[row].ready = true;
  }
  const original = h.pickerLogos.slice(0,5).map(e => e.pixels);
  h.pickerLogoJob.row = 2;
  for (let row = 0; row < 5; row++) h.ready(row, station(row+1));
  assert.equal(h.pickerLogoJob.row, 1);
  for (let row = 0; row < 4; row++) assert.equal(h.pickerLogos[row].pixels, original[row+1]);
  for (let row = 0; row < 5; row++) h.ready(row, station(row));
  for (let row = 0; row < 5; row++) assert.equal(h.pickerLogos[row].pixels, original[row]);
  assert.equal(h.pickerLogoJob.row, 2);
});

test('cache eviction preserves unique buffer ownership and never evicts an active conversion', () => {
  const h = logoCacheHarness();
  for (let i = 0; i < 10; i++) h.pickerLogos[i] = {
    station: i, source: 'logo-'+i, pixels: [i], ready: true, probed: true, path: '/cached-'+i
  };
  h.pickerLogoJob.row = 5;
  const leased = h.pickerLogos[5].pixels;
  for (let i = 10; i < 60; i++) h.ready(i % 5, {id:i, logo:'logo-'+i});
  assert.equal(h.pickerLogos[h.pickerLogoJob.row].pixels, leased);
  assert.equal(h.pickerLogos[h.pickerLogoJob.row].station, 5);
  assert.equal(new Set(h.pickerLogos.map(e => e.pixels)).size, 10);
});

function advanceHarness({ row = 0, station = 2, pending = false, complete = true, changed = true } = {}) {
  let polls = 0, closed = 0, frees = 0;
  const original = [77], fresh = [88];
  const entry = { station: 2, source: 'logo', pixels: original, ready: true, path: '/old', modified: 5 };
  const job = { row, station, source: 'logo', ticket: 9 };
  const context = vm.createContext({ pickerLogoJob: job, pickerLogos: [entry],
    PickerLogoLoader: { Result: class { constructor() { this.pixels = null; }
      releasePixels() { const p = this.pixels; this.pixels = null; return p; }
    }, take: (ticket, result) => {
      ++polls; assert.equal(ticket, 9);
      if (!complete) return false;
      result.pixels = changed ? fresh : null; result.path = '/cached'; result.modified = 7; return true;
    } }, millis: () => 1000, pickerSelectionPending: () => pending,
    free: value => { assert.equal(value, original); ++frees; },
    cancelPickerLogoJob: () => { ++closed; job.row = -1; }
  });
  const fn = body(display, 'static int advancePickerLogo(')
    .replace('PickerLogo& entry', 'const entry')
    .replace('PickerLogoLoader::Result result;', 'const result = new PickerLogoLoader.Result();')
    .replace('PickerLogoLoader::take', 'PickerLogoLoader.take')
    .replace(/std::move\(([^)]+)\)/g, '$1')
    .replace(/\bint /g, 'let ');
  vm.runInContext('function advance() ' + fn, context);
  return { context, job, entry, original, fresh, get polls() { return polls; },
    get frees() { return frees; }, get closed() { return closed; } };
}

test('an unfinished background image leaves the current tile intact without drawing-path IO', () => {
  const h = advanceHarness({ complete: false });
  assert.equal(h.context.advance(), -1); assert.equal(h.polls, 1);
  assert.equal(h.entry.pixels, h.original); assert.equal(h.entry.ready, true);
  assert.equal(h.frees, 0); assert.equal(h.closed, 0);
  assert.doesNotMatch(body(display, 'static int advancePickerLogo('), /LittleFS|readPickerLogoRow|file\./);
  assert.doesNotMatch(body(display, 'static bool beginPickerLogo('), /LittleFS|stationArtworkReady|file\.|heap_caps/);
});

test('a newly queued encoder selection takes priority over accepting a background result', () => {
  const h = advanceHarness({ pending: true });
  assert.equal(h.context.advance(), -1); assert.equal(h.polls, 0);
  assert.equal(h.entry.pixels, h.original); assert.equal(h.closed, 0);
});

test('only a complete matching image replaces the live tile, with one ownership transfer', () => {
  const h = advanceHarness();
  assert.equal(h.context.advance(), 0); assert.equal(h.entry.ready, true);
  assert.equal(h.entry.path, '/cached'); assert.equal(h.entry.modified, 7);
  assert.equal(h.entry.pixels, h.fresh); assert.equal(h.frees, 1); assert.equal(h.closed, 1);
  const stale = advanceHarness({ station: 9 });
  assert.equal(stale.context.advance(), -1); assert.equal(stale.polls, 0);
  assert.equal(stale.entry.pixels, stale.original); assert.equal(stale.frees, 0);
});

test('an unchanged or unavailable source preserves cached pixels without repainting its tile', () => {
  const h = advanceHarness({ changed: false });
  assert.equal(h.context.advance(), -1); assert.equal(h.entry.ready, true);
  assert.equal(h.entry.path, '/old'); assert.equal(h.entry.pixels, h.original);
  assert.equal(h.frees, 0); assert.equal(h.entry.checkedMs, 1000); assert.equal(h.closed, 1);
});

test('an older rendered request cannot acknowledge a newer selection of the same station', () => {
  let requested = 3, presented = 1;
  const context = vm.createContext({ request: 3, presentedMs: 0,
    pickerRequestSerial: { load: () => requested }, pickerPresentedSerial: { load: () => presented },
    pickerPresentedAt: { load: () => 9000 }
  });
  const fn = body(display, 'bool Display::stationPickerPresented(').replace(/std::memory_order_(?:acquire|relaxed)/g, 'undefined');
  vm.runInContext('function ready(request) ' + fn, context);
  assert.equal(context.ready(3), false);
  assert.equal(context.ready(1), false);
  presented = 3;
  assert.equal(context.ready(3), true);
  assert.equal(context.presentedMs, 9000);
  requested = 4;
  assert.equal(context.ready(3), false);
});
