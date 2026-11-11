const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),test=require('node:test');
const root=path.resolve(__dirname,'../..');
const header=fs.readFileSync(path.join(root,'src/storage/ota_backup.h'),'utf8');
const web=fs.readFileSync(path.join(root,'src/web/web_server.cpp'),'utf8');
function body(source,marker){const start=source.indexOf('{',source.indexOf(marker));let depth=0;for(let i=start;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&!--depth)return source.slice(start,i+1);}throw Error(marker);}
const translate=code=>code.replace(/nullptr/g,'null').replace(/\bentries_/g,'this.entries').replace(/\bbytes_/g,'this.used')
 .replace(/\ballocate_\(/g,'this.allocate(').replace(/\brelease_\(/g,'this.release(')
 .replace(/entries\.size\(\)/g,'entries.length').replace(/std::string_view\(entry.path\)/g,'entry.path')
 .replace(/path\.size\(\)/g,'path.length').replace(/path\.empty\(\)/g,'!path.length')
 .replace(/for \(const auto& entry : this.entries\)/g,'for (const entry of this.entries)')
 .replace(/for \(auto& entry : this.entries\)/g,'for (const entry of this.entries)')
 .replace('uint8_t* data =','const data =').replace('this.entries.push_back({std::string(path), data, size});','this.entries.push({path, data, size});')
 .replace('entry.path.c_str()','entry.path').replace('this.entries.clear();','this.entries.length=0;');
const Snapshot=new Function('MAX_BYTES','MAX_FILES','MAX_PATH',`return class {
 entries=[];used=0;constructor(allocate,release){this.allocate=allocate;this.release=release;} count(){return this.entries.length;} bytes(){return this.used;}
 add(path,size,read)${translate(body(header,'bool add('))}
 restore(write)${translate(body(header,'bool restore('))}
 clear()${translate(body(header,'void clear('))}
}`)(4*1024*1024,128,160);
function harness(){
 const files=new Map(),freed=[],writes=[];let allocationOk=true,readOk=true,writeOk=true;
 const backup=new Snapshot(n=>allocationOk?new Uint8Array(n):null,data=>freed.push(data));
 const open=p=>{
  if(p==='/logos'){
   const names=[...files.keys()].filter(n=>n.startsWith('/logos/'));let index=0;
   return {isDirectory:()=>true,openNextFile:()=>index<names.length?open(names[index++]):false};
  }
  if(!files.has(p))return false;let offset=0;
  return {isDirectory:()=>false,name:()=>p,size:()=>files.get(p).length,close(){},
   read(data,n){if(!readOk)return 0;const part=files.get(p).subarray(offset,offset+n);data.set(part);offset+=part.length;return part.length;}};
 };
 const c=vm.createContext({otaRuntimeBackup:backup,otaRuntimeBackupReady:false,delay(){},Serial:{printf(){}},
  LittleFS:{exists:p=>p==='/logos'?[...files.keys()].some(n=>n.startsWith('/logos/')):files.has(p),mkdir:()=>true,
   open(p,mode='r'){if(mode==='r')return open(p);let bytes=new Uint8Array();
    return {write(data,n){if(!writeOk)return 0;const next=new Uint8Array(bytes.length+n);next.set(bytes);next.set(data.subarray(0,n),bytes.length);bytes=next;files.set(p,bytes);writes.push(p);return n;},
     size:()=>bytes.length,flush(){},close(){if(!files.has(p))files.set(p,bytes);},getWriteError:()=>false};}}});
 const code=source=>source.replace(/for \(const char\* path : \{([^}]+)\}\)/g,'for(const path of [$1])')
  .replace(/ReadOnlyStorage::(?:exists|directoryExists)\(LittleFS.mountpoint\(\), (path|"\/logos")\)/g,'LittleFS.exists($1)')
  .replace(/auto capture = \[\]\(const char\* path\)/,'const capture = path =>')
  .replace(/\[&\]\(uint8_t\* data, size_t size\)/,'(data,size)=>')
  .replace(/\[\]\(const char\* path, const uint8_t\* data, size_t size\)/,'(path,data,size)=>')
  .replace(/for \(File file =/,'for (let file =').replace(/\bFile (file|root) =/g,'const $1 =')
  .replace(/\bString name =/,'let name =').replace(/const (?:String|int|size_t|bool) /g,'const ').replace(/\bsize_t /g,'let ')
  .replace('name.remove(0, slash + 1);','name=name.substring(slash+1);').replace(/\.c_str\(\)/g,'')
  .replace(/std::min\(/g,'Math.min(').replace(/size_t\(4096\)/g,'4096').replace(/unsigned\(([^)]+)\)/g,'$1')
  .replace(/strncmp\(path, "\/logos\/", 7\) == 0/g,'path.startsWith("/logos/")')
  .replace(/data \+ offset/g,'data.subarray(offset)');
 vm.runInContext(`function clearOtaRuntimeBackups()${code(body(web,'static void clearOtaRuntimeBackups('))}
 function backupOtaRuntimeFiles()${code(body(web,'static bool backupOtaRuntimeFiles('))}
 function restoreOtaRuntimeFiles()${code(body(web,'static bool restoreOtaRuntimeFiles('))}`,c);
 return {c,files,backup,freed,writes,failAllocation:()=>allocationOk=false,failRead:()=>readOk=false,failWrite:()=>writeOk=false,resumeWrite:()=>writeOk=true};
}
test('data update preserves generated and custom binary logos at their exact paths, with settings and JSON backups',()=>{
 const h=harness(),saved=new Map([
  ['/stations.json',Buffer.from('{"stations":[{"id":6,"logo":"/logos/station-6-radio-1.png"}]}')],
  ['/config.json',Buffer.from('{"theme":"amber"}')],['/wifi.json.bak',Buffer.from('{"ssid":"saved"}')],
  ['/logos/station-6-radio-1.png',Buffer.from([137,80,78,71,0,255,0,129])],['/logos/custom.png',Buffer.from([0,0,255,128,0])]
 ]);
 saved.forEach((data,p)=>h.files.set(p,data));h.files.set('/logos/unfinished.tmp',Buffer.from('partial'));
 assert.equal(h.c.backupOtaRuntimeFiles(),true);assert.equal(h.backup.entries.length,saved.size);
 h.files.clear();h.files.set('/index.html',Buffer.from('new web UI'));
 assert.equal(h.c.restoreOtaRuntimeFiles(),true);
 saved.forEach((data,p)=>assert.deepEqual(Buffer.from(h.files.get(p)),data,p));
 assert.equal(h.files.has('/logos/unfinished.tmp'),false);assert.equal(Buffer.from(h.files.get('/index.html')).toString(),'new web UI');
 h.c.clearOtaRuntimeBackups();assert.equal(h.backup.used,0);assert.equal(h.freed.length,saved.size);
});
test('an allocation failure or incomplete file read discards the incomplete snapshot before the update starts',()=>{
 for(const reason of ['memory','read']){const h=harness();h.files.set('/stations.json',Buffer.from('saved'));h.files.set('/logos/station-1.png',Buffer.from([0,255]));
  reason==='memory'?h.failAllocation():h.failRead();assert.equal(h.c.backupOtaRuntimeFiles(),false);assert.equal(h.c.otaRuntimeBackupReady,false);assert.equal(h.backup.used,0);assert.equal(h.writes.length,0);}
});
test('short restore writes report failure and retain original bytes for a successful retry',()=>{
 const h=harness();h.files.set('/logos/station-1.png',Buffer.from([0,255,128,0]));assert.equal(h.c.backupOtaRuntimeFiles(),true);
 h.files.clear();h.failWrite();assert.equal(h.c.restoreOtaRuntimeFiles(),false);assert.equal(h.c.otaRuntimeBackupReady,true);assert.equal(h.freed.length,0);
 assert.equal(h.c.backupOtaRuntimeFiles(),true); // Does not replace the original with the incomplete target.
 h.resumeWrite();assert.equal(h.c.restoreOtaRuntimeFiles(),true);assert.deepEqual(Buffer.from(h.files.get('/logos/station-1.png')),Buffer.from([0,255,128,0]));
});
test('backup limits and duplicate paths refuse capture rather than silently dropping images',()=>{
 const h=harness();assert.equal(h.backup.add('/large',4*1024*1024,()=>true),true);
 assert.equal(h.backup.add('/extra',1,()=>{throw Error('must not allocate');}),false);
 assert.equal(h.backup.add('/large',0,()=>true),false);h.backup.clear();
 for(let n=0;n<128;n++)assert.equal(h.backup.add('/'+n,0,()=>true),true);
 assert.equal(h.backup.add('/overflow',0,()=>true),false);
});
test('OTA refuses to unmount or erase if the complete settings/logo snapshot cannot be captured',()=>{
 const events=[],request={attributes:{},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k]||'';},hasParam:()=>true,getParam:()=>({value:()=> '1'})};
 const c=vm.createContext({otaUploadActive:false,storedReadInProgress:{load:()=>false},vTaskDelay(){},otaRuntimeBackupReady:false,otaUploadLastMs:0,otaUploadGeneration:0,OTA_UPLOAD_STALE_MS:30000,
  millis:()=>100,otaRequestPassword:()=> 'test',SIMPLE_RADIO_OTA_PASSWORD:'test',I18n:{OTA_BACKUP_FAILED:'backup failed'},
  stopPlaybackForMaintenance:()=>events.push('stop'),backupOtaRuntimeFiles:()=>false,clearOtaRuntimeBackups(){},
  LittleFS:{end:()=>events.push('unmount')},Update:{begin:()=>{events.push('erase');return true;}},Serial:{printf(){}},String});
 const begin=body(web,'static bool beginOtaUpload(').replace(/->/g,'.').replace(/I18n::/g,'I18n.').replace(/const uint32_t /g,'const ').replace('1000U','1000').replace(/String\(\+\+otaUploadGeneration\).c_str\(\)/,'String(++otaUploadGeneration)');
 vm.runInContext('function beginOtaUpload(request,total,command,filesystemTarget)'+begin,c);
 assert.equal(c.beginOtaUpload(request,100,0,true),false);assert.deepEqual(events,['stop']);assert.equal(request.attributes.error,'backup failed');
});
