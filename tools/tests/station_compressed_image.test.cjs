const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),test=require('node:test');
const read=p=>fs.readFileSync(path.resolve(__dirname,'../..',p),'utf8');
const policy=read('src/artwork/web_image.h'),source=read('src/web/station_web_image_response.h');
function body(s,marker){const begin=s.indexOf('{',s.indexOf(marker));let n=0;for(let i=begin;i<s.length;i++){if(s[i]==='{')n++;if(s[i]==='}'&&!--n)return s.slice(begin,i+1);}throw Error(marker);}
const inspectCode=body(policy,'Format inspect(').replace('!file ||','!file.valid() ||')
 .replace(/uint8_t (header|tail)\[8\]\{\};/g,'const $1=new Uint8Array(8);')
 .replace('const uint8_t png[8] = {137, 80, 78, 71, 13, 10, 26, 10};','const png=[137,80,78,71,13,10,26,10];')
 .replace(/sizeof\((header|tail|png)\)/g,'8').replace('bool isPng','let isPng').replace('size_t i','let i')
 .replace(/Format::(\w+)/g,'"$1"').replace(/'([IEND])'/g,(_,c)=>c.charCodeAt(0));
const inspect=new Function('file','MaxBytes',inspectCode);
function png(size=80){const b=Buffer.alloc(size,31);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.write('IEND',size-8);return b;}
function jpeg(size=90){const b=Buffer.alloc(size,55);b[0]=255;b[1]=216;b[size-2]=255;b[size-1]=217;return b;}
function file(data,{available=true,limit=Infinity}={}){let pos=0,closed=false,reads=0;return {valid:()=>available&&!closed,size:()=>data.length,
 seek(n){if(!this.valid()||n>data.length)return false;pos=n;return true;},read(out,n){reads++;if(!this.valid())return 0;const count=Math.min(n,limit,data.length-pos);out.set(data.subarray(pos,pos+count));pos+=count;return count;},
 close(){closed=true;},closed:()=>closed,reads:()=>reads};}
function harness(bytes,options){const f=file(bytes,options),revision={value:1,busy:false};
 const translate=c=>c.replace(/SR_PERF_SPAN\([^;]+;/g,'').replace(/const (?:auto|uint32_t|size_t) /g,'const ')
  .replace(/WebArtwork::/g,'WebArtwork.').replace(/ArtworkRevision::/g,'ArtworkRevision.').replace(/ArtworkEtag::/g,'ArtworkEtag.')
  .replace(/::/g,'.')
  .replace(/\b(file_|valid_|revisionAtOpen_|pathId_|offset_|_code|_contentType|_contentLength|_sendContentLength)\b/g,'this.$1');
 const Response=new Function('file','WebArtwork','ArtworkRevision','ArtworkEtag',`return class {
 valid_=false;offset_=0;revisionAtOpen_=1;pathId_=42;
 constructor(){this.file_=file;${translate(body(source,'StationWebImageResponse(const char*'))}}
 valid()${translate(body(source,'bool _sourceValid('))}
 fill(buffer,maxLen)${translate(body(source,'size_t _fillBuffer('))}
 tag()${translate(body(source,'String entityTag('))}
 notModified()${translate(body(source,'void notModified('))}
 dispose(){this.file_.close();}
 }`)(f,{inspect:f=>inspect(f,32768),Format:{None:'None',Png:'Png',Jpeg:'Jpeg'}},
 {value:()=>revision.busy?0:revision.value,session:()=>123},{value:(...args)=>({data:()=>JSON.stringify(args)})});
 return {f,r:new Response(),revision};}
test('small PNG/JPEG are streamed byte-for-byte with bounded fragments and descriptors close at EOF',()=>{
 for(const data of [png(),jpeg(),png(32768)])for(const chunk of [1,3,64,4096,40000]){
  const {f,r}=harness(data);assert.equal(r.valid(),true);assert.equal(r._contentLength,data.length);
  assert.equal(r._contentType,data[1]===80?'image/png':'image/jpeg');
  const parts=[];while(!f.closed()){const b=Buffer.alloc(chunk),n=r.fill(b,chunk);assert.ok(n>0);parts.push(b.subarray(0,n));}
  assert.deepEqual(Buffer.concat(parts),data);assert.equal(r.valid(),true);assert.equal(r.fill(Buffer.alloc(5),5),0);
 }
});
test('oversized, missing, truncated and mislabeled payloads are rejected for LCD fallback without a decoder',()=>{
 const cases=[Buffer.from('<html>not an image</html>'),png(32769),png().subarray(0,70),jpeg().subarray(0,70),Buffer.alloc(0)];
 for(const data of cases){const h=harness(data);assert.equal(h.r.valid(),false);h.r.dispose();assert.equal(h.f.closed(),true);}
 assert.equal(harness(png(),{available:false}).r.valid(),false);
 assert.equal(harness(png(),{limit:3}).r.valid(),false);
 assert.doesNotMatch(source,/LittleFS|malloc|fopen|drawPng|drawJpg|createSprite/);
});
test('304 is empty, closes its descriptor and needs no extra image reads; concurrent replacement drops its validator',()=>{
 const h=harness(png());const reads=h.f.reads(),tag=h.r.tag();assert.ok(tag);
 assert.equal(h.f.reads(),reads);h.revision.busy=true;assert.equal(h.r.tag(),'');
 h.revision.busy=false;h.revision.value++;assert.equal(h.r.tag(),'');
 h.r.notModified();assert.equal(h.r._code,304);assert.equal(h.r._contentLength,0);assert.equal(h.r._sendContentLength,false);
 assert.equal(h.r.valid(),true);assert.equal(h.f.closed(),true);
});
test('zero-capacity and failed payload reads cannot spin or claim a complete image',()=>{
 const h=harness(png());assert.equal(h.r.fill(Buffer.alloc(0),0),0);assert.equal(h.r.valid(),true);
 h.f.close();assert.equal(h.r.fill(Buffer.alloc(8),8),0);assert.equal(h.r.valid(),false);
});
test('compressed originals are bounded and protected by the same family LRU; the network handler keeps its LCD escape hatch',()=>{
 const cache=read('src/artwork/artwork_cache.cpp'),web=read('src/web/web_server.cpp');
 const compact=body(cache,'bool ArtworkCache::compactRemoteArtwork(');
 assert.ok(compact.indexOf('validLcdThumbnailFile')<compact.indexOf('keepWebImage'));
 assert.match(compact,/WebArtwork::inspect\(original\)/);assert.match(compact,/if \(keepWebImage\) continue/);
 assert.match(compact,/originalPath == imagePath && WebArtwork::inspect/);
 assert.doesNotMatch(body(cache,'void ArtworkCache::loop('),/compactRemoteArtwork\(/);
 const lookup=body(cache,'bool ArtworkCache::stationWebArtworkPath(');
 assert.doesNotMatch(lookup,/LittleFS\.(exists|open)|download\(|ensureLcdThumbnail/);
 const route=web.slice(web.indexOf('server.on("/api/artwork/station"'),web.indexOf('server.on("/api/stations"'));
 assert.ok(route.indexOf('StationWebImageResponse')<route.indexOf('StationArtworkResponse'));
 assert.match(route,/!request->hasParam\("lcd"\)/);assert.match(route,/Cache-Control.*no-cache/);
 assert.match(body(web,'static bool commitLogoUpload('),/ArtworkRevision::Publication publication/);
});

test('compaction retains only the matching small original and leaves all source files intact until LCD pixels are valid',()=>{
 const cache=read('src/artwork/artwork_cache.cpp');
 let code=body(cache,'bool ArtworkCache::compactRemoteArtwork(')
  .replace(/String (thumbPath|expectedStem|originalPath) =/g,'const $1 =')
  .replace('size_t removedBytes = 0;','let removedBytes = 0;')
  .replace('const char* extensions[] = { ".png", ".jpg", ".jpeg", ".bmp" };','const extensions=[".png",".jpg",".jpeg",".bmp"];')
  .replace('for (const char* extension : extensions)','for (const extension of extensions)')
  .replace('ReadOnlyStorage::File original(LittleFS.mountpoint(), originalPath.c_str());','const original = open(originalPath);')
  .replace('if (!original) continue;','if (!original.valid()) continue;')
  .replace('const size_t originalBytes','const originalBytes').replace('const bool keepWebImage','const keepWebImage')
  .replace('ArtworkRevision::Publication publication;','')
  .replace('LcdThumbnailRam::contains(thumbPath.c_str())','ramReady')
  .replace(/WebArtwork::Format::None/g,'"None"').replace(/WebArtwork::inspect/g,'inspect')
  .replace(/\.c_str\(\)/g,'').replace('static_cast<unsigned>(removedBytes)','removedBytes');
 const files=new Map(),fs={remove:p=>files.delete(p)},base='/cache/art_example';let lcdReady=true;
 const original=png(),stale=jpeg();
 const run=new Function('source','imagePath','fillFrame','LittleFS','open','inspect','lcdThumbnailPath','cachePath','cacheFamilyStemForPath','validLcdThumbnailFile','isRemoteArtworkSource','markThumbnailReady','Serial','ramReady',
  'let outPath="";const result=(()=>'+code+')();return {result,outPath};');
 const invoke=(ramReady=false)=>run('https://source',base+'.png',false,fs,p=>file(files.get(p)||Buffer.alloc(0),{available:files.has(p)}),f=>inspect(f,32768),()=>base+'_176.sr565',(_s,ext)=>base+ext,()=>base,()=>lcdReady,()=>true,()=>{}, {printf(){}},ramReady);
 files.set(base+'.png',original);files.set(base+'.jpg',stale);files.set(base+'.bmp',Buffer.from('uncompressed bitmap'));
 lcdReady=false;assert.equal(invoke().result,false);assert.equal(files.size,3);
 lcdReady=true;assert.equal(invoke().result,true);assert.deepEqual([...files.keys()],[base+'.png']);assert.equal(files.get(base+'.png'),original);
 files.set(base+'.png',png(32769));assert.equal(invoke(true).result,true);assert.equal(files.size,1,'RAM pixels must retain their durable source for reboot/eviction');
 assert.equal(invoke().result,true);assert.equal(files.size,0);
});
