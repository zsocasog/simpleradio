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
  const lookup=cpp.indexOf('const String lookupTitle(lookupView.data(), lookupView.size())');
  assert.ok(year>=0 && bio>year && lookup>bio);
  assert.match(cpp,/current.artist != artist \|\| current.title != title/);
  assert.match(cpp,/titleQuery = encodeArtworkQuery\(albumTitleForSearch\(lookupTitle\)\)/);
  assert.match(cpp,/String ownTitle = albumTitleForSearch\(lookupTitle\)/);
});
