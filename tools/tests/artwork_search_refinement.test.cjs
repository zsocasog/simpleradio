const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const cache = read('src/artwork/artwork_cache.cpp');
const http = read('src/artwork/artwork_http.cpp');
const policy = read('src/artwork/artwork_http_policy.h');
function block(source, marker) {
  const at = source.indexOf(marker); assert.ok(at >= 0, marker);
  const start = source.indexOf('{', at); let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(marker);
}
function translate(code) {
  return code.replace(/static_cast<size_t>\(([^)]+)\)/g, '$1')
    .replace(/\bconst int /g, 'const ').replace(/\b(size_t|bool|int) /g, 'let ')
    .replace(/\b(bounded_|remaining_)\b/g, 'this.$1')
    .replace(/\bBase::/g, 'base.');
}
const Boundary = vm.runInNewContext(`(class {
  bounded_ = false; remaining_ = 0;
  begin(length, chunked) ${translate(block(policy, 'void begin('))}
  consume(bytes) ${translate(block(policy, 'bool consume('))}
})`);
const readBody = new Function('base', 'bodyBoundary', 'service', 'buffer', 'size',
  translate(block(http, 'int read(uint8_t* buffer,')));
function clientHarness(declared, { chunked = false, actual = declared } = {}) {
  let received = 0, stopped = false, closePolls = 0;
  const base = {
    read(_buffer, size) { const count = Math.min(size, actual - received); received += count; return count || -1; },
    stop() { stopped = true; },
    available() { if (received === actual && !stopped) ++closePolls; return stopped ? 0 : actual - received; }
  };
  const boundary = new Boundary(); boundary.begin(declared, chunked);
  return { read: size => readBody(base, boundary, () => true, null, size), poll: () => base.available(),
    get stopped() { return stopped; }, get closePolls() { return closePolls; } };
}

test('a complete declared TLS body closes before HTTPClient polls the closed peer', () => {
  const h = clientHarness(3526);
  assert.equal(h.read(2048), 2048); assert.equal(h.stopped, false);
  assert.equal(h.read(1478), 1478); assert.equal(h.stopped, true);
  h.poll(); h.poll(); assert.equal(h.closePolls, 0);
});
test('short reads are accumulated and an incomplete body never triggers successful closure', () => {
  const h = clientHarness(10, { actual: 7 });
  assert.equal(h.read(4), 4); assert.equal(h.read(6), 3);
  assert.equal(h.stopped, false); assert.equal(h.read(3), -1);
  assert.match(http, /written < 0 \|\| !sink.size/);
  assert.match(http, /sink.size != static_cast<size_t>\(length\)/);
});
test('chunked and unknown-length bodies keep HTTPClient framing and EOF handling', () => {
  for (const [length, chunked] of [[10, true], [-1, false]]) {
    const h = clientHarness(length, { actual: 10, chunked });
    assert.equal(h.read(10), 10); assert.equal(h.stopped, false);
  }
  assert.match(http, /client.expectBody\(length, encoding.indexOf\("chunked"\) >= 0\)/);
  assert.match(http, /http.writeToStream\(&sink\)/);
  const finish = block(http, 'auto finish =');
  assert.ok(finish.indexOf('client.stop()') < finish.indexOf('http.end()'));
});
test('the old MusicBrainz boundary fits the new bounded PSRAM buffer; oversize responses stay rejected', () => {
  const sinkBody = block(http, 'size_t write(const uint8_t* bytes,')
    .replace('memcpy(data + size, bytes, length);', 'accepted += length;');
  const write = new Function('capacity', 'length', `let data = true, size = 192582, accepted = 0;
    let limitExceeded = false; const transfer = { service: () => true };
    const result = (() => ${sinkBody})(); return { result, size, limitExceeded };`);
  assert.deepEqual(write(192 * 1024, 4096), { result: 0, size: 192582, limitExceeded: true });
  assert.deepEqual(write(256 * 1024, 4096), { result: 4096, size: 196678, limitExceeded: false });
  assert.deepEqual(write(256 * 1024, 70000), { result: 0, size: 192582, limitExceeded: true });
  assert.equal((cache.match(/ArtworkHttpPolicy::MAX_METADATA_BYTES/g) || []).length, 2);
  assert.match(http, /response size limit reached: limit=/);
  assert.match(http, /MALLOC_CAP_SPIRAM/);
});
test('minor title spelling differences cannot bypass the existing strict artist comparison', () => {
  const match = block(cache, 'static bool exactTrackMatch(');
  const result = match.slice(match.lastIndexOf('return artworkArtistsMatch'))
    .replace(/\}\s*$/, '').replace(/ArtworkTitleMatch::minorTypo/g, 'minorTypo');
  const run = new Function('artistMatches', 'allowTitleTypos', 'minorTypo', `
    const foundArtist = '', wantedArtist = '';
    const expectedTitle = { length: () => 32, c_str: () => 'title typo' };
    const actualTitle = { c_str: () => 'title corrected' };
    const artworkArtistsMatch = () => artistMatches;
    ${result}`);
  assert.equal(run(true, true, () => true), true);
  assert.equal(run(false, true, () => { throw new Error('wrong artist must short circuit'); }), false);
  assert.equal(run(true, false, () => true), false);
});
test('exact title matches rank ahead of minor typos and provider order stays intact', () => {
  const quality = block(cache, 'auto matchQuality =')
    .replace(/const String& /g, '').replace(/\bartist\b/g, 'wantedArtist').replace(/\btitle\b/g, 'wantedTitle');
  const rank = new Function('exactTrackMatch', `const foundArtist='',foundTitle='',wantedArtist='',wantedTitle=''; ${quality}`);
  assert.equal(rank((_a, _t, _wa, _wt, studio, typos) => !studio && !typos), 3);
  assert.equal(rank((_a, _t, _wa, _wt, studio, typos) => !studio && typos), 2);
  assert.equal(rank((_a, _t, _wa, _wt, studio) => !!studio), 1);
  assert.match(cache, /if \(quality >= 2\) addCandidate\(cover, AlbumArtworkKind::Compilation/);
  assert.match(cache, /MusicBrainz,\s*AlbumArtworkProvider::LastFm,\s*AlbumArtworkProvider::ITunes,\s*AlbumArtworkProvider::Deezer/);
});
test('Last.fm correction is checked locally and missing album/image fields get distinct logs', () => {
  const lastfm = cache.slice(cache.indexOf('String lastFmUrl ='), cache.indexOf('if (provider == AlbumArtworkProvider::Deezer)'));
  assert.match(lastfm, /&autocorrect=1&artist=/);
  assert.ok(lastfm.indexOf('matchQuality(foundArtist, foundTitle)') < lastfm.indexOf('addCandidate(cdnCover'));
  assert.match(lastfm, /matched track has no album data/);
  assert.match(lastfm, /matched track has no usable album image or release MBID/);
  assert.match(lastfm, /https:\/\/ws.audioscrobbler.com/);
});
