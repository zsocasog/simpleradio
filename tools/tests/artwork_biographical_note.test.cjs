const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path');
const m=require('./helpers/artwork_credit_match.cjs'),clean=m.withoutBiographicalNote;
const cpp=fs.readFileSync(path.resolve(__dirname,'../../src/artwork/artwork_cache.cpp'),'utf8');
test('LP biography is removed from lookup only; normal exact recording and artist checks still apply',()=>{
  assert.equal(clean('Lost On You (eredeti neve: Laura Pergolizzi)'),'Lost On You');
  assert.equal(m.exact('LP','Lost on You','Lp',clean('Lost On You (eredeti neve: Laura Pergolizzi)')),true);
  assert.equal(m.exact('Another Artist','Lost on You','Lp',clean('Lost On You (eredeti neve: Laura Pergolizzi)')),false);
  assert.equal(m.exact('LP','Lost on You (Live)','Lp',clean('Lost On You (eredeti neve: Laura Pergolizzi)')),false);
  assert.equal(clean('Song [Real name: Laura Pergolizzi]'),'Song');
  assert.equal(clean('Song (polgári neve: Laura Pergolizzi)'),'Song');
});
test('explicit biographies preserve earlier versions and cannot swallow versions or arbitrary notes',()=>{
  assert.equal(clean('Song (DJ A Remix) (eredeti neve: Laura Pergolizzi)'),'Song (DJ A Remix)');
  assert.equal(clean('Song (Live) (Real name: Laura Pergolizzi)'),'Song (Live)');
  for(const s of ['Song (Fast & Furious 8)','Song (Radio Edit)','Song (eredeti neve:)',
    'Song (eredeti neve: Laura Pergolizzi Remix)','Song (eredeti neve: Part 2)',
    'Song (eredeti neve: Laura Pergolizzi) (Remix)','Song (eredeti neve: Laura Pergolizzi (Live))',
    'Song (eredeti neve: Laura Pergolizzi]','Song (eredeti neve: https://example.com)',
    'Song (Laura Pergolizzi)','Song (name: Laura Pergolizzi)','Song eredeti neve: Laura Pergolizzi'])
    assert.equal(clean(s),s,s);
});
test('all provider lookups use biography-cleaned title after the broadcast year; original metadata/cancellation remain intact',()=>{
  const year=cpp.indexOf('const auto titleView = ArtworkTitleMatch::withoutBroadcastYear');
  const bio=cpp.indexOf('const auto lookupView = ArtworkTitleMatch::withoutBiographicalNote(titleView)');
  const cleanup=cpp.indexOf('const auto cleanedTitle = ArtworkTitleCleanup::normalize(lookupView)');
  const lookup=cpp.indexOf('const String lookupTitle(providerTitle.data(), providerTitle.size())');
  assert.ok(year>=0 && bio>year && cleanup>bio && lookup>cleanup);
  assert.match(cpp,/current.artist != artist \|\| current.title != title/);
  assert.match(cpp,/titleQuery = encodeArtworkQuery\(albumTitleForSearch\(lookupTitle\)\)/);
  assert.match(cpp,/String ownTitle = albumTitleForSearch\(lookupTitle\)/);
});

test('radio annotations are cleaned before every provider query and cleaned matching keeps artist checks',()=>{
  const begin=cpp.indexOf('std::vector<String> ArtworkCache::resolveAlbumArtworkUrls(');
  const resolver=cpp.slice(begin,cpp.indexOf('\nbool ArtworkCache::',begin));
  assert.ok(resolver.indexOf('ArtworkTitleCleanup::normalize(lookupView)')<resolver.indexOf('const String titleQuery'));
  assert.match(resolver,/cleanedTitle\.changed \? cleanedTitle\.view\(\) : lookupView/);
  assert.match(resolver,/exactTrackMatch\(foundArtist, foundTitle, artist, lookupTitle/);
  assert.match(resolver,/current\.title != title/); // Cancellation still tracks original source metadata.
  assert.equal(m.exact('Teddy Swims','The Door (CYRIL Remix)','Teddy Swims','The Door (Cyril remix)'),true);
  assert.equal(m.exact('Teddy Swims','The Door','Teddy Swims','The Door (Cyril remix)'),false);
  assert.equal(m.exact('Other Artist','The Door (CYRIL Remix)','Teddy Swims','The Door (Cyril remix)'),false);
  assert.equal(m.exact('Imanbek & Goodboys','Goodbye','Imanbek & Goodboys','Goodbye'),true);
  assert.equal(m.exact('Imanbek & Goodboys','Goodbye (James Hype Remix)','Imanbek & Goodboys','Goodbye'),false);
});

test('display deduplication leaves Power Intro display metadata and deduplicates before track-change detection',()=>{
  const state=fs.readFileSync(path.resolve(__dirname,'../../src/state/player_state.cpp'),'utf8');
  const setter=state.slice(state.indexOf('void PlayerState::setStreamArtistTitle('),state.indexOf('void PlayerState::setStreamLogoUrl('));
  assert.match(setter,/ArtworkTitleCleanup::normalize\(std::string_view\(nextTitle.c_str\(\), nextTitle.length\(\)\), false\)/);
  assert.ok(setter.indexOf('const auto deduplicated')<setter.indexOf('if (artist == nextArtist && title == nextTitle)'));
});
