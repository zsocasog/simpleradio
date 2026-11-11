const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), test = require('node:test');
const root=path.resolve(__dirname,'../..');
const source = fs.readFileSync(path.join(root, 'src/web/station_artwork_response.h'), 'utf8');
function body(marker, text=source) {
  const start=text.indexOf('{',text.indexOf(marker));let depth=0;
  for(let i=start;i<text.length;i++) {
    if(text[i]==='{')++depth;
    if(text[i]==='}'&&!--depth)return text.slice(start,i+1);
  }
  throw Error(marker);
}
function translate(code) {
  return code.replace(/const (?:auto|uint32_t) /g,'const ').replace(/Artwork(Etag|Revision)::/g,'Artwork$1.')
    .replace(/\b(valid_|file_|pathId_|revisionAtOpen_|_code|_contentLength|_sendContentLength)\b/g,'this.$1');
}
function harness() {
  const revision={generation:1,boot:123,busy:false,value(){return this.busy?0:this.generation;},session(){return this.boot;}};
  const etag={value:(boot,gen,path,size)=>({data:()=>JSON.stringify([boot,gen,path,size])})};
  const Response = new Function('ArtworkEtag','ArtworkRevision',`return class {
    valid_=true;_code=200;_sendContentLength=true;pathId_=42;
    constructor(file){this.revisionAtOpen_=ArtworkRevision.value();this.file_=file;this._contentLength=file.size()+58;}
    tag() ${translate(body('String entityTag('))}
    notModified() ${translate(body('void notModified('))}
  }`)(etag,revision);
  let closed=false;
  const file={size:()=>61960,close:()=>{closed=true;},
    read(){throw Error('validator must not read image pixels on AsyncTCP');},
    seek(){throw Error('validator must not seek image pixels on AsyncTCP');}};
  return {revision,file,r:new Response(file),fresh:()=>new Response(file),closed:()=>closed};
}
test('validator is stable and needs no pixel reads, image buffer or timestamp',()=>{
  const h=harness(),{r,revision}=h;const original=r.tag();assert.equal(r.tag(),original);
  revision.busy=true;assert.equal(r.tag(),'');assert.equal(h.fresh().tag(),'');
  revision.generation++;revision.busy=false;
  assert.equal(r.tag(),'','an already opened old descriptor cannot claim the new revision');
  assert.notEqual(h.fresh().tag(),original,'same path, dimensions and second invalidate on commit');
  const changed=h.fresh().tag();revision.boot++;assert.notEqual(h.fresh().tag(),changed,'reboot/data OTA cannot reuse old validators');
  const fresh=h.fresh(),boot=fresh.tag();fresh.pathId_++;assert.notEqual(fresh.tag(),boot,'reassigning another cached source invalidates');
  r.valid_=false;assert.equal(r.tag(),'');
});
test('304 closes the descriptor immediately, preserves source validity and omits body length',()=>{
  const h=harness();h.r.notModified();
  assert.equal(h.closed(),true);assert.equal(h.r.valid_,true);assert.equal(h.r._code,304);
  assert.equal(h.r._contentLength,0);assert.equal(h.r._sendContentLength,false);
});
test('actual thumbnail commits, upload invalidation and boot initialize the revision',()=>{
  const cache=fs.readFileSync(path.join(root,'src/artwork/artwork_cache.cpp'),'utf8');
  const commit=body('bool ArtworkCache::ensureLcdThumbnailPrepared(',cache);
  const rename=commit.indexOf('if (!LittleFS.rename(tempPath, thumbPath))');
  assert.ok(rename>=0);
  const publication=commit.indexOf('ArtworkRevision::Publication publication;');
  assert.ok(publication>=0&&publication<rename);
  assert.match(source,/revisionAtOpen_\(ArtworkRevision::value\(\)\), file_\(mount, path\)/);
  assert.match(body('void ArtworkCache::invalidateLcdThumbnail(',cache),/ArtworkRevision::changed\(\);/);
  const web=fs.readFileSync(path.join(root,'src/web/web_server.cpp'),'utf8');
  assert.match(body('static bool commitLogoUpload(',web),/invalidateLcdThumbnail\(targetPath\)/);
  const begin=body('void webServerBegin(',web);
  assert.ok(begin.indexOf('ArtworkRevision::beginHttpSession()')<begin.indexOf('server.begin()'));
});

test('nested publication and cancellation cannot expose an intermediate revision',()=>{
  const revisionSource=fs.readFileSync(path.join(root,'src/artwork/artwork_revision.cpp'),'utf8');
  const atomic=n=>({n,load(){return this.n;},fetch_add(v){this.n+=v;},fetch_sub(v){this.n-=v;}});
  const generation=atomic(1),publishers=atomic(0);
  const make=marker=>new Function('generation','publishers',body(marker,revisionSource).replace('const uint32_t ','const ')).bind(null,generation,publishers);
  const value=make('uint32_t value('),begin=make('Publication::Publication('),end=make('Publication::~Publication(');
  assert.equal(value(),1);begin();assert.equal(value(),0);begin();assert.equal(value(),0);
  end();assert.equal(value(),0);end();assert.equal(value(),3);assert.equal(publishers.n,0);
});
