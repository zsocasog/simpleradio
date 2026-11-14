const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path');
const m=require('./helpers/artwork_credit_match.cjs');
const cpp=fs.readFileSync(path.resolve(__dirname,'../../src/artwork/artwork_cache.cpp'),'utf8');
const artist='MOBY feat. Jennifer Price',title='In this world';
const fixture=require('./fixtures/artwork-confirmed-guest-example.json');
test('real Apple Moby recording and its own album stay linked to the confirmed credit',()=>{
  assert.equal(m.confirmedGuest(fixture.track.artistName,fixture.track.trackName,fixture.wantedArtist,fixture.wantedTitle),true);
  assert.equal(fixture.track.collectionId,fixture.album.collectionId);
  assert.equal(fixture.album.artistName,'Moby');
  assert.equal(fixture.album.collectionName,'18 & 18 B-Sides');
  assert.equal(m.artistsMatch(fixture.track.artistName,fixture.album.artistName),true);
});
test('the logged exact Last.fm credit proves the requested guest, without relaxing global artist matching',()=>{
  assert.equal(m.exact('Moby feat. Jennifer Price','In This World',artist,title),true);
  assert.equal(m.exact('Moby','In This World',artist,title),false);
  assert.equal(m.contextual('Moby','In This World',artist,title),false);
  assert.equal(m.confirmedPrimary(artist,false),artist);
  assert.equal(m.confirmedPrimary(artist,true),'MOBY');
  assert.equal(m.confirmedGuest('Moby','In This World',artist,title),true);
  assert.equal(m.exact('Moby feat. Someone Else','In This World',artist,title),false);
});
test('confirmed credits never override conflicting guests, added main artists or different versions',()=>{
  for(const [a,t] of [['Moby feat. Someone Else','In This World'],['Moby & Someone Else','In This World'],
    ['Another Artist','In This World'],['Moby','In This World feat. Someone Else'],
    ['Moby','In This World (Boris Brejcha Remix)'],['Moby','In This World (Live)'],
    ['Moby','In This World (Acoustic)'],['Moby','In This Word'],['Moby','In This World (Part 2)']])
    assert.equal(m.confirmedGuest(a,t,artist,title),false,`${a} / ${t}`);
  assert.equal(m.confirmedGuest('Moby','In This World',artist,'In This World feat. Another Guest'),false);
});
test('query reduction needs explicit, unambiguous feature syntax and a per-song confirmation',()=>{
  for(const a of ['Moby & Jennifer Price','Moby with Jennifer Price','Moby feat. Jennifer Price (Remix)',
    'Moby feat. Jennifer Price Remix','Moby feat.','Moby (feat. Jennifer Price','x'.repeat(385)])
    assert.equal(m.confirmedPrimary(a,true),a,a);
  assert.equal(m.confirmedPrimary('Main ft. Guest',true),'Main');
  assert.equal(m.confirmedPrimary('Main featuring Guest',true),'Main');
});
function block(marker){const start=cpp.indexOf('{',cpp.indexOf(marker));let depth=0;for(let i=start;i<cpp.length;i++){if(cpp[i]==='{')depth++;if(cpp[i]==='}'&&!--depth)return cpp.slice(start,i+1);}throw Error(marker);}
test('production quality selection consumes proof before alias requests, retains the old fast path and fails closed without proof',()=>{
  const source=block('auto matchQuality =');
  const branch=source.slice(0,source.indexOf('// Test the title independently'))+'return 0;}';
  const code=branch.replace('const int strictQuality','const strictQuality');
  const run=new Function('titleQuality','search','confirmedGuestTrackMatch','foundArtist','foundTitle','artist','lookupTitle',code);
  assert.equal(run(()=>0,{lastFmConfirmedRecordingCredits:true},m.confirmedGuest,'Moby','In This World',artist,title),-1);
  assert.equal(run(()=>0,{lastFmConfirmedRecordingCredits:false},()=>{throw Error('unconfirmed proof used');},'Moby','In This World',artist,title),0);
  assert.equal(run(()=>4,{lastFmConfirmedRecordingCredits:true},()=>{throw Error('normal success did extra work');},'Moby','In This World','Moby',title),4);
  assert.ok(source.indexOf('confirmedGuestTrackMatch')<source.indexOf('loadArtistAliases()'));
  const lastfm=cpp.slice(cpp.indexOf('if (provider == AlbumArtworkProvider::LastFm &&'),cpp.indexOf('if (provider == AlbumArtworkProvider::Deezer)'));
  assert.match(lastfm,/quality == 4 && confirmedPrimaryArtist\(artist, true\) != artist &&\s*exactTrackMatch\(foundArtist, foundTitle, artist, lookupTitle\)/);
  assert.match(cpp,/artistQuery = encodeArtworkQuery\(confirmedPrimaryArtist\(artist, search.lastFmConfirmedRecordingCredits\)\)/);
  const header=fs.readFileSync(path.resolve(__dirname,'../../src/artwork/artwork_cache.h'),'utf8');
  assert.match(header,/bool lastFmConfirmedRecordingCredits = false;/);
  assert.equal((cpp.match(/lastFmConfirmedRecordingCredits = true/g)||[]).length,1);
});
