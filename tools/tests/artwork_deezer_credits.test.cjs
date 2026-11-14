const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path');
const {artistsMatch,exact}=require('./helpers/artwork_credit_match.cjs');
const cpp=fs.readFileSync(path.resolve(__dirname,'../../src/artwork/artwork_cache.cpp'),'utf8');
function body(marker){const at=cpp.indexOf('{',cpp.indexOf(marker));let depth=0;for(let i=at;i<cpp.length;i++){if(cpp[i]==='{')depth++;if(cpp[i]==='}'&&!--depth)return cpp.slice(at,i+1);}throw Error(marker);}
const field=(obj,keys)=>keys.reduce((x,k)=>x?.[k],obj);
function fieldCode(_all,obj,keys){return `field(${obj},${JSON.stringify([...keys.matchAll(/"([^"]+)"/g)].map(m=>m[1]))})`;}
let code=body('static String verifiedDeezerCredits(')
 .replace(/\b(detail|searchTrack|contributor)((?:\["[^"]+"\])+)\.as<String>\(\)/g,(all,obj,keys)=>`String(${fieldCode(all,obj,keys)} ?? "")`)
 .replace(/\b(detail|searchTrack|contributor)((?:\["[^"]+"\])+)\.as<JsonArray>\(\)/g,(all,obj,keys)=>`(${fieldCode(all,obj,keys)} || [])`)
 .replace(/\b(detail|searchTrack|contributor)((?:\["[^"]+"\])+) \| ""/g,(all,obj,keys)=>`String(${fieldCode(all,obj,keys)} ?? "")`)
 .replace(/const String /g,'const ').replace(/JsonArray /g,'const ').replace(/bool /g,'let ')
 .replace('String main, guests;','let main="",guests="";').replace(/\.length\(\)|\.size\(\)/g,'.length')
 .replace('for (JsonObject contributor : contributors)','for (const contributor of contributors)')
 .replace('String& target =','let target =')
 .replace('target += name;','target += name; if(role === "Main") main=target; else guests=target;')
 .replace(/ArtworkCreditPolicy::MAX_CREDITS/g,'12').replace(/ArtworkCreditPolicy::MAX_CREDIT_BYTES/g,'384');
const verified=new Function('field','isStoreAlbumId','artworkArtistsMatch','exactTrackMatch','detail','searchTrack',code)
 .bind(null,field,x=>/^\d{1,20}$/.test(x)&&x!=='0',artistsMatch,exact);
const fixture=require('./fixtures/artwork-credit-examples.json');
const search=fixture.deezer.search,details=fixture.deezer.detail;
const clone=x=>JSON.parse(JSON.stringify(x));

test('real Henri PFR detail supplies the requested Carston credit under the same IDs',()=>{
  assert.equal(exact('Henri PFR','Make Love','Henri PFR & Carston','Make Love'),false);
  const credits=verified(details,search);assert.equal(credits,'Henri PFR & Carston');
  assert.equal(exact(credits,details.title,'Henri PFR & Carston','Make Love'),true);
});
test('track, album and primary artist identity must all remain bound to the search row',()=>{
  for(const mutate of [x=>x.id++,x=>x.album.id++,x=>x.artist.id++,x=>x.artist.name='Other Artist',
     x=>x.title='Make Love (Remix)',x=>x.title='Make Love (Live)',x=>x.title='Different Song']) {
    const copy=clone(details);mutate(copy);assert.equal(verified(copy,search),'');
  }
});
test('only actual Main/Featured performers can supply a missing requested artist',()=>{
  for(const role of ['Producer','Composer','Remixer','']) {
    const copy=clone(details);copy.contributors[1].role=role;
    assert.equal(exact(verified(copy,search),'Make Love','Henri PFR & Carston','Make Love'),false,role);
  }
  const copy=clone(details);copy.contributors[1].role='Featured';
  assert.equal(verified(copy,search),'Henri PFR feat. Carston');
});
test('missing primary contributor, malformed IDs, excessive names and oversized lists are rejected',()=>{
  for(const mutate of [x=>x.contributors.shift(),x=>x.contributors[0].id++,x=>x.contributors[1].id=0,
    x=>x.contributors[1].name='x'.repeat(97),x=>x.contributors=Array(13).fill(x.contributors[0])]) {
    const copy=clone(details);mutate(copy);assert.equal(verified(copy,search),'');
  }
  const invalid=clone(search);invalid.id=0;assert.equal(verified(details,invalid),'');
});
test('missing or another collaborator cannot become Carston merely because the title matches',()=>{
  const copy=clone(details);copy.contributors[1].name='Different Singer';
  assert.equal(exact(verified(copy,search),'Make Love','Henri PFR & Carston','Make Love'),false);
});
