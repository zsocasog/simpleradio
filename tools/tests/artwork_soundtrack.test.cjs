const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path');
const m=require('./helpers/artwork_credit_match.cjs');
const policy=require('./helpers/artwork_soundtrack_policy.cjs');
const fixture=require('./fixtures/artwork-soundtrack-example.json');
const cpp=fs.readFileSync(path.resolve(__dirname,'../../src/artwork/artwork_cache.cpp'),'utf8');
const artist=fixture.wantedArtist,title=fixture.wantedTitle;

test('real Good Life rows are eligible only with matching artists, exact main title and related release',()=>{
  for(const row of fixture.search){
    assert.equal(m.exact(row.artistName,row.trackName,artist,title),false);
    assert.equal(m.subtitle(row.artistName,row.trackName,artist,title),false);
    assert.equal(m.soundtrack(row.artistName,row.trackName,artist,title,row.collectionName),true);
    const album=fixture.albums.find(x=>x.collectionId===row.collectionId);
    assert.equal(m.soundtrackRelease(title,album.collectionName,album.primaryGenreName,true),true);
    assert.equal(m.soundtrackRelease(title,album.collectionName,row.primaryGenreName,true),false);
  }
});
test('related film context is not permission for a different artist, title, guest or recording version',()=>{
  for(const [a,t] of [['OneRepublic','Good Life'],['G-Eazy','Good Life'],[artist,'Another Life'],
    [artist,'Good Lief'],[artist,'Good Life (Live)'],[artist,'Good Life (DJ A Remix)'],
    [artist,'Good Life (Acoustic)'],[artist,'Good Life feat. Another Guest'],[artist,'Good Life (Part 2)']])
    assert.equal(m.soundtrack(a,t,artist,title,fixture.search[0].collectionName),false,`${a} / ${t}`);
  assert.equal(m.soundtrack(artist,'Good Life',artist,'Good Life feat. Another Guest (Fast & Furious 8)',fixture.search[0].collectionName),false);
});
test('nested, multiple, unbalanced, unbracketed and version annotations cannot be erased',()=>{
  for(const t of ['Good Life (Fast & Furious 8) (Live)','Good Life (Fast & Furious 8 Live)',
    'Good Life (Fast & Furious 8 Remix)','Good Life (Fast & Furious 8) [2017]',
    'Good Life (Fast & Furious (8))','Good Life (Fast & Furious 8','Good Life (Fast & Furious 8]',
    'Good Life Fast & Furious 8','Good Life (Part 2)','Good Life (Fast & Furious 8) feat. Another Guest'])
    assert.equal(m.soundtrack(artist,'Good Life',artist,t,fixture.search[0].collectionName),false,t);
  assert.equal(m.soundtrack(artist,'Good Life (Radio Edit)',artist,title,fixture.search[0].collectionName),true);
});
test('unrelated releases and contradictory numbers remain rejected; no film-specific exception table',()=>{
  for(const album of ['Top Dance Hits','Fast & Furious 7: The Album','Various Artists','The Album',''])
    assert.equal(m.soundtrack(artist,'Good Life',artist,title,album),false,album);
  assert.equal(policy.relatedRelease('from iron man 2','iron man 2 original motion picture soundtrack'),true);
  assert.equal(policy.relatedRelease('from iron man 2','iron man 3 original motion picture soundtrack'),false);
  assert.equal(policy.relatedRelease('2017','2017 soundtrack'),false);
  assert.equal(policy.relatedRelease('fast furious','furious planet ocean summer winter'),false);
  assert.equal(policy.relatedRelease('summer summer summer','summer soundtrack'),false);
  assert.equal(policy.relatedRelease('fast furious 8 9','fast furious 8 9'),false);
  assert.equal(policy.relatedRelease('x'.repeat(193),'titanic'),false);
  assert.equal(m.soundtrack(artist,'Good Life',artist,'x'.repeat(385),fixture.search[0].collectionName),false);
});
function block(marker){const start=cpp.indexOf('{',cpp.indexOf(marker));let depth=0;for(let i=start;i<cpp.length;i++){if(cpp[i]==='{')depth++;if(cpp[i]==='}'&&!--depth)return cpp.slice(start,i+1);}throw Error(marker);}
const kinds=Object.fromEntries(['Album','Single','ArtistCollection','Unverified','Compilation','Soundtrack'].map(k=>[k,k]));
const allows=new Function('AlbumArtworkKind','artworkMatchNeedsVerifiedAlbum','quality','kind',block('static bool artworkMatchAllowsRelease(').replace(/AlbumArtworkKind::/g,'AlbumArtworkKind.')).bind(null,kinds,q=>q<=2);
test('only the verified soundtrack release kind can finish a movie-context match',()=>{
  for(const k of Object.keys(kinds)) assert.equal(allows(-2,k),k==='Soundtrack',k);
  assert.equal(allows(-1,'Soundtrack'),false);
  assert.equal(allows(1,'Compilation'),false);
  assert.equal(allows(1,'Single'),false);
  assert.equal(allows(4,'Compilation'),true);
  const verification=block('for (JsonObject result : lookupResults)');
  assert.ok(verification.indexOf('collectionId')<verification.indexOf('soundtrackReleaseMatches'));
  assert.match(verification,/soundtrackReleaseMatches\(lookupTitle, albumTitle, genre, true\)/);
});
test('production collection verification binds the same ID and requires release relationship AND soundtrack metadata',()=>{
  const code=block('for (JsonObject result : lookupResults)')
    .replace(/result\["(\w+)"\]\.as<String>\(\)/g,'String(result["$1"] ?? "")')
    .replace(/result\["(\w+)"\] \| ""/g,'(result["$1"] ?? "")')
    .replace('result["collectionName"] | album.title','(result["collectionName"] ?? album.title)')
    .replace('result["trackCount"] | 0','(result["trackCount"] ?? 0)')
    .replace('&search.artistAliases','search.artistAliases')
    .replace(/const (?:String|int|bool) /g,'const ').replace(/\.c_str\(\)/g,'').replace(/\.length\(\)/g,'.length')
    .replace(/ArtworkReleaseRank::collectionMetadata/g,'collectionMetadata').replace(/AlbumArtworkKind::/g,'kinds.');
  const verify=new Function('album','lookupResults','soundtrackReleaseMatches','lookupTitle','kinds',
    'const search={artistAliases:[]},collectionMetadata=()=>false,albumArtworkKind=()=>kinds.Compilation,albumArtTrace=()=>{}; for(const result of lookupResults) '+code+';return album;');
  const pending=()=>({id:String(fixture.search[0].collectionId),quality:-2,kind:'Unverified',title:fixture.search[0].collectionName,trackArtist:artist});
  assert.equal(verify(pending(),fixture.albums,m.soundtrackRelease,title,kinds).kind,'Soundtrack');
  for(const rows of [[],[{...fixture.albums[0],collectionId:123}],
    [{...fixture.albums[0],primaryGenreName:'Pop'}],
    [{...fixture.albums[0],collectionName:'Fast & Furious 7: The Album'}],
    [{...fixture.albums[0],collectionName:'Top Dance Hits'}]])
    assert.notEqual(verify(pending(),rows,m.soundtrackRelease,title,kinds).kind,'Soundtrack');
});
test('real provider rows run through the production pending-candidate block; ordinary successes skip it',()=>{
  const marker='if (albums.empty() && urls.empty())';
  const code=block(marker)
    .replace(/for \(JsonObject result : results\)/g,'for (const result of results)')
    .replace(/for \(const StoreArtworkAlbum& existing : albums\)/g,'for (const existing of albums)')
    .replace(/const String /g,'const ').replace(/String cover/g,'let cover').replace(/bool duplicate/g,'let duplicate')
    .replace(/result\["(\w+)"\]\.as<String>\(\)/g,'String(result["$1"] ?? "")')
    .replace(/result\["(\w+)"\] \| ""/g,'(result["$1"] ?? "")')
    .replace(/\.size\(\)|\.length\(\)/g,'.length').replace('&search.artistAliases','search.artistAliases')
    .replace('cover.replace("100x100bb", "250x250bb");','cover=cover.replace("100x100bb", "250x250bb");')
    .replace(/albums.push_back\(\{id, albumTitle, cover, foundArtist, -2, ([^}]+)\}\);/,'albums.push({id,title:albumTitle,cover,trackArtist:foundArtist,quality:-2,releaseDate:$1});')
    .replace(/\.c_str\(\)/g,'');
  const select=new Function('albums','urls','results','soundtrackTrackMatch','artist','lookupTitle',
    'const search={artistAliases:[]},cancelled=()=>false,deadlineReached=()=>false,deadlineMs=0,albumArtTrace=()=>{},isStoreAlbumId=id=>/^[1-9][0-9]{0,19}$/.test(id); if(!albums.length&&!urls.length) '+code+'; return albums;');
  const selected=select([],[],fixture.search,m.soundtrack,artist,title);
  assert.deepEqual(selected.map(x=>x.id),fixture.search.map(x=>String(x.collectionId)));
  for(const row of selected){assert.equal(row.quality,-2);assert.match(row.cover,/250x250bb/);}
  let calls=0;select([{id:'existing'}],[],fixture.search,()=>{calls++;return true;},artist,title);
  select([],['existing.jpg'],fixture.search,()=>{calls++;return true;},artist,title);
  assert.equal(calls,0);
  const itunes=cpp.slice(cpp.indexOf('if (provider == AlbumArtworkProvider::ITunes)'));
  const pending=itunes.slice(itunes.indexOf(marker),itunes.indexOf('doc.clear();',itunes.indexOf(marker)));
  assert.doesNotMatch(pending,/fetchArtworkJson|loadArtistAliases|https?:/);
  assert.equal((itunes.match(/https:\/\/itunes.apple.com\/lookup\?id=/g)||[]).length,1);
});
