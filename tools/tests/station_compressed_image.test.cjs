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
const maxBytes=128*1024;
assert.match(policy,/MaxBytes = 128 \* 1024/);
function png(size=80){const b=Buffer.alloc(size,31);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.write('IEND',size-8);return b;}
function jpeg(size=90){const b=Buffer.alloc(size,55);b[0]=255;b[1]=216;b[size-2]=255;b[size-1]=217;return b;}
function file(data,{available=true,limit=Infinity,failCopy=false}={}){let pos=0,closed=false,reads=0;return {valid:()=>available&&!closed,size:()=>data.length,
 seek(n){if(!this.valid()||n>data.length)return false;pos=n;return true;},read(out,n){reads++;if(!this.valid()||(failCopy&&reads>2))return 0;const count=Math.min(n,limit,data.length-pos);out.set(data.subarray(pos,pos+count));pos+=count;return count;},
 close(){closed=true;},closed:()=>closed,reads:()=>reads};}
function harness(bytes,options={}){const f=file(bytes,options),revision={value:1,busy:false},allocations=new Set();let allocationCalls=0;
 const translate=c=>c.replace(/SR_PERF_SPAN\([^;]+;/g,'').replace(/const (?:auto|uint32_t|size_t) /g,'const ')
  .replace(/WebArtwork::/g,'WebArtwork.').replace(/ArtworkRevision::/g,'ArtworkRevision.').replace(/ArtworkEtag::/g,'ArtworkEtag.')
  .replace(/::/g,'.').replace(/nullptr/g,'null').replace('size_t copied = 0;','let copied = 0;')
  .replace('static_cast<uint8_t*>(heap_caps_malloc(_contentLength, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT))','allocate(_contentLength)')
  .replace(/data_ \+ (copied|offset_)/g,'data_.subarray($1)')
  .replace(/\b(file_|data_|valid_|revisionAtOpen_|pathId_|offset_|_code|_contentType|_contentLength|_sendContentLength)\b/g,'this.$1');
 const Response=new Function('file','WebArtwork','ArtworkRevision','ArtworkEtag','allocate','heap_caps_free','memcpy',`return class {
 valid_=false;data_=null;offset_=0;revisionAtOpen_=1;pathId_=42;
 constructor(){this.file_=file;${translate(body(source,'StationWebImageResponse(const char*'))}}
 valid()${translate(body(source,'bool _sourceValid('))}
 prepare()${translate(body(source,'bool prepare('))}
 fill(buffer,maxLen)${translate(body(source,'size_t _fillBuffer('))}
 tag()${translate(body(source,'String entityTag('))}
 notModified()${translate(body(source,'void notModified('))}
 dispose(){${translate(body(source,'~StationWebImageResponse(')).slice(1,-1)}this.file_.close();}
 }`)(f,{inspect:f=>inspect(f,maxBytes),Format:{None:'None',Png:'Png',Jpeg:'Jpeg'}},
 {value:()=>revision.busy?0:revision.value,session:()=>123},{value:(...args)=>({data:()=>JSON.stringify(args)})},
 n=>{allocationCalls++;if(options.oom)return null;const b=Buffer.alloc(n);allocations.add(b);return b;},
 b=>allocations.delete(b),(out,input,n)=>out.set(input.subarray(0,n)));
 const r=new Response();if(options.prepare!==false)r.prepare();
 return {f,r,revision,allocations,allocationCalls:()=>allocationCalls};}
test('compressed PNG/JPEG snapshots are byte-exact, bounded, and close flash before TCP starts',()=>{
 for(const data of [png(),jpeg(),png(67738),png(120*1024),png(maxBytes)])for(const chunk of [1,3,64,4096,40000]){
  const {f,r,allocations}=harness(data);assert.equal(r.valid(),true);assert.equal(r._contentLength,data.length);assert.equal(f.closed(),true);
  assert.equal(r._contentType,data[1]===80?'image/png':'image/jpeg');
  const reads=f.reads(),parts=[];while(r.offset_<data.length){const b=Buffer.alloc(chunk),n=r.fill(b,chunk);assert.ok(n>0);parts.push(b.subarray(0,n));}
  assert.deepEqual(Buffer.concat(parts),data);assert.equal(r.valid(),true);assert.equal(r.fill(Buffer.alloc(5),5),0);assert.equal(f.reads(),reads);
  assert.equal(allocations.size,1);r.dispose();assert.equal(allocations.size,0);
 }
});
test('oversized, missing, truncated and mislabeled payloads are rejected for LCD fallback without a decoder',()=>{
 const cases=[Buffer.from('<html>not an image</html>'),png(maxBytes+1),png().subarray(0,70),jpeg().subarray(0,70),Buffer.alloc(0)];
 for(const data of cases){const h=harness(data);assert.equal(h.r.valid(),false);h.r.dispose();assert.equal(h.f.closed(),true);}
 assert.equal(harness(png(),{available:false}).r.valid(),false);
 assert.equal(harness(png(),{limit:3}).r.valid(),false);
 assert.doesNotMatch(source,/LittleFS|fopen|drawPng|drawJpg|createSprite|MALLOC_CAP_INTERNAL/);
 assert.match(source,/heap_caps_malloc\(_contentLength, MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT\)/);
 assert.doesNotMatch(body(source,'size_t _fillBuffer('),/file_\./);
});
test('304 is empty, closes its descriptor and needs no extra image reads; concurrent replacement drops its validator',()=>{
 const h=harness(png(),{prepare:false});const reads=h.f.reads(),tag=h.r.tag();assert.ok(tag);
 assert.equal(h.f.reads(),reads);h.revision.busy=true;assert.equal(h.r.tag(),'');
 h.revision.busy=false;h.revision.value++;assert.equal(h.r.tag(),'');
 h.r.notModified();assert.equal(h.r._code,304);assert.equal(h.r._contentLength,0);assert.equal(h.r._sendContentLength,false);
 assert.equal(h.r.valid(),true);assert.equal(h.f.closed(),true);
 assert.equal(h.r.prepare(),true);assert.equal(h.f.reads(),reads);assert.equal(h.allocationCalls(),0);
});
test('zero-capacity and closed flash cannot alter a completed immutable snapshot',()=>{
 const h=harness(png());assert.equal(h.r.fill(Buffer.alloc(0),0),0);assert.equal(h.r.valid(),true);
 h.f.close();assert.equal(h.r.fill(Buffer.alloc(8),8),8);assert.equal(h.r.valid(),true);
 const original=png(19053),expected=Buffer.from(original),s=harness(original);original.fill(99,10,100);
 const output=Buffer.alloc(expected.length);assert.equal(s.r.fill(output,output.length),output.length);assert.deepEqual(output,expected);
 s.r.dispose();h.r.dispose();
});

test('snapshot allocation or partial copy failure closes flash, frees RAM, and invalidates the source',()=>{
 for(const options of [{oom:true},{failCopy:true}]){const h=harness(png(67738),options);
  assert.equal(h.r.valid(),false);assert.equal(h.f.closed(),true);assert.equal(h.allocations.size,0);assert.equal(h.r.fill(Buffer.alloc(8),8),0);h.r.dispose();}
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
 const route=body(web,'static void sendStationImage(');
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
 const invoke=(ramReady=false)=>run('https://source',base+'.png',false,fs,p=>file(files.get(p)||Buffer.alloc(0),{available:files.has(p)}),f=>inspect(f,maxBytes),()=>base+'_176.sr565',(_s,ext)=>base+ext,()=>base,()=>lcdReady,()=>true,()=>{}, {printf(){}},ramReady);
 files.set(base+'.png',original);files.set(base+'.jpg',stale);files.set(base+'.bmp',Buffer.from('uncompressed bitmap'));
 lcdReady=false;assert.equal(invoke().result,false);assert.equal(files.size,3);
 lcdReady=true;assert.equal(invoke().result,true);assert.deepEqual([...files.keys()],[base+'.png']);assert.equal(files.get(base+'.png'),original);
 files.set(base+'.png',png(maxBytes+1));assert.equal(invoke(true).result,true);assert.equal(files.size,1,'RAM pixels must retain their durable source for reboot/eviction');
 assert.equal(invoke().result,true);assert.equal(files.size,0);
});
