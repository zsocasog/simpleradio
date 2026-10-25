const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const cpp = read('src/artwork/artwork_cache.cpp');
const policy = read('src/artwork/album_search_policy.h');
const titles = read('src/artwork/artwork_title_match.h');
function block(source, marker) {
  const at = source.indexOf(marker); assert.ok(at >= 0, marker);
  const start = source.indexOf('{', at); let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(marker);
}
const roundBody = policy.slice(policy.indexOf('public:') + 7, policy.indexOf('private:'))
  .replace(/constexpr bool (\w+)\(\) const/g, '$1()')
  .replace(/constexpr (?:bool|void) (\w+)\(\)/g, '$1()')
  .replace(/\b(deferred_|retrying_|retryConsumed_)\b/g, 'this.$1');
const Round = new Function(`return class { deferred_=false; retrying_=false; retryConsumed_=false; ${roundBody} }`)();
const fetchBody = block(cpp, 'auto fetchMusicBrainz =')
  .replace('int status = 0;', 'let status = 0;')
  .replace('const bool ok = fetchArtworkJson(url, doc, deadlineMs, cancelled, &status);',
    'const ok = fetchApi(url, value => status = value);');
const fetchMb = new Function('search', 'waitForMusicBrainz', 'fetchApi', 'albumArtTrace', 'url', fetchBody);
test('503 suppresses all intermediate MusicBrainz calls, including Last.fm verification; retry is bounded', () => {
  const search = { musicBrainz: new Round(), retryReleaseGroup: false };
  const calls = []; let waits = 0;
  const run = (url, status) => fetchMb(search, () => { ++waits; return true; },
    (url, setStatus) => { calls.push(url); setStatus(status); return status === 200; }, () => {}, url);
  assert.equal(run('/recording/?query=title', 503), false);
  assert.equal(run('/release-group/?query=title', 200), false);
  assert.equal(run('/release/lastfm-id', 200), false);
  assert.equal(waits, 1); assert.equal(calls.length, 1);
  assert.equal(search.musicBrainz.beginRetry(), true);
  assert.equal(run('/release/lastfm-id', 503), false);
  assert.equal(run('/recording/?query=title', 200), false);
  assert.equal(calls.length, 2); assert.equal(search.musicBrainz.beginRetry(), false);
});
test('ordinary misses and non-503 failures do not schedule the special retry', () => {
  for (const status of [200, 404, -1]) {
    const search = { musicBrainz: new Round() };
    fetchMb(search, () => true, (_url, setStatus) => { setStatus(status); return status === 200; }, () => {}, '/recording/?');
    assert.equal(search.musicBrainz.beginRetry(), false);
  }
});
test('a failed release-group query is remembered, and a new song has a fresh policy', () => {
  const search = { musicBrainz: new Round(), retryReleaseGroup: false };
  fetchMb(search, () => true, (_url, setStatus) => { setStatus(503); return false; }, () => {}, '/release-group/?query=x');
  assert.equal(search.retryReleaseGroup, true); assert.equal(new Round().canRequest(), true);
});

const searchBody = block(cpp, 'bool ArtworkCache::resolveAndDownloadAlbumArtwork(')
  .replace('AlbumArtworkFallbacks fallbacks;', 'const fallbacks = { singles:[], artistCollections:[], unverified:[], compilations:[] };')
  .replace('AlbumArtworkSearch search;', 'const search = { musicBrainz:new Round() };')
  .replace(/const AlbumArtworkProvider providers\[\] = \{([\s\S]*?)\};/, 'const providers = [$1];')
  .replace(/AlbumArtworkProvider::/g, 'Provider.')
  .replace(/const char\* providerNames\[\] = \{([\s\S]*?)\};/, 'const providerNames = [$1];')
  .replace(/sizeof\(providers\) \/ sizeof\(providers\[0\]\)/g, 'providers.length')
  .replace(/sizeof\(providerNames\) \/ sizeof\(providerNames\[0\]\)/g, 'providerNames.length')
  .replace(/std::vector<String> candidates;/g, 'let candidates=[];')
  .replace(/const std::vector<String>\* fallbackStages\[\] = \{([\s\S]*?)\};/, (_m, list) => 'const fallbackStages = [' + list.replace(/&/g, '') + '];')
  .replace(/candidates = \*fallbackStages\[([^\]]+)\];/, 'candidates = [...fallbackStages[$1]];')
  .replace(/candidates.resize\(2\)/g, 'candidates.length = 2')
  .replace(/candidates.size\(\)/g, 'candidates.length')
  .replace(/!fallbacks\.(\w+)\.empty\(\)/g, 'fallbacks.$1.length > 0')
  .replace(/fallbacks\.(\w+)\.size\(\)/g, 'fallbacks.$1.length')
  .replace(/PlayerStateSnapshot current = PlayerState::instance\(\).snapshot\(\);/g, 'let current = player.snapshot();')
  .replace(/PlayerState::instance\(\).snapshot\(\)/g, 'player.snapshot()')
  .replace(/for \(const String& candidate : candidates\)/g, 'for (const candidate of candidates)')
  .replace(/min<uint32_t>/g, 'Math.min')
  .replace(/static_cast<unsigned(?: long)?>\(([^)]+)\)/g, '$1')
  .replace(/&memoryUnavailable/g, 'memoryUnavailable')
  .replace(/const (?:unsigned long|uint32_t|size_t|bool) /g, 'const ')
  .replace(/\b(?:unsigned long|uint32_t|size_t|bool) /g, 'let ');
function runSearch({ initial503 = true, retryCover = false, earlyCover = false, single = false, cancel = false, elapsed = 0 } = {}) {
  const calls = [], downloads = [];
  let now = 0, title = { c_str: () => 'song' };
  const image = name => ({ name, c_str: () => name });
  const context = {
    Round, Provider: { MusicBrainz:'MB', LastFm:'Last.fm', ITunes:'iTunes', Deezer:'Deezer' },
    millis: () => now, ALBUM_ART_LOOKUP_BUDGET_MS:35000, ALBUM_ART_IMAGE_BUDGET_MS:12000,
    artist: { c_str: () => 'artist' }, title, key:'key', outPath:{ c_str: () => 'ready' }, albumArtTrace() {},
    player: { snapshot: () => ({ playing:true, artist:context.artist, title }) },
    idlePrewarmCancellationRequested: () => false, lastDownloadStatus: () => ({ c_str: () => '' }),
    download: candidate => { downloads.push(candidate.name); return true; },
    resolveAlbumArtworkUrls: (_a, _t, provider, _deadline, fallbacks, search) => {
      calls.push(provider + (search.musicBrainz.retrying() ? '-retry' : ''));
      if (provider === 'MB') {
        search.musicBrainz.requestStarted();
        if (search.musicBrainz.retrying()) return retryCover ? [image('retry-cover')] : [];
        if (initial503) search.musicBrainz.serviceUnavailable();
      }
      if (provider === 'Last.fm') {
        if (single) fallbacks.singles.push(image('single'));
        if (earlyCover) return [image('own-album')];
      }
      if (provider === 'Deezer') { if (cancel) title = { c_str: () => 'new song' }; now = elapsed; }
      return [];
    }
  };
  const run = new Function(...Object.keys(context), searchBody);
  return { result:run(...Object.values(context)), calls, downloads };
}
test('production search retries MusicBrainz after other providers and before saved fallback images', () => {
  assert.deepEqual(runSearch({ retryCover:true }), {
    result:true, calls:['MB','Last.fm','iTunes','Deezer','MB-retry'], downloads:['retry-cover']
  });
  assert.deepEqual(runSearch({ single:true }), {
    result:true, calls:['MB','Last.fm','iTunes','Deezer','MB-retry'], downloads:['single']
  });
});
test('a downloaded own album stops the search and an ordinary miss does not repeat MusicBrainz', () => {
  assert.deepEqual(runSearch({ earlyCover:true }), {
    result:true, calls:['MB','Last.fm'], downloads:['own-album']
  });
  assert.deepEqual(runSearch({ initial503:false }), {
    result:false, calls:['MB','Last.fm','iTunes','Deezer'], downloads:[]
  });
});
test('track change, total deadline and reserved fallback time prevent unnecessary retry', () => {
  assert.equal(runSearch({ cancel:true }).calls.includes('MB-retry'), false);
  assert.equal(runSearch({ elapsed:35000 }).calls.includes('MB-retry'), false);
  const reserved = runSearch({ single:true, elapsed:24000 });
  assert.equal(reserved.calls.includes('MB-retry'), false); assert.deepEqual(reserved.downloads, ['single']);
});

function viewCode(code) {
  return code.replace(/\.size\(\)/g, '.length').replace(/const (?:char|size_t) /g, 'const ')
    .replace(/\bsize_t /g, 'let ').replace('char stack[8] = {};', 'const stack=Array(8).fill(0);')
    .replace(/sizeof\(stack\)/g, '8')
    .replace('return {text, {}, true};', 'return {main:text, subtitle:"", valid:true};')
    .replace(/return \{\{\}, \{\}, false\};/g, 'return {main:"", subtitle:"", valid:false};')
    .replace('return depth ? TitleParts{{}, {}, false} : TitleParts{trim(text.substr(0, first)), text.substr(first), true};',
      'return depth ? {main:"",subtitle:"",valid:false} : {main:trim(text.substr(0, first)),subtitle:text.substr(first),valid:true};');
}
const wordChar = new Function('c', block(titles, 'bool wordChar('));
const hasWord = new Function('wordChar', 'text', 'word', viewCode(block(titles, 'bool hasWord('))).bind(null, wordChar);
const splitSubtitle = new Function('trim', 'text', viewCode(block(titles, 'TitleParts splitSubtitle('))).bind(null, value => value.trim());
const protectedCode = block(titles, 'bool protectedSubtitle(')
  .replace('for (char c : normalized)', 'for (const c of normalized)')
  .replace(/for \(const char\* marker : \{([\s\S]*?)\}\)/, 'for (const marker of [$1])');
const protectedSubtitle = new Function('hasWord', 'normalized', protectedCode).bind(null, hasWord);
const cppString = text => ({ c_str: () => text, length: () => text.length });
const subtitleBody = block(cpp, 'static bool subtitleTrackMatch(')
  .replace(/std::string_view\((\w+)\.c_str\(\), \1.length\(\)\)/g, '$1.c_str()')
  .replace(/ArtworkTitleMatch::/g, 'policy.')
  .replace(/const (?:auto|String) /g, 'const ')
  .replace(/(found|wanted)\.main\.empty\(\)/g, '!$1.main.length')
  .replace(/(found|wanted)\.subtitle\.empty\(\)/g, '(!$1.subtitle.length)')
  .replace(/String\((\w+)\.(main|subtitle)\.data\(\), \1\.\2.size\(\)\)/g, 'String($1.$2)')
  .replace(/String\(annotation.data\(\), annotation.size\(\)\)/g, 'String(annotation)')
  .replace('foundMain == wantedMain', 'foundMain.c_str() === wantedMain.c_str()');
function subtitleMatch(foundArtist, foundTitle, wantedArtist = 'Shinedown', wantedTitle = 'Diamond Eyes') {
  const normalize = value => cppString(value.c_str().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9&,]+/g, ' ').trim());
  return new Function('foundArtist','foundTitle','wantedArtist','wantedTitle','artworkArtistsMatch', 'policy', 'normalizeArtworkText','String', subtitleBody)(
    foundArtist, cppString(foundTitle), wantedArtist, cppString(wantedTitle), (a,b) => a.toLowerCase() === b.toLowerCase(),
    { splitSubtitle, protectedSubtitle, minorTypo: () => false }, normalize, cppString);
}
test('production title matching accepts Shinedown subtitle spelling and punctuation variants', () => {
  for (const title of ['Diamond Eyes (Boom-Lay Boom-Lay Boom)', 'Diamond Eyes (Boom‐Lay Boom‐Lay Boom)', 'Diamond Eyes (Boom-Lay...)']) {
    assert.equal(subtitleMatch('Shinedown', title), true, title);
  }
});
test('live/demo/remix markers in later or nested groups, other artists and changed main titles stay rejected', () => {
  for (const title of ['Diamond Eyes (Boom-Lay Boom-Lay Boom) [Live from Washington State]',
    'Diamond Eyes (Boom (Live))', 'Diamond Eyes (Karaoke Version)', 'Diamond Eyes (Boom Remix)',
    'Diamond Eyes (Instrumental Demo 2003)', 'Diamond Eyes Theme', 'Diamond Eyes (Boom) Live', 'Diamond Eyes (Boom]']) {
    assert.equal(subtitleMatch('Shinedown', title), false, title);
  }
  assert.equal(subtitleMatch('Deftones', 'Diamond Eyes (Boom-Lay Boom-Lay Boom)'), false);
  assert.equal(subtitleMatch('Shinedown', 'Diamond Eyes (New)', 'Shinedown', 'Diamond Eyes (Old)'), false);
});
test('subtitle quality needs verified own-album evidence at every provider and deferred Last.fm path', () => {
  const needsAlbum = new Function('quality', block(cpp, 'static bool artworkMatchNeedsVerifiedAlbum('));
  assert.equal(needsAlbum(1), true); assert.equal(needsAlbum(2), true);
  assert.equal(needsAlbum(3), false); assert.equal(needsAlbum(4), false);
  assert.equal((cpp.match(/artworkMatchNeedsVerifiedAlbum\([^)]*\) && (?:album\.)?kind != AlbumArtworkKind::Album/g) || []).length, 5);
  assert.match(cpp, /!artworkMatchNeedsVerifiedAlbum\(pending.quality\) \|\| kind == AlbumArtworkKind::Album/);
  assert.match(cpp, /Last.fm album verification deferred with MusicBrainz/);
  assert.match(cpp, /httpStatus\) \*httpStatus = response.status/);
});
