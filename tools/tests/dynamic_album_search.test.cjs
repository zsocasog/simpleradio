const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { withoutFeatureCredit } = require('./helpers/artwork_title_policy.cjs');
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
const roundSource = policy.slice(policy.indexOf('class MusicBrainzRound'));
const roundBody = roundSource.slice(roundSource.indexOf('public:') + 7, roundSource.indexOf('private:'))
  .replace(/constexpr bool (\w+)\(\) const/g, '$1()')
  .replace(/constexpr (?:bool|void) (\w+)\(\)/g, '$1()')
  .replace(/\b(deferred_|retrying_|retryConsumed_)\b/g, 'this.$1');
const Round = new Function(`return class { deferred_=false; retrying_=false; retryConsumed_=false; ${roundBody} }`)();
const fetchBody = block(cpp, 'auto fetchMusicBrainz =')
  .replace('int status = 0;', 'let status = 0;')
  .replace('const bool ok = fetchArtworkJson(url, target ? *target : doc, deadlineMs, cancelled, &status, requestDeadlineMs);',
    'const ok = fetchApi(url, value => status = value);');
const fetchMb = new Function('search', 'waitForMusicBrainz', 'fetchApi', 'albumArtTrace', 'url', 'target = null', fetchBody);
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

const budgetClass = policy.slice(policy.indexOf('class Budget'), policy.indexOf('// One song'));
const budgetBody = budgetClass.slice(budgetClass.indexOf('public:') + 7, budgetClass.indexOf('private:'))
  .replace('constexpr explicit Budget(uint32_t started) : started_(started) {}', 'constructor(started) { this.started_=started; }')
  .replace(/constexpr (?:uint32_t|bool) (\w+)\(uint32_t now\) const/g, '$1(now)')
  .replace(/const uint32_t /g, 'const ').replace(/metadataRemaining\(/g, 'metadataRemaining(')
  .replace(/return remaining\(/g, 'return this.remaining(')
  .replace(/= metadataRemaining\(/g, '= this.metadataRemaining(')
  .replace(/return now \+ metadataRemaining\(/g, 'return now + this.metadataRemaining(')
  .replace(/return metadataRemaining\(/g, 'return this.metadataRemaining(');
const Budget = new Function('LOOKUP_BUDGET_MS','IMAGE_BUDGET_MS','PROVIDER_BUDGET_MS','MIN_PROVIDER_BUDGET_MS',`return class { ${budgetBody} remaining(now,limit) { const elapsed=(now-this.started_)>>>0; return elapsed>=limit?0:limit-elapsed; } }`)(35000,12000,12000,3000);
const searchBody = block(cpp, 'bool ArtworkCache::resolveAndDownloadAlbumArtwork(')
  .replace('const AlbumSearchPolicy::Budget budget(searchStartedMs);', 'const budget = new Budget(searchStartedMs);')
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
function runSearch({ initial503 = true, retryCover = false, earlyCover = false, single = false, cancel = false, elapsed = 0, providerAction, captureBudgets = false } = {}) {
  const calls = [], downloads = [], imageBudgets = [];
  let now = 0, title = { c_str: () => 'song' };
  const image = name => ({ name, c_str: () => name });
  const context = {
    Round, Budget, Provider: { MusicBrainz:'MB', LastFm:'Last.fm', ITunes:'iTunes', Deezer:'Deezer' },
    millis: () => now, ALBUM_ART_LOOKUP_BUDGET_MS:35000, ALBUM_ART_IMAGE_BUDGET_MS:12000,
    artist: { c_str: () => 'artist' }, title, key:'key', outPath:{ c_str: () => 'ready' }, albumArtTrace() {},
    player: { snapshot: () => ({ playing:true, artist:context.artist, title }) },
    idlePrewarmCancellationRequested: () => false, lastDownloadStatus: () => ({ c_str: () => '' }),
    download: (candidate, _path, budget) => { downloads.push(candidate.name); imageBudgets.push(budget); return true; },
    resolveAlbumArtworkUrls: (_a, _t, provider, _deadline, fallbacks, search) => {
      calls.push(provider + (search.musicBrainz.retrying() ? '-retry' : ''));
      if (providerAction) return providerAction({provider, deadline:_deadline, now, advance:ms=>now+=ms, image, fallbacks});
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
  const result = run(...Object.values(context));
  return { result, calls, downloads, ...(captureBudgets ? { imageBudgets, elapsed:now } : {}) };
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

test('a slow first provider leaves another source and the FULL 12-second image window', () => {
  const result = runSearch({ captureBudgets:true, providerAction:({provider,deadline,now,advance,image}) => {
    assert.ok(deadline <= 23000);
    if (provider === 'MB') { assert.equal(deadline,23000); advance(12000); return []; }
    if (provider === 'Last.fm') { advance(5000); return []; }
    assert.equal(provider,'iTunes'); assert.equal(deadline,23000);
    advance(6000); return [image('own-album')];
  }});
  assert.equal(result.result,true); assert.deepEqual(result.downloads,['own-album']);
  assert.deepEqual(result.imageBudgets,[12000]); assert.equal(result.elapsed,23000);
});
test('a provider that reaches its local deadline can still return an already verified candidate', () => {
  const result=runSearch({captureBudgets:true,providerAction:({deadline,now,advance,image})=>{
    advance(deadline-now); return [image('verified-before-deadline')];
  }});
  assert.equal(result.result,true); assert.deepEqual(result.calls,['MB']);
  assert.deepEqual(result.imageBudgets,[12000]);
});
test('metadata exhaustion skips remaining providers even without a stored fallback', () => {
  const result=runSearch({captureBudgets:true,providerAction:({deadline,now,advance})=>{
    advance(Math.min(deadline-now,12000)); return [];
  }});
  assert.equal(result.result,false); assert.deepEqual(result.calls,['MB','Last.fm']);
  assert.equal(result.elapsed,23000); assert.deepEqual(result.downloads,[]);
});

test('the logged 11.5s MusicBrainz response still reaches its own album at recording 12', () => {
  const fixture=JSON.parse(read('tools/tests/fixtures/artwork-rob-n-raz.json'));
  let examined=0;
  const result=runSearch({captureBudgets:true,providerAction:({provider,deadline,now,advance,image})=>{
    assert.equal(provider,'MB');
    let clock=now+11500;advance(11500);const covers=[];
    for(const recording of fixture.recordings){
      if(clock>=deadline)break;
      ++examined;clock+=300;advance(300);
      if(recording.score<80)continue;
      for(const album of recording.albums) if(album.title==='Circus') covers.push(image(album.title));
    }
    return covers;
  }});
  assert.equal(examined,16);assert.equal(result.result,true);
  assert.deepEqual(result.downloads,['Circus']);assert.deepEqual(result.calls,['MB']);
  assert.deepEqual(result.imageBudgets,[12000]);
});
test('too little time for a new provider goes directly to the known fallback', () => {
  const result=runSearch({captureBudgets:true,providerAction:({provider,advance,fallbacks,image})=>{
    if(provider==='MB'){advance(12000);return [];}
    assert.equal(provider,'Last.fm');advance(9500);fallbacks.unverified.push(image('known-cover'));return [];
  }});
  assert.equal(result.result,true);assert.deepEqual(result.calls,['MB','Last.fm']);
  assert.deepEqual(result.downloads,['known-cover']);assert.deepEqual(result.imageBudgets,[12000]);
});

const {subtitle: structuredSubtitle} = require('./helpers/artwork_credit_match.cjs');
function subtitleMatch(foundArtist, foundTitle, wantedArtist='Shinedown', wantedTitle='Diamond Eyes') {
  return structuredSubtitle(foundArtist,foundTitle,wantedArtist,wantedTitle);
}

test('production title matching accepts Shinedown subtitle spelling and punctuation variants', () => {
  for (const title of ['Diamond Eyes (Boom-Lay Boom-Lay Boom)', 'Diamond Eyes (Boom‐Lay Boom‐Lay Boom)', 'Diamond Eyes (Boom-Lay...)']) {
    assert.equal(subtitleMatch('Shinedown', title), true, title);
  }
});
test('a standard store version after an optional subtitle is accepted only as a weak title match', () => {
  const match = title => subtitleMatch('ATC', title, 'ATC', 'Around the World');
  assert.equal(match('Around the World (La La La La La) [Radio Version]'), true);
  assert.equal(match('Around the World (La La La La La) (Radio Edit)'), true);
  for (const title of ['Around the World (La La La La La) [Live] [Radio Version]',
    'Around the World (La La Remix) [Radio Version]', 'Around the World (La La) [Extended Version]',
    'Around the World (La La) [Karaoke Version]', 'Around the World Part II [Radio Version]']) {
    assert.equal(match(title), false, title);
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
