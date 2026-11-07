const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const cpp = fs.readFileSync(path.join(__dirname, '../../src/artwork/artwork_cache.cpp'), 'utf8');
const jsonHeader = fs.readFileSync(path.join(__dirname, '../../src/artwork/artwork_json.h'), 'utf8');
function block(marker) {
  const at = cpp.indexOf(marker); assert.ok(at >= 0, marker);
  const start = cpp.indexOf('{', at); let depth = 0;
  for (let i = start; i < cpp.length; ++i) {
    if (cpp[i] === '{') ++depth;
    if (cpp[i] === '}' && --depth === 0) return cpp.slice(start, i + 1);
  }
  throw new Error(marker);
}
function strings(code) {
  return code.replace(/\(\*verifiedAliases\)/g, 'verifiedAliases').replace(/\*verifiedAliases/g, 'verifiedAliases')
    .replace(/->/g, '.').replace(/\.length\(\)|\.size\(\)/g, '.length')
    .replace(/([\w.]+)\.empty\(\)/g, '($1.length === 0)')
    .replace(/\.c_str\(\)/g, '').replace(/\.push_back\(/g, '.push(')
    .replace(/static_cast<(?:int|unsigned)>\(([^)]+)\)/g, '$1')
    .replace(/\b(\w+)\.trim\(\);/g, '$1 = $1.trim();')
    .replace('value.replace(separator, ",");', 'value = value.split(separator).join(",");')
    .replace(/auto (\w+) = \[&?\]\(([^)]*)\)/g, 'const $1 = ($2) =>')
    .replace(/std::vector<String>& |const String& |const String |String& |String |JsonArray |JsonObject /g, '')
    .replace(/\bconst (?:bool|int|size_t) /g, 'const ').replace(/\b(?:bool|int|size_t) /g, 'let ')
    .replace(/for \(const (\w+) : ([^)]+)\)/g, 'for (const $1 of $2)')
    .replace(/for \((\w+) : ([^)]+)\)/g, 'for (const $1 of $2)');
}
const normalizeArtworkText = value => value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  .replace(/[^a-z0-9&,]+/g, ' ').trim().replace(/ +/g, ' ');
let artistsCode = block('static bool artworkArtistsMatch(')
  .replace('const char* separators[] = {', 'const separators = [').replace(/" and ", "&", ","\s*\};/, '" and ", "&", ","\n    ];')
  .replace('for (const char* separator : separators)', 'for (const separator of separators)')
  .replace(/std::vector<String> (\w+);/g, 'const $1 = [];')
  .replace(/std::vector<String> (\w+) =/g, 'const $1 =')
  .replace('std::vector<bool> matched(foundCredits.size(), false);', 'const matched = Array(foundCredits.size()).fill(false);')
  .replace('return std::vector<String>{(*verifiedAliases)[0]};', 'return [verifiedAliases[0]];')
  .replace('std::sort(words.begin(), words.end());', 'words.sort();')
  .replace(/\bString (\w+) =/g, 'let $1 =');
artistsCode = strings(artistsCode);
const artistsMatch = new Function('normalizeArtworkText', 'foundArtist', 'wantedArtist', 'verifiedAliases = null', artistsCode)
  .bind(null, normalizeArtworkText);
const mbid = '408b2a33-d229-46a5-a361-0667bc616e34';
const fixture = { id: mbid, name: 'ATC', aliases: [
  { name: 'A Touch of Class', type: null }, { name: 'A.T.C', type: null },
  { name: 'Unrelated Band', type: 'Search hint' }
] };
const isCompilationArtist = value => ['various artists', 'various', 'v/a'].includes(value.toLowerCase());
const isMusicBrainzMbid = value => /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const aliasCode = strings(block('auto loadArtistAliases =')
  .replace(/AlbumArtworkProvider::/g, 'AlbumArtworkProvider.')
  .replace('ArtworkPhaseTrace phase("artist-alias-verification");', '')
  .replace('JsonDocument identity(doc.allocator());', 'const identity = {};')
  .replace('identity["id"].as<String>()', '(identity.id || "")')
  .replace('identity["aliases"].as<JsonArray>()', '(identity.aliases || [])')
  .replace(/&identity/g, 'identity')
  .replace(/\b(?:const )?String (\w+) =/g, 'let $1 =')
  .replace(/\bJsonArray (\w+) =/g, 'const $1 =')
  .replace(/(identity|alias)\["(\w+)"\] \| ""/g, '($1["$2"] || "")'));
function aliasHarness({ response = fixture, ok = true, deferred = false, ambiguous = false, id = mbid,
                        provider = 'iTunes', cancelled = false, expired = false } = {}) {
  const search = { artistMbid: id, artistAliases: [], artistIdentityAmbiguous: ambiguous, artistAliasLookupAttempted: false,
    musicBrainz: { canRequest: () => !deferred, retrying: () => false } };
  let calls = 0;
  const deps = { search, provider, AlbumArtworkProvider: { MusicBrainz: 'MB' }, artist: 'ATC', deadlineMs: 123,
    isMusicBrainzMbid, isCompilationArtist, artworkArtistsMatch: artistsMatch, normalizeArtworkText,
    cancelled: () => cancelled, deadlineReached: () => expired, albumArtTrace() {},
    addUniqueArtworkCandidate: (list, name) => { if (name && !list.includes(name)) list.push(name); },
    fetchMusicBrainz: (url, identity) => {
      ++calls; assert.ok(url.endsWith('/artist/' + mbid + '?fmt=json&inc=aliases'));
      Object.assign(identity, response); return ok;
    }
  };
  const load = new Function(...Object.keys(deps), aliasCode).bind(null, ...Object.values(deps));
  return { search, load, get calls() { return calls; } };
}
test('production artist matcher uses confirmed aliases and still requires every requested duet participant', () => {
  assert.equal(artistsMatch('A Touch of Class', 'ATC'), false);
  const aliases = ['atc', 'a touch of class'];
  assert.equal(artistsMatch('A Touch of Class', 'ATC', aliases), true);
  assert.equal(artistsMatch('A Touch of Class & Guest', 'ATC & Guest', aliases), true);
  assert.equal(artistsMatch('A Touch of Class', 'ATC & Guest', aliases), false);
  assert.equal(artistsMatch('The Weeknd', 'Tebay', aliases), false);
  assert.equal(artistsMatch('ATC Tribute', 'ATC', aliases), false);
  assert.equal(artistsMatch('Artist and Band', 'AB', ['ab', 'artist and band']), true);
  assert.equal(artistsMatch('Mariah Carey & Luther Vandross', 'Luther Vandross, Mariah Carey'), true);
});
test('production identity lookup keeps canonical and real aliases, excludes search hints, and runs once per song', () => {
  const h = aliasHarness(); h.load(); h.load();
  assert.equal(h.calls, 1);
  assert.deepEqual(h.search.artistAliases, ['atc', 'a touch of class', 'a t c']);
  assert.equal(artistsMatch('Unrelated Band', 'ATC', h.search.artistAliases), false);
});
test('missing proof, ambiguous identities, 503, cancellation and deadline skip the identity request', () => {
  for (const options of [{ id: '' }, { ambiguous: true }, { deferred: true }, { cancelled: true },
    { expired: true }, { provider: 'MB' }]) {
    const h = aliasHarness(options); h.load(); assert.equal(h.calls, 0, JSON.stringify(options));
    assert.deepEqual(h.search.artistAliases, []);
  }
});
test('failed or mismatched identity cannot turn another performer into the requested artist', () => {
  for (const options of [{ ok: false }, { response: { ...fixture, id: 'another-id' } },
    { response: { ...fixture, name: 'Other Artist', aliases: [] } },
    { response: { ...fixture, name: 'Various Artists' } },
    { response: { ...fixture, name: 'Other Artist', aliases: [{ name: 'ATC', type: 'Search hint' }] } }]) {
    const h = aliasHarness(options); h.load(); assert.deepEqual(h.search.artistAliases, []);
  }
});
test('aliases are bounded and long artist names do not expand the per-song storage', () => {
  const h = aliasHarness({ response: { ...fixture, aliases: [
    { name: 'x'.repeat(97), type: null }, ...Array.from({ length: 40 }, (_, i) => ({ name: 'Alias ' + i, type: null }))
  ] } });
  h.load(); assert.equal(h.search.artistAliases.length, 8);
  assert.ok(h.search.artistAliases.every(name => name.length <= 96));
});
test('production track matching consults identity only for a matching title and then reuses the proof', () => {
  const h = aliasHarness();
  const fullTitle = 'Around the World (La La La La La) [Radio Version]';
  const titleQuality = (artist, title) => artistsMatch(artist, 'ATC') && title === fullTitle ? 1 : 0;
  const match = new Function('search', 'artworkArtistsMatch', 'titleQuality', 'loadArtistAliases',
    'albumArtTrace', 'artist', 'foundArtist', 'foundTitle',
    strings(block('auto matchQuality =')).replace('&search.artistAliases', 'search.artistAliases'))
    .bind(null, h.search, artistsMatch, titleQuality, h.load, () => {}, 'ATC');
  assert.equal(match('A Touch of Class', 'Another Song'), 0); assert.equal(h.calls, 0);
  assert.equal(match('A Touch of Class', fullTitle), 1); assert.equal(h.calls, 1);
  assert.equal(match('A Touch of Class', fullTitle), 1); assert.equal(h.calls, 1);
  assert.equal(match('Unrelated Band', fullTitle), 0);
  assert.equal(match('ATC Tribute', fullTitle), 0);
});
test('identity proof comes from a matching credit and conflicting IDs disable alias expansion', () => {
  const code = strings(block('auto rememberArtistIdentity =')
    .replace(/\bconst String (\w+) =/g, 'const $1 =')
    .replace(/credit\["artist"\]\["id"\] \| ""/g, '(credit.artist.id || "")')
    .replace(/credit\["artist"\]\["name"\] \| ""/g, '(credit.artist.name || "")')
    .replace(/credit\["name"\] \| ""/g, '(credit.name || "")')
    .replace('search.artistAliases.clear();', 'search.artistAliases.length = 0;'));
  const search = { artistMbid: '', artistIdentityAmbiguous: false, artistAliases: [] };
  const remember = new Function('search', 'artist', 'artworkArtistsMatch', 'isMusicBrainzMbid', 'albumArtTrace', 'credits', code)
    .bind(null, search, 'ATC', artistsMatch, isMusicBrainzMbid, () => {});
  remember([{ name: 'Other Artist', artist: { id: mbid, name: 'Other Artist' } }]);
  assert.equal(search.artistMbid, '');
  remember([{ name: 'ATC', artist: { id: mbid, name: 'ATC' } }]);
  assert.equal(search.artistMbid, mbid);
  remember([{ name: 'ATC', artist: { id: '11111111-2222-3333-4444-555555555555', name: 'ATC' } }]);
  assert.equal(search.artistMbid, ''); assert.equal(search.artistIdentityAmbiguous, true);
  remember([{ name: 'ATC', artist: { id: mbid, name: 'ATC' } }]);
  assert.equal(search.artistMbid, '');
});
test('MusicBrainz JSON filtering retains the same-ID alias evidence without unrelated artist metadata', () => {
  const schema = JSON.parse(jsonHeader.match(/R"json\(([\s\S]*?)\)json"/)[1]);
  assert.equal(schema.id, true); assert.equal(schema.name, true);
  assert.deepEqual(schema.aliases, [{ name: true, type: true }]);
  assert.equal(schema.recordings[0]['artist-credit'], true);
  assert.equal('relations' in schema, false);
});
