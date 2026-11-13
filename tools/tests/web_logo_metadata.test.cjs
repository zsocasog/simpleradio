const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),test=require('node:test');
const root=path.resolve(__dirname,'../..'),web=fs.readFileSync(path.join(root,'src/web/web_server.cpp'),'utf8');
const start=web.indexOf('static AsyncWebServerResponse* prepareLogoListResponse('),end=web.indexOf('struct StoredFileReadJob',start);
const route=web.slice(web.indexOf('{',start),web.lastIndexOf('}',end)+1);
const code=route.replace('ArtworkJson::Allocator jsonAllocator;','')
 .replace('ReadOnlyStorage::visitFiles(LittleFS.mountpoint(), "/logos", [&](const char* filename, size_t bytes, time_t)', 'visitFiles(LittleFS.mountpoint(), "/logos", (filename, bytes)=>')
 .replace('JsonDocument doc(&jsonAllocator);','const doc={logos:[],overflowed:()=>overflow};')
 .replace('JsonArray arr = doc["logos"].to<JsonArray>();','const arr=doc.logos;')
 .replace('char absolute[320];','const absolute={value:""};').replace('struct stat info{};','const info={};')
 .replace(/const (?:char\*|int|String) /g,'const ').replace('File root =','const root =')
 .replace('bool directory = false;','let directory=false;').replace('String path =','let path=')
 .replace(/root.getNextFileName\(&directory\)/g,'nextName(root,value=>directory=value)')
 .replace('JsonObject item = arr.add<JsonObject>();','const item={};arr.push(item);')
 .replace(/static_cast<size_t>\((length|count)\)/g,'$1').replace(/sizeof\(absolute\)/g,'320')
 .replace(/::stat\(absolute, &info\)/g,'stat(absolute,info)').replace(/\.length\(\)/g,'.length')
 .replace(/\.c_str\(\)/g,'').replace('static_cast<uint32_t>(info.st_size)','(info.st_size>>>0)')
 .replace('static_cast<uint32_t>(bytes)','(bytes>>>0)')
 .replace('String out;','let out;').replace('serializeJson(doc, out);','out=JSON.stringify(doc);')
 .replace(/request->/g,'request.');
function run({entries=[{name:'radio.png',size:31100},{name:'other.JPG',size:9468}],overflow=false,mounted=true,missing=false,rounds=1}={}){
 let opened=0,closed=0;const replies=[];
 const c=vm.createContext({overflow,
  visitFiles(mount,directory,visitor){assert.equal(directory,'/logos');if(!mount||missing)return false;opened++;
   try{for(const e of entries)if(!e.directory&&!e.vanished)visitor('/logos/'+e.name,e.size);}finally{closed++;}return true;},
  LittleFS:{mountpoint:()=>mounted?'/littlefs':null,open(p){assert.equal(p,'/logos','logo content must never be opened');opened++;return {index:0,isDirectory:()=>true,close(){closed++;}};}},
  nextName(dir,setDir){const e=entries[dir.index++];if(!e)return '';setDir(!!e.directory);return '/logos/'+e.name;},
  snprintf(buffer,limit,format,...args){let n=0;const full=format.replace(/%s/g,()=>args[n++]);buffer.value=full.slice(0,limit-1);return full.length;},
  stat(buffer,info){if(missing)return -1;if(buffer.value==='/littlefs/logos'){info.st_mode='dir';return 0;}
   const e=entries.find(x=>'/littlefs/logos/'+x.name===buffer.value);if(!e||e.vanished)return -1;
   info.st_mode=e.directory?'dir':'file';info.st_size=e.size;return 0;},
  S_ISDIR:mode=>mode==='dir',S_ISREG:mode=>mode==='file',
  logoBasename:p=>p.split(/[\\/]/).at(-1),supportedLogoExtension:n=>/\.(png|jpe?g|bmp|gif|webp|ico)$/i.test(n),
  request:{beginResponse:(status,type,text)=>{const reply={status,type,text};replies.push(reply);return reply;}} });
 vm.runInContext('function route() '+code,c);for(let i=0;i<rounds;i++)c.route();
 return {opened,closed,replies,logos:replies[0]?.status===200?JSON.parse(replies[0].text).logos:[]};
}
test('the crashing logo-list path now reads metadata without opening any image FILE streams',()=>{
 const r=run();assert.equal(r.opened,1);assert.equal(r.closed,1);
 assert.deepEqual(r.logos,[{name:'radio.png',path:'/logos/radio.png',size:31100},{name:'other.JPG',path:'/logos/other.JPG',size:9468}]);
 assert.doesNotMatch(route,/openNextFile\(|file\.size\(|LittleFS.exists\(|LittleFS.open\(/);
});
test('directories, unsupported files and entries deleted during enumeration are safely skipped',()=>{
 const r=run({entries:[{name:'folder.png',directory:true},{name:'readme.txt',size:50},{name:'gone.png',size:20,vanished:true},{name:'Rádió.png',size:4096}]});
 assert.deepEqual(r.logos,[{name:'Rádió.png',path:'/logos/Rádió.png',size:4096}]);assert.equal(r.opened,r.closed);
});
test('absent/unmounted logo storage returns the existing empty-list shape without opening files',()=>{
 for(const options of [{mounted:false},{missing:true}]){const r=run(options);assert.equal(r.opened,0);assert.deepEqual(r.logos,[]);}
});
test('partial JSON allocation fails explicitly instead of returning a truncated list',()=>{
 const r=run({overflow:true});assert.equal(r.replies[0].status,503);assert.equal(r.opened,r.closed);
});
test('repeated enumeration closes its single directory handle on every response',()=>{
 const r=run({rounds:200});assert.equal(r.opened,200);assert.equal(r.closed,200);
 assert.ok(r.replies.every(x=>x.status===200));
});
test('frequent outgoing state/status/station/logo JSON pools stay out of internal RAM',()=>{
 for(const marker of ['static String systemStatusJson()','static String hardwareCapabilitiesJson()',
  'server.on("/api/stations"','static AsyncWebServerResponse* prepareLogoListResponse(']){
  const part=web.slice(web.indexOf(marker),web.indexOf(marker)+250);
  assert.match(part,/ArtworkJson::Allocator jsonAllocator;\s*JsonDocument doc\(&jsonAllocator\)/);
 }
 const state=fs.readFileSync(path.join(root,'src/state/player_state.cpp'),'utf8');
 assert.match(state.slice(state.indexOf('String PlayerState::toJson()'),state.indexOf('String PlayerState::toJson()')+230),/JsonDocument doc\(&jsonAllocator\)/);
});
