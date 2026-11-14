const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path');
const {contextual,exact}=require('./helpers/artwork_credit_match.cjs');
const cpp=fs.readFileSync(path.resolve(__dirname,'../../src/artwork/artwork_cache.cpp'),'utf8');
const wantedArtist='Geszti Péter & Lotfi Begi feat. Presser Gábor', wantedTitle="Embertelen Dal '22";
const foundArtist='Geszti & Lotfi Begi', foundTitle="Embertelen dal'22 (feat. Presser Gábor & Káté)";
const fixture=require('./fixtures/artwork-credit-examples.json');

test('supplied Geszti recording reconciles field placement, a recording-only short name and additional explicit feature',()=>{
  assert.equal(exact(foundArtist,foundTitle,wantedArtist,wantedTitle),false);
  const reason={};assert.equal(contextual(foundArtist,foundTitle,wantedArtist,wantedTitle,null,reason),true);
  assert.equal(reason.value,'recording credits verified');
  assert.equal(contextual('Geszti','Another Song','Geszti Péter','Another Song'),false);
  assert.equal(fixture.itunes.track.collectionId,fixture.itunes.album.collectionId);
  assert.equal(contextual(fixture.itunes.track.artistName,fixture.itunes.track.trackName,wantedArtist,wantedTitle),true);
});
test('short artist spelling needs both another exact main artist and a requested guest',()=>{
  for(const [a,t,w] of [
    ['Geszti',"Embertelen dal'22 feat. Presser Gábor",'Geszti Péter feat. Presser Gábor'],
    [foundArtist,"Embertelen dal'22",'Geszti Péter & Lotfi Begi'],
    ['Geszti & Lotfi',foundTitle,wantedArtist],
    ['Geszti Tribute & Lotfi Begi',foundTitle,wantedArtist],
    ['Geszti & Another Producer',foundTitle,wantedArtist],
    [foundArtist,"Embertelen dal'22 feat. Geszti",'Geszti Péter & Lotfi Begi feat. Geszti'],
    [foundArtist,"Embertelen dal'22 feat. Wrong Guest & Káté",wantedArtist]
  ]) assert.equal(contextual(a,t,w,wantedTitle),false,`${a} / ${t}`);
});
test('context cannot erase a different title, year, named remix or live/cover version',()=>{
  for(const t of ["Embertelen dal'23 feat. Presser Gábor & Káté",'Embertelen dal (Live, Budapest Arena 2025)',
     "Embertelen dal'22 (Live) feat. Presser Gábor & Káté", "Embertelen dal'22 (Remix) feat. Presser Gábor & Káté",
     "Embertelen dal'22 (Karaoke) feat. Presser Gábor & Káté", "Another Song feat. Presser Gábor & Káté"])
    assert.equal(contextual(foundArtist,t,wantedArtist,wantedTitle),false,t);
  assert.equal(contextual('Main','Song (DJ B Remix) feat. Guest','Main','Song (DJ A Remix) feat. Guest'),false);
  assert.equal(contextual('Main','Song (DJ A Remix) feat. Guest','Main','Song (DJ A Remix) feat. Guest'),true);
});
test('artist and title fields can distribute all requested credits differently',()=>{
  assert.equal(contextual('Henri PFR','Make Love feat. Carston','Henri PFR & Carston','Make Love'),true);
  assert.equal(contextual('Henri PFR','Make Love','Henri PFR & Carston','Make Love'),false);
  assert.equal(contextual('Main & First Guest','Song feat. Second Guest','Main','Song feat. First Guest & Second Guest'),true);
  assert.equal(contextual('Main','Song feat. First Guest & Extra Guest','Main feat. First Guest','Song'),true);
  assert.equal(contextual('Main & Wrong Artist','Song feat. First Guest','Main feat. First Guest','Song'),false);
});
test('explicit conflicting title guests never gain a wildcard from an artist-field credit',()=>{
  assert.equal(contextual('Ofenbach & Nick Waterhouse','Katchi feat. Another Guest','Ofenbach','Katchi feat. Nick Waterhouse'),false);
  assert.equal(contextual('Ofenbach & Another Guest','Katchi','Ofenbach','Katchi feat. Nick Waterhouse'),false);
  assert.equal(contextual('Ofenbach','Katchi feat. Nick Waterhouse & Additional Guest','Ofenbach','Katchi feat. Nick Waterhouse'),true);
});
test('ambiguous guest/version words and malformed or oversized inputs remain conservative',()=>{
  assert.equal(contextual('Main','Song feat. Little Mix Remix','Main','Song feat. Little Mix'),false);
  assert.equal(contextual('Main & Little Mix','Song','Main','Song feat. Little Mix'),true);
  assert.equal(contextual(foundArtist,foundTitle,'x'.repeat(385),wantedTitle),false);
  assert.equal(contextual('Main','Song (feat. Guest','Main','Song feat. Guest'),false);
});
function block(marker){const at=cpp.indexOf('{',cpp.indexOf(marker));let depth=0;for(let i=at;i<cpp.length;i++){if(cpp[i]==='{')depth++;if(cpp[i]==='}'&&!--depth)return cpp.slice(at,i+1);}throw Error(marker);}
test('contextual candidates require verified own albums or singles, never unverified or collection fallbacks',()=>{
  const code=block('static bool artworkMatchAllowsRelease(').replace(/AlbumArtworkKind::/g,'kindEnum.');
  const kindEnum=Object.fromEntries(['Album','Single','ArtistCollection','Unverified','Compilation'].map(x=>[x,x]));
  const allows=new Function('kindEnum','artworkMatchNeedsVerifiedAlbum','quality','kind',code).bind(null,kindEnum,q=>q<=2);
  for(const [kind,expected] of Object.entries({Album:true,Single:true,ArtistCollection:false,Unverified:false,Compilation:false}))
    assert.equal(allows(-1,kind),expected,kind);
  assert.equal(allows(4,'Unverified'),true);assert.equal(allows(2,'Single'),false);
});
test('normal matching returns before the new work; no new provider or larger deadline is introduced',()=>{
  const code=block('auto matchCandidate =');
  assert.ok(code.indexOf('if (quality) return quality')<code.indexOf('contextualCreditTrackMatch('));
  const fast=new Function('matchQuality','contextualCreditTrackMatch','foundArtist','foundTitle','artist','lookupTitle','search','rejectionReason',
    code.replace('const int quality','const quality').replace('&search.artistAliases','search.artistAliases').replace('&rejectionReason','rejectionReason'));
  let strictCalls=0;
  for(let i=0;i<1000;i++) assert.equal(fast(()=>{strictCalls++;return 4;},()=>{throw Error('extra matching on a fast success');},'Artist','Song','Artist','Song',{},{}),4);
  assert.equal(strictCalls,1000);
  assert.match(cpp,/deadlineRemaining\(requestDeadlineMs\) > 1500 && !cancelled\(\)/);
  assert.match(cpp,/!quality && incompleteTrack.isNull\(\)/);
  assert.match(cpp,/albums.empty\(\) && !incompleteTrack.isNull\(\)/);
  const fastScan=cpp.indexOf('for (JsonObject track : tracks)');
  const detailLookup=cpp.indexOf('"https://api.deezer.com/track/"');
  assert.ok(detailLookup>cpp.indexOf('albums.push_back',fastScan));
  assert.equal((cpp.match(/"https:\/\/api.deezer.com\/track\/"/g)||[]).length,1);
  assert.match(cpp,/detail,\s*deadlineMs, cancelled, nullptr, requestDeadlineMs/);
});
