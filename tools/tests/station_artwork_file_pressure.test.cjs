const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), test = require('node:test');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const storage = read('src/storage/read_only_file.h');
const response = read('src/web/station_artwork_response.h');
function body(source, marker) {
  const start = source.indexOf('{', source.indexOf(marker));
  assert.ok(start >= 0, marker);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(marker);
}
function translate(code) {
  return code.replace(/SR_PERF_(?:SPAN|WAIT)\([^;]+;/g, '').replace('char absolute[320];', 'const absolute={value:""};')
    .replace('!*mount', '!mount.length')
    .replace(/LcdBmp::/g, 'LcdBmp.')
    .replace(/'([SR56])'/g, (_, c) => c.charCodeAt(0))
    .replace('struct stat info{};', 'const info={};')
    .replace(/const (?:int|ssize_t|uint16_t|size_t) /g, 'const ')
    .replace(/size_t done/g, 'let done').replace(/static_cast<(?:size_t|off_t|uint16_t)>\(([^)]+)\)/g, '($1)')
    .replace(/sizeof\(out\)/g, '320').replace(/sizeof\(sr\)/g, '8')
    .replace(/::(open|close|read|lseek|stat|fstat)\(/g, 'io.$1(')
    .replace(/&info/g, 'info').replace(/\bout \+ done/g, 'out.subarray(done)')
    .replace(/\b(fd_|size_)\b/g, 'this.$1').replace(/(?<![.\w])close\(\)/g, 'this.close()')
    .replace(/\berrno\b/g, 'io.errno');
}
const fullPath = new Function('snprintf', `return function(out,mount,path) ${translate(body(storage, 'bool fullPath('))}`)(
  (out, limit, _format, mount, file) => { const full = mount + file; out.value = full.slice(0, limit - 1); return full.length; });
const bmpSource = read('src/artwork/lcd_bmp_stream.h');
const headerCode = body(bmpSource, 'Header header(').replace('Header out{};', 'const out=new Uint8Array(66);')
  .replace('auto le32 = [&](size_t offset, uint32_t value)', 'const le32=(offset,value)=>')
  .replace(/static_cast<uint8_t>\((value >> \(8 \* i\))\)/g, '($1)')
  .replace('static_cast<uint32_t>(width)', 'width').replace(/const uint32_t /g, 'const ')
  .replace(/unsigned i/g, 'let i').replace(/0U/g, '0').replace(/~3U/g, '~3')
  .replace(/'([BM])'/g, (_, c) => c.charCodeAt(0));
const readerCode = body(bmpSource, 'size_t read(Source&').replace(/const (?:size_t|uint8_t) /g, 'const ')
  .replace(/size_t (count|done)/g, 'let $1').replace(/size_t i/g, 'let i')
  .replace('uint8_t pair[2];', 'const pair=new Uint8Array(2);')
  .replace(/bmp.size\(\)/g, 'bmp.length').replace(/size_t\(1\)/g, '1')
  .replace('memcpy(out, bmp.data() + index, n);', 'out.set(bmp.subarray(index,index+n));')
  .replace('source.read(out + done, pairs)', 'source.read(out.subarray(done),pairs)');
const LcdBmp = { header:new Function('width','height',headerCode),
  read:new Function('source','bmp','out','capacity','index','total',readerCode) };
function image(side = 2) {
  const data = Buffer.alloc(8 + side * side * 2);
  data.write('SR56'); data.writeUInt16LE(side, 4); data.writeUInt16LE(side, 6);
  for (let i=8; i<data.length; i++) data[i] = i % 251;
  return data;
}
function harness({bytes=image(), capacity=8, readLimit=Infinity, interrupt=false, failStat=false}={}) {
  let serial=0, opens=0, closes=0, peak=0, interrupted=false;
  const handles=new Map(), files=new Map([['/littlefs/cache/logo.sr565',bytes]]);
  const io={ errno:0,
    open(absolute) { if (!files.has(absolute.value)||handles.size>=capacity) return -1;
      const fd=serial++; handles.set(fd,{data:files.get(absolute.value),pos:0}); opens++;peak=Math.max(peak,handles.size);return fd; },
    close(fd) { assert.ok(handles.delete(fd),'descriptor must close exactly once');closes++;return 0; },
    stat(absolute, info) { const data=files.get(absolute.value);if(!data)return -1;info.st_mode='file';info.st_size=data.length;return 0; },
    fstat(fd, info) { if(failStat)return -1;const h=handles.get(fd);if(!h)return -1;info.st_mode='file';info.st_size=h.data.length;return 0; },
    lseek(fd, offset) { const h=handles.get(fd);if(!h)return -1;h.pos=offset;return offset; },
    read(fd,out,length) { if(interrupt&&!interrupted){interrupted=true;io.errno=4;return -1;}
      const h=handles.get(fd);if(!h)return -1;const n=Math.min(length,readLimit,h.data.length-h.pos);
      out.set(h.data.subarray(h.pos,h.pos+n));h.pos+=n;return n; },
    // Failure tripwires: the newlib FILE slot expansion in the logged crash.
    fopen(){throw Error('newlib FILE mutex allocation abort');},
    exists(){throw Error('Arduino exists() opens a stdio FILE');} };
  const regular=mode=>mode==='file';
  const File=new Function('io','fullPath','S_ISREG','O_RDONLY','SEEK_SET','EINTR', `return class {
    fd_=-1;size_=0;
    constructor(mount,path) ${translate(body(storage,'File(const char*'))}
    valid(){return this.fd_>=0;}
    size(){return this.size_;}
    seek(offset) ${translate(body(storage,'bool seek('))}
    read(out,length) ${translate(body(storage,'size_t read('))}
    close() ${translate(body(storage,'void close('))}
  }`)(io,fullPath,regular,0,0,4);
  const probe=new Function('io','fullPath','S_ISREG',`return function(mount,path) ${translate(body(storage,'bool exists('))}`)(io,fullPath,regular);
  const ctor=translate(body(response,'StationArtworkResponse(const char*'))
    .replace('uint8_t sr[8]{};', 'const sr=new Uint8Array(8);')
    .replace('!file_ ||','!file_.valid() ||');
  const member=code=>code.replace(/\b(file_|bmp_|offset_|valid_|_code|_contentType|_contentLength|_sendContentLength)\b/g,'this.$1')
    .replace(/bmp_\.size\(\)/g,'bmp_.length');
  const Response=new Function('File','LcdBmp',`return class {
    bmp_=new Uint8Array(66);offset_=0;valid_=false;
    constructor(mount,path){this.file_=new File(mount,path);${member(ctor)}}
    _sourceValid() ${member(body(response,'bool _sourceValid('))}
    _fillBuffer(buffer,maxLen) ${member(translate(body(response,'size_t _fillBuffer(')))}
    dispose(){this.file_.close();}
  }`)(File,LcdBmp);
  return {io,File,Response,probe,files,handles,
    counts:()=>({opens,closes,peak}),create:()=>new Response('/littlefs','/cache/logo.sr565')};
}

test('the logged thumbnail lookup cannot reach Arduino fopen/exists on any local/remote fallback',()=>{
  const cache=read('src/artwork/artwork_cache.cpp'),web=read('src/web/web_server.cpp');
  for(const marker of ['bool ArtworkCache::findExistingCachePath(', 'bool ArtworkCache::findExistingLcdArtworkPath(',
    'String ArtworkCache::preferredLocalArtworkPath(', 'bool ArtworkCache::stationArtworkReady(',
    'static bool validLcdThumbnailFile(const String& path) {']) {
    assert.doesNotMatch(body(cache,marker),/LittleFS\.(?:exists|open)\(/,marker);
  }
  const route=web.slice(web.indexOf('server.on("/api/artwork/station"'),web.indexOf('server.on("/api/stations"'));
  assert.doesNotMatch(route,/make_shared|LittleFS\.open|beginResponse/);
  assert.match(route,/new \(std::nothrow\) StationArtworkResponse/);
  assert.match(route,/if \(!response\).*send\(503\)/);
});

test('metadata probes need no descriptor, and exhaustion/missing files fail without FILE allocation',()=>{
  const h=harness({capacity:0});
  for(let i=0;i<1000;i++)assert.equal(h.probe('/littlefs','/cache/logo.sr565'),true);
  assert.equal(h.create()._sourceValid(),false);assert.equal(h.probe(null,'/cache/logo.sr565'),false);
  assert.equal(h.probe('/littlefs','/missing'),false);assert.equal(h.counts().opens,0);
});

test('the crashing production thumbnail validator handles pressure, missing and damaged files',()=>{
  const cache=read('src/artwork/artwork_cache.cpp');
  const validator=translate(body(cache,'static bool validLcdThumbnailFile(const String& path) {'))
    .replace('ReadOnlyStorage::File file(LittleFS.mountpoint(), path.c_str());','const file=new File("/littlefs",path);')
    .replace('if (!file)', 'if (!file.valid())').replace('uint8_t header[8] = {0};','const header=new Uint8Array(8);')
    .replace(/sizeof\(header\)/g,'8').replace('bool ok =','const ok =')
    .replace(/header \+ (4|6)/g,'header.subarray($1)');
  for(const options of [{bytes:image(176)},{capacity:0},{bytes:Buffer.alloc(16)},{bytes:image(120)},{failStat:true}]){
    const h=harness(options);
    const check=new Function('File','LCD_THUMB_BYTES','LCD_THUMB_SIZE','readLe16At',`return function(path) ${validator}`)(
      h.File,8+176*176*2,176,bytes=>bytes[0]|bytes[1]<<8);
    assert.equal(check('/cache/logo.sr565'),!!options.bytes&&options.bytes.length===8+176*176*2);
    assert.equal(check('/cache/missing.sr565'),false);assert.equal(h.handles.size,0);
  }
});

test('a full 176px logo is byte-identical through partial reads and fragmented HTTP callbacks',()=>{
  const bytes=image(176),expected=Buffer.concat([Buffer.from(LcdBmp.header(176,176)),Buffer.from(bytes.subarray(8)).swap16()]);
  for(const chunk of [1,3,65,66,67,511,1460,5840]) {
    const h=harness({bytes,readLimit:chunk===1?3:113,interrupt:true}),r=h.create(),parts=[];
    assert.equal(r._sourceValid(),true);assert.equal(r._contentLength,expected.length);
    let done=0;
    while(done<expected.length){const out=Buffer.alloc(chunk),count=r._fillBuffer(out,chunk);assert.ok(count>0);parts.push(out.subarray(0,count));done+=count;}
    assert.deepEqual(Buffer.concat(parts),expected);assert.equal(h.handles.size,0);
    assert.equal(r._sourceValid(),true,'pending TCP bytes remain valid after source closes');
    assert.equal(r._fillBuffer(Buffer.alloc(1),1),0);r.dispose();assert.deepEqual(h.counts(),{opens:1,closes:1,peak:1});
  }
});

test('slow readers and disconnects release every owned descriptor without poisoning other clients',()=>{
  const h=harness({capacity:4}),pending=Array.from({length:4},()=>h.create());
  assert.ok(pending.every(r=>r._sourceValid()));const rejected=h.create();assert.equal(rejected._sourceValid(),false);rejected.dispose();
  pending[1].dispose();const replacement=h.create();assert.equal(replacement._sourceValid(),true);
  for(const r of pending)r.dispose();replacement.dispose();
  for(let i=0;i<500;i++){const r=h.create();r._fillBuffer(Buffer.alloc(3),3);r.dispose();}
  assert.equal(h.handles.size,0);assert.equal(h.counts().opens,h.counts().closes);assert.equal(h.counts().peak,4);
});

test('bad signatures, geometry, lengths and stat errors are rejected and closed',()=>{
  const invalid=[Buffer.alloc(0),Buffer.alloc(7),Buffer.alloc(16),image(3),image(514),Buffer.concat([image(),Buffer.from([0])])];
  for(const bytes of invalid){const h=harness({bytes}),r=h.create();assert.equal(r._sourceValid(),false);r.dispose();assert.equal(h.handles.size,0);}
  const h=harness({failStat:true});assert.equal(h.create()._sourceValid(),false);assert.equal(h.handles.size,0);
});
