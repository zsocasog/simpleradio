const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { withoutFeatureCredit } = require('./helpers/artwork_title_policy.cjs');
const root = path.resolve(__dirname, '../..');
const cpp = fs.readFileSync(path.join(root, 'src/artwork/artwork_cache.cpp'), 'utf8');
const titles = fs.readFileSync(path.join(root, 'src/artwork/artwork_title_match.h'), 'utf8');
function body(source, marker) {
  const at = source.indexOf(marker); assert.ok(at >= 0, marker);
  const start = source.indexOf('{', at); let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(marker);
}

const yearBody = body(titles, 'constexpr std::string_view withoutBroadcastYear(')
  .replace(/const (?:size_t|auto) /g, 'const ')
  .replace(/for \(char c : year\)/, 'for (const c of year)')
  .replace(/\.size\(\)/g, '.length').replace(/\.back\(\)/g, '.at(-1)')
  .replace('main.empty()', '!main.length');
const clean = new Function('trim', 'text', yearBody).bind(null, s => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ''));

// Execute the real title matcher and ranking lambda. Only artist normalization
// and the unrelated typo/subtitle policies are injected; their own full tests
// remain in the suite. This reproduces the supplied Madonna log exactly.
const exactBody = body(cpp, 'static bool exactTrackMatch(')
  .replace(/const auto /g, 'const ')
  .replace('ArtworkTitleMatch::withoutFeatureCredit', 'withoutFeatureCredit')
  .replace('String(stripped.data(), stripped.size())', 'stripped')
  .replace('auto stripFeature = [](String value)', 'const stripFeature = value =>')
  .replace('auto baseTitle = [&](String value)', 'const baseTitle = value =>')
  .replace(/const char\* (\w+)\[\] = \{([^}]+)\};/g, 'const $1 = [$2];')
  .replace(/for \(const char\* (\w+) : \{([^}]+)\}\)/g, 'for (const $1 of [$2])')
  .replace(/for \(const char\* (\w+) : (\w+)\)/g, 'for (const $1 of $2)')
  .replace(/const (?:String|size_t|int) /g, 'const ')
  .replace(/\b(?:String|size_t|int|bool) /g, 'let ')
  .replace(/\.length\(\)/g, '.length')
  .replace(/\.c_str\(\)/g, '')
  .replace(/value.remove\(([^)]+)\);/g, 'value = value.substring(0, $1);')
  .replace(/value.trim\(\);/g, 'value = value.trim();')
  .replace(/strlen\(([^)]+)\)/g, '$1.length')
  .replace('ArtworkTitleMatch::minorTypo', 'minorTypo');
const normalize = value => value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9&,]+/g, ' ').trim();
const exact = new Function('normalizeArtworkText', 'artworkArtistsMatch', 'minorTypo', 'withoutFeatureCredit',
  'foundArtist', 'foundTitle', 'wantedArtist', 'wantedTitle', 'allowStudioMix', 'allowTitleTypos', exactBody)
  .bind(null, normalize, (a, b) => normalize(a) === normalize(b), () => false, withoutFeatureCredit);
const quality = 'const artistCreditTitleMatch = () => false; ' + body(cpp, 'auto titleQuality =');
function rank(foundArtist, foundTitle, wantedTitle = 'Love Sensation [2026]', strip = true) {
  return new Function('exactTrackMatch', 'subtitleTrackMatch', 'foundArtist', 'foundTitle',
    'artist', 'title', 'lookupTitle', quality)(exact, () => false, foundArtist, foundTitle,
    'MADONNA', wantedTitle, strip ? clean(wantedTitle) : wantedTitle);
}

test('reproduces the log: a matching plain Madonna title scores zero with the uncleaned year', () => {
  assert.equal(rank('Madonna', 'Love Sensation', 'Love Sensation [2026]', false), 0);
  assert.equal(rank('Madonna', 'Love Sensation'), 4);
  assert.equal(rank('Madonna', 'Love Sensation (Radio Edit)'), 4);
});

test('the same artist check still rejects Loleatta Holloway and the Madonna/Kylie duet', () => {
  assert.equal(rank('Loleatta Holloway', 'Love Sensation'), 0);
  assert.equal(rank('Madonna & Kylie Minogue', 'Love Sensation'), 0);
});

test('year cleaning never removes live, remix or instrumental version markers', () => {
  for (const suffix of ['Live', "salute's infinite passion remix", 'Instrumental', 'Extended'])
    assert.equal(rank('Madonna', `Love Sensation (${suffix})`), 0, suffix);
  assert.equal(clean('Love Sensation (Live) [2026]'), 'Love Sensation (Live)');
  assert.equal(rank('Madonna', 'Love Sensation', 'Love Sensation (Live) [2026]'), 0);
});

test('existing weak studio-mix rules keep their ownership-proof requirement', () => {
  assert.equal(rank('Madonna', 'Love Sensation (Floorplan Mix)'), 2);
  const requiresOwner = new Function('quality', body(cpp, 'static bool artworkMatchNeedsVerifiedAlbum('));
  assert.equal(requiresOwner(2), true);
});

test('literal matching of a provider title that also contains the year is preserved', () => {
  assert.equal(rank('Madonna', 'Love Sensation [2026]'), 4);
});

test('only a standalone trailing square-bracketed year is ignored', () => {
  for (const title of ['1999', 'Song 2026', 'Song[2026]', '[2026]', 'Song [Live 2026]',
    'Song [2026 Remix]', 'Song [2026] Live', 'Song [2026', 'Song [1899]', 'Song [2100]'])
    assert.equal(clean(title), title);
  assert.equal(clean('Song [2026]  '), 'Song');
  assert.equal(clean('Song\t[2026]'), 'Song');
});

test('all provider queries and title verification use the same cleaned title, while cancellation keeps original metadata', () => {
  const resolver = cpp.slice(cpp.indexOf('std::vector<String> ArtworkCache::resolveAlbumArtworkUrls('),
    cpp.indexOf('bool ArtworkCache::resolveAndDownloadAlbumArtwork('));
  assert.match(resolver, /withoutBroadcastYear\(std::string_view\(title.c_str\(\), title.length\(\)\)\)/);
  assert.equal((resolver.match(/albumTitleForSearch\(lookupTitle\)/g) || []).length, 2);
  assert.match(resolver, /current.title != title/);
  assert.match(resolver, /MusicBrainz query: %s - %s", artist.c_str\(\), lookupTitle.c_str\(\)/);
});

test('playback logo downloads share a total deadline, and interrupted requests return to the queue', () => {
  assert.match(body(cpp, 'bool ArtworkCache::startDownloadTask('), /job->deadlineMs = deadlineMs/);
  const worker = body(cpp, 'void ArtworkCache::runDownloadJob(');
  assert.match(worker, /cache->download\(url, path, deadlineMs, allowSecureFallback\)/);
  const cancelled = body(worker, 'if (cancelled)');
  const queued = [];
  const cancel = new Function('url', 'cache', 'Serial', cancelled
    .replace('url.length()', 'url.length').replace('cache->', 'cache.'));
  cancel('https://new.example/logo.png', { queuePrewarmItem: (...args) => queued.push(args) }, { println() {} });
  assert.deepEqual(queued, [['https://new.example/logo.png', false]]);
  assert.doesNotMatch(cancelled, /storeDownloadResult|notePrewarmFailure/);
});
