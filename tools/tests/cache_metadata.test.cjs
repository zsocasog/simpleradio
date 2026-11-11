const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const read=p=>fs.readFileSync(path.resolve(__dirname,'../..',p),'utf8');
const source=read('src/storage/read_only_file.h');
const begin=source.indexOf('bool visitFiles('),end=source.indexOf('inline size_t directoryBytes(',begin);
let body=source.slice(source.indexOf('{',begin),end).trim();
body=body.replace(/SR_READ_IO_SCOPE\(\);/g,'').replace('char absolute[320];','const absolute={value:""};')
 .replace('DIR* dir = ::opendir(absolute);','const dir=opendir(absolute.value);')
 .replace('const size_t baseLength = strlen(absolute);','const baseLength=absolute.value.length;')
 .replace('size_t total = 0;','let total=0;')
 .replace('while (const auto* entry = ::readdir(dir))','let entry; while ((entry=readdir(dir)))')
 .replace('const int count = snprintf(absolute + baseLength, sizeof(absolute) - baseLength, "/%s", entry->d_name);','const count=appendPath(absolute,baseLength,entry.d_name);')
 .replace('struct stat info{};','const info={};')
 .replace('::stat(absolute, &info)','stat(absolute.value, info)')
 .replace(/static_cast<size_t>\(([^)]+)\)/g,'($1)').replace(/sizeof\(absolute\)/g,'320')
 .replace(/entry->/g,'entry.').replace('::closedir(dir)','closedir(dir)');
const count=new Function('mount','directory','fullPath','opendir','readdir','strcmp','appendPath','stat','S_ISREG','closedir','visitor',body);
function run(entries,{open=true,mount='/littlefs',directory='/cache'}={}){
 let index=0,closed=0,bytes=0;const probed=[];
 count(mount,directory,(out,m,p)=>{out.value=m+p;return !!m&&p.startsWith('/')&&out.value.length<320;},
  ()=>open?{}:null,()=>index<entries.length?{d_name:entries[index++].name}:null,(a,b)=>a===b?0:1,
  (out,base,name)=>{out.value=out.value.slice(0,base)+'/'+name;return name.length+1;},
  (p,info)=>{probed.push(p);const row=entries.find(e=>p.endsWith('/'+e.name));if(row?.gone)return -1;Object.assign(info,{st_mode:row?.directory?'dir':'file',st_size:row?.bytes||0});return 0;},
  mode=>mode==='file',()=>++closed,(_name,size)=>bytes+=size);
 return {bytes,closed,probed};
}
test('cache accounting reads metadata only, counting regular files and tolerating concurrent removal',()=>{
 const r=run([{name:'.'},{name:'..'},{name:'thumb.sr565',bytes:61960},{name:'logo.png',bytes:1000},
  {name:'empty',bytes:0},{name:'subfolder',directory:true,bytes:4096},{name:'retired.jpg',gone:true,bytes:500}]);
 assert.equal(r.bytes,62960);assert.equal(r.closed,1);assert.equal(r.probed.length,5);
 assert.ok(r.probed.every(p=>p.startsWith('/littlefs/cache/')));
});
test('unavailable directories and oversized paths return safely without opening child files',()=>{
 assert.deepEqual(run([],{open:false}),{bytes:0,closed:0,probed:[]});
 assert.equal(run([],{mount:''}).closed,0);
 const r=run([{name:'a'.repeat(310),bytes:100},{name:'ok.png',bytes:42}]);
 assert.equal(r.bytes,42);assert.deepEqual(r.probed,['/littlefs/cache/ok.png']);assert.equal(r.closed,1);
});
test('the system cache counter cannot recreate FILE mutexes for every cached thumbnail',()=>{
 const cache=read('src/artwork/artwork_cache.cpp');
 const b=cache.slice(cache.indexOf('size_t ArtworkCache::cacheBytes()'),cache.indexOf('size_t ArtworkCache::cacheLimitBytes()'));
 const getter=b.slice(0,b.indexOf('void ArtworkCache::refreshCacheStats'));
 assert.match(getter,/cacheBytesSnapshot.load/);assert.doesNotMatch(getter,/LittleFS|directoryBytes|openNextFile/);
 assert.match(b,/ReadOnlyStorage::directoryBytes/);assert.doesNotMatch(b,/LittleFS.open|openNextFile/);
 const web=read('src/web/web_server.cpp'),status=web.slice(web.indexOf('static String systemStatusJson()'),web.indexOf('static String hardwareCapabilitiesJson()'));
 assert.doesNotMatch(status,/LittleFS\.(totalBytes|usedBytes|open)/);
 assert.match(status,/artworkCacheStatsAgeMs/);
 const cleanup=web.slice(web.indexOf('static void removeOldStationLogoUploads'),web.indexOf('static String logoBasename'));
 assert.match(cleanup,/ReadOnlyStorage::visitFiles/);assert.doesNotMatch(cleanup,/openNextFile|LittleFS.open/);
 assert.doesNotMatch(body,/fopen|new |malloc|File /);
});
