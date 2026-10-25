const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const header = fs.readFileSync(path.join(root, 'src/artwork/artwork_json.h'), 'utf8');
const cache = fs.readFileSync(path.join(root, 'src/artwork/artwork_cache.cpp'), 'utf8');
function body(marker) {
  const index = header.indexOf(marker); assert.ok(index >= 0, marker);
  const start = header.indexOf('{', index); let depth = 0;
  for (let i = start; i < header.length; ++i) {
    if (header[i] === '{') ++depth;
    if (header[i] === '}' && --depth === 0) return header.slice(start, i + 1);
  }
  throw new Error(marker);
}
function translate(code) {
  return code.replace(/const size_t /g, 'const ').replace(/void\* result/g, 'let result')
    .replace(/\bnullptr\b/g, 'null').replace(/\b(used_|peak_)\b/g, 'this.$1')
    .replace(/\b(canGrow|account|allocate|deallocate)\(/g, 'this.$1(');
}
function harness({ free = 4 * 1024 * 1024 } = {}) {
  let allocated = 0, calls = 0, failResize = false, failMalloc = false;
  const live = new Set();
  const make = size => { const ptr = { size }; live.add(ptr); allocated += size; return ptr; };
  const release = ptr => { assert.ok(live.delete(ptr)); allocated -= ptr.size; };
  const dependencies = {
    MALLOC_CAP_SPIRAM: 1, MALLOC_CAP_8BIT: 2,
    MAX_DOCUMENT_BYTES: 512 * 1024, PSRAM_HEADROOM: 512 * 1024,
    heap_caps_malloc: (size, caps) => { ++calls; assert.equal(caps, 3); return failMalloc ? null : make(size); },
    heap_caps_get_free_size: caps => { assert.equal(caps, 3); return free - allocated; },
    heap_caps_get_allocated_size: ptr => { assert.ok(live.has(ptr)); return ptr.size; },
    heap_caps_free: release,
    heap_caps_realloc: (ptr, size, caps) => {
      ++calls; assert.equal(caps, 3); assert.ok(live.has(ptr));
      if (failResize) return null;
      release(ptr); return make(size);
    }
  };
  const Class = new Function(...Object.keys(dependencies), `return class {
    used_ = 0; peak_ = 0;
    allocate(size) ${translate(body('void* allocate('))}
    deallocate(ptr) ${translate(body('void deallocate('))}
    reallocate(ptr, newSize) ${translate(body('void* reallocate('))}
    canGrow(requested, previous) ${translate(body('bool canGrow('))}
    account(previous, current) ${translate(body('void account('))}
  }`)(...Object.values(dependencies));
  return { allocator: new Class(), get live() { return live; }, get calls() { return calls; },
    set free(value) { free = value; }, set failResize(value) { failResize = value; },
    set failMalloc(value) { failMalloc = value; } };
}
test('small JSON pools and strings exclusively use PSRAM and are fully released', () => {
  const h = harness(); const a = h.allocator;
  const pools = Array.from({ length: 100 }, (_, i) => a.allocate(16 + i));
  assert.ok(pools.every(Boolean)); assert.equal(h.live.size, 100);
  for (const ptr of pools) a.deallocate(ptr);
  assert.equal(h.live.size, 0); assert.equal(a.used_, 0); assert.ok(a.peak_ > 0);
  assert.doesNotMatch(header, /\b(?:malloc|realloc)\s*\(/);
});
test('PSRAM failure has no internal-RAM fallback and no unbounded retry', () => {
  const h = harness(); h.failMalloc = true;
  assert.equal(h.allocator.allocate(1024), null); assert.equal(h.calls, 1);
  assert.equal(h.allocator.used_, 0);
  h.free = 512 * 1024;
  assert.equal(h.allocator.allocate(1024), null); assert.equal(h.calls, 1);
});
test('budget and growth failures retain the original JSON allocation', () => {
  const h = harness(); const a = h.allocator;
  const first = a.allocate(128 * 1024), second = a.allocate(256 * 1024);
  assert.equal(a.reallocate(first, 300 * 1024), null);
  assert.equal(a.used_, 384 * 1024); assert.equal(h.live.size, 2);
  h.failResize = true;
  assert.equal(a.reallocate(first, 200 * 1024), null);
  assert.equal(a.used_, 384 * 1024);
  a.deallocate(first); a.deallocate(second); assert.equal(a.used_, 0);
});
test('shrinking remains safe even under the PSRAM reserve or when realloc fails', () => {
  const h = harness(); const a = h.allocator; const ptr = a.allocate(4096);
  h.free = 4096; h.failResize = true;
  assert.equal(a.reallocate(ptr, 1024), ptr); assert.equal(a.used_, 4096);
  h.failResize = false;
  const smaller = a.reallocate(ptr, 1024); assert.equal(a.used_, 1024);
  assert.equal(a.reallocate(smaller, 0), null); assert.equal(a.used_, 0);
});

const schema = JSON.parse(header.match(/R"json\(([\s\S]*?)\)json"/)[1]);
function filtered(value, filter) {
  if (filter === true) return value;
  if (Array.isArray(value)) return value.map(item => filtered(item, filter[0]));
  return Object.fromEntries(Object.entries(value).filter(([key]) => key in filter)
    .map(([key, item]) => [key, filtered(item, filter[key])]));
}
const credit = [{ name: 'KISS', joinphrase: '', artist: { name: 'KISS', disambiguation: 'unused' } }];
const release = { id: 'release-id', title: 'Destroyer', date: '1976-03-15', status: 'Official',
  'artist-credit': credit, 'release-group': { id: 'group-id', 'primary-type': 'Album', 'secondary-types': [] },
  media: [{ format: 'CD', 'track-count': 10 }], packaging: 'Jewel Case',
  'label-info': [{ note: 'x'.repeat(1400) }], country: 'US' };
test('large MusicBrainz release lists retain every ranking field and discard unrelated data', () => {
  const input = { recordings: Array.from({ length: 16 }, () => ({
    score: 100, video: false, title: 'Detroit Rock City', 'artist-credit': credit,
    releases: Array.from({ length: 8 }, () => release), tags: [{ name: 'x'.repeat(1000) }]
  })) };
  const output = filtered(input, schema);
  assert.ok(JSON.stringify(input).length > 192 * 1024);
  assert.ok(JSON.stringify(input).length < 256 * 1024);
  assert.ok(JSON.stringify(output).length < JSON.stringify(input).length / 2);
  assert.equal(output.recordings.length, 16); assert.equal(output.recordings[0].releases.length, 8);
  const kept = output.recordings[0].releases[0];
  for (const key of ['id', 'title', 'date', 'status', 'artist-credit', 'release-group']) assert.ok(key in kept);
  assert.deepEqual(kept.media, [{ format: 'CD' }]);
  assert.deepEqual(kept['artist-credit'], credit);
  assert.equal('tags' in output.recordings[0], false); assert.equal('label-info' in kept, false);
});
test('release-group and direct release checks keep compilation/artist ownership evidence', () => {
  const group = { id: 'g', title: 'Compilation', score: 100, 'primary-type': 'Album',
    'secondary-types': ['Compilation'], 'artist-credit': [{ name: 'Various Artists', artist: { name: 'Various Artists' } }] };
  assert.deepEqual(filtered({ 'release-groups': [group] }, schema)['release-groups'][0], group);
  const direct = { ...release, 'release-group': group };
  const kept = filtered(direct, schema);
  assert.equal(kept['release-group']['primary-type'], 'Album');
  assert.deepEqual(kept['release-group']['secondary-types'], ['Compilation']);
  assert.equal(kept['artist-credit'][0].artist.name, 'KISS');
  const mixedCredit = [{ name: 'KISS' }, ' & ', { artist: { name: 'Guest' } }];
  assert.deepEqual(filtered({ 'artist-credit': mixedCredit }, schema)['artist-credit'], mixedCredit);
});
test('all remote metadata documents and their filters share the PSRAM allocator', () => {
  assert.equal((cache.match(/ArtworkJson::Allocator jsonAllocator;/g) || []).length, 2);
  assert.equal((cache.match(/JsonDocument doc\(&jsonAllocator\);/g) || []).length, 2);
  assert.match(cache, /JsonDocument filter\(doc.allocator\(\)\)/);
  assert.match(cache, /DeserializationOption::Filter\(filter\)/);
  assert.match(cache, /doc.clear\(\); \/\/ Release a partial PSRAM document/);
  assert.match(cache, /JSON memory: payload=%u internal=%u->%u PSRAM-free=%u/);
});
