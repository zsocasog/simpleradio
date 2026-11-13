const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),src=fs.readFileSync(path.join(root,'src/web/stored_file_response.h'),'utf8'),web=fs.readFileSync(path.join(root,'src/web/web_server.cpp'),'utf8');
function body(source,marker){const at=source.indexOf('{',source.indexOf(marker));let n=0;for(let i=at;i<source.length;i++){if(source[i]==='{')n++;if(source[i]==='}'&&!--n)return source.slice(at,i+1);}throw Error(marker);}
test('queued raw JSON reads close the actual file before a network response can start; no live config replaces durable bytes',()=>{
 const create=body(src,'static StoredFileResponse* create(');
 assert.ok(create.indexOf('file.close()')<create.indexOf('new (std::nothrow) StoredFileResponse'));
 assert.match(create,/ReadOnlyStorage::File file/);assert.match(create,/file.read\(bytes, size\) == size/);
 assert.match(create,/512 \* 1024/);assert.match(create,/size \+ 512 \* 1024/);
 assert.doesNotMatch(src,/MALLOC_CAP_INTERNAL|AppConfig|PlayerState|JsonDocument/);
 assert.match(body(web,'static void processStoredFileRead()'),/sendDeferredReply/);
 for(const name of ['config','state','stations'])assert.ok(web.indexOf('server.on("/'+name+'.json"')<web.indexOf('server.serveStatic('));
 const queue=body(web,'static void queueStoredFileRead(');assert.match(queue,/storedReadCount < 8/);assert.match(queue,/request->pause\(\)/);
});
test('byte streaming survives arbitrary network fragments and performs no filesystem work',()=>{
 const code=body(src,'size_t _fillBuffer(').replace(/const size_t /g,'const ').replace(/\b(offset_|_contentLength|bytes_)\b/g,'this.$1')
  .replace('memcpy(out, this.bytes_ + this.offset_, count)','copy(out, this.bytes_.subarray(this.offset_), count)');
 const read=new Function('copy','out','maxLen',code),data=Buffer.from('{"volume":1,"title":"árvíz"}'),state={bytes_:data,offset_:0,_contentLength:data.length};
 const parts=[];for(const n of [1,2,7,1,200,3]){const out=Buffer.alloc(n),count=read.call(state,(a,b,c)=>b.copy(a,0,0,c),out,n);parts.push(out.subarray(0,count));}
 assert.deepEqual(Buffer.concat(parts),data);assert.equal(read.call(state,()=>{},null,10),0);
 assert.doesNotMatch(code,/ReadOnly|LittleFS|open|close|alloc|new /);
});
test('the reader/OTA handshake publishes before checking and waits before unmount, with a bounded failure path',()=>{
 const process=body(web,'static void processStoredFileRead()'),ota=body(web,'static bool beginOtaUpload(');
 assert.ok(process.indexOf('storedReadInProgress.store(true)')<process.indexOf('(otaUploadActive || rebootPending)'));
 assert.ok(process.indexOf('StoredFileResponse::create')<process.indexOf('storedReadInProgress.store(false)',process.indexOf('StoredFileResponse::create')));
 assert.ok(ota.indexOf('otaUploadActive = true')<ota.indexOf('while (storedReadInProgress.load())'));
 assert.ok(ota.indexOf('while (storedReadInProgress.load())')<ota.indexOf('LittleFS.end()'));
 assert.match(ota,/storedReadWaitStarted >= 1000U/);
 assert.match(web,/std::atomic<bool> otaUploadActive\{false\}/);
});


test('all shipped STA web assets are queued before the static fallback; recovery and dynamic JSON retain their own routes',()=>{
 const routes=body(web,'void webServerBegin()');
 for(const path of ['/index.html','/wifi.html','/app.js','/ui.js','/wifi.js','/ir-profiles.js','/ir-editor.js',
 '/i18n-catalog.js','/i18n.js','/style.css','/ui.css','/wifi.css','/icons.svg','/favicon.svg','/build-info.json']){
  assert.ok(routes.includes('{"'+path+'",'),path);
 }
 const preload=routes.slice(routes.indexOf('static constexpr AssetRoute assets[]'),routes.indexOf('server.serveStatic('));
 assert.match(preload,/queueStoredFileRead\(request, route->path, route->type, true\)/);
 assert.doesNotMatch(preload,/LittleFS|open\(|read\(|StoredFileResponse::create|request->send\(/);
 assert.match(routes,/if \(WebUiCompatibility::info\(\).compatible\)/);
 assert.match(routes,/sendRecoveryPage/);
 const prepare=body(web,'static void processStoredFileRead()');
 assert.ok(prepare.indexOf('storedReadInProgress.store(true)')<prepare.indexOf('compressedPath'));
 assert.ok(prepare.indexOf('compressedPath')<prepare.indexOf('storedReadInProgress.store(false)',prepare.indexOf('compressedPath')));
 assert.match(prepare,/status == 404 && job->asset && !otaUploadActive && !rebootPending/);
 assert.match(prepare,/if \(gzip\) response->addHeader\("Content-Encoding", "gzip"\)/);
 assert.match(prepare,/job->asset \? "no-store, max-age=0" : "no-cache"/);
 assert.match(prepare,/response->setType\(job->type\)/);
});


function queuedRead(files,{ota=false,asset=true,condition='',logoList=false}={}){
 const reads=[],replies=[],barrier=[];
 const job={path:logoList?null:'/ui.css',type:'text/css',asset,request:{lock:()=>request}};
 const request={get(){return this;},beginResponse:status=>({status}),header:()=>condition};
 const response={headers:{},setType(t){this.type=t;},addHeader(k,v){this.headers[k]=v;},entityTag:()=> '"bytes"',notModified(){this.status=304;}};
 let code=body(web,'static void processStoredFileRead()')
  .replace('StoredFileReadJob* pending = nullptr;','let pending=null;')
  .replace(/port(?:ENTER|EXIT)_CRITICAL\(&storedReadMux\);/g,'')
  .replace('std::unique_ptr<StoredFileReadJob> job(pending);','const job=pending;')
  .replace('if (auto request = job->request.lock()) {','const request=job.request.lock();if(request){')
  .replace('int status = 503;','status=503;').replace(/auto\* (response|reply) =/g,'let $1 =')
  .replace('bool gzip =','let gzip =').replace(/const String /g,'const ')
  .replace(/->/g,'.').replace(/::/g,'.').replace(/nullptr/g,'null')
  .replace(/(compressedPath|condition|tag)\.c_str\(\)/g,'$1').replace(/(condition|tag)\.length\(\)/g,'$1.length')
  .replace('{condition, condition.length}, {tag, tag.length}','condition, tag');
 const c=require('node:vm').createContext({storedReadCount:1,storedReadHead:0,storedFileReads:[job],otaUploadActive:ota,rebootPending:false,
  LittleFS:{mountpoint:()=>'/littlefs'},storedReadInProgress:{store:v=>barrier.push(v)},
  StoredFileResponse:{create:(_mount,path)=>{assert.equal(barrier.at(-1),true);reads.push(path);const error=files[path];c.status=error??404;return error===200?response:null;}},
  prepareLogoListResponse:()=>{reads.push('directory');return response;},
  ArtworkEtag:{matches:(a,b)=>a===b},sendDeferredReply:(_request,reply)=>{assert.equal(barrier.at(-1),false);replies.push(reply);}});
 require('node:vm').runInContext('function process()'+code+';process();',c);
 return {reads,replies,barrier,response};
}

test('real queue processor preserves plain/gzip choice, MIME and cache policy without any network file read',()=>{
 let h=queuedRead({'/ui.css':200,'/ui.css.gz':200});assert.deepEqual(h.reads,['/ui.css']);assert.equal(h.replies[0].type,'text/css');
 assert.equal(h.response.headers['Content-Encoding'],undefined);assert.equal(h.response.headers['Cache-Control'],'no-store, max-age=0');
 h=queuedRead({'/ui.css.gz':200});assert.deepEqual(h.reads,['/ui.css','/ui.css.gz']);assert.equal(h.response.headers['Content-Encoding'],'gzip');
 h=queuedRead({'/ui.css':200},{asset:false});assert.equal(h.response.headers['Cache-Control'],'no-cache');
 h=queuedRead({'/ui.css':200},{condition:'"bytes"'});assert.equal(h.response.status,304);
});

test('OTA, missing files and snapshot failure are bounded errors, never a fallback to live settings or truncated assets',()=>{
 let h=queuedRead({'/ui.css':200},{ota:true});assert.deepEqual(h.reads,[]);assert.equal(h.replies[0].status,503);assert.deepEqual(h.barrier,[true,false]);
 h=queuedRead({});assert.equal(h.replies[0].status,404);assert.deepEqual(h.reads,['/ui.css','/ui.css.gz']);
 h=queuedRead({'/ui.css':503,'/ui.css.gz':200});assert.equal(h.replies[0].status,503);assert.deepEqual(h.reads,['/ui.css']);
 h=queuedRead({'/ui.css.gz':200},{asset:false});assert.equal(h.replies[0].status,404);assert.deepEqual(h.reads,['/ui.css']);
});


test('uploaded-logo directory reads use the same bounded Main/OTA handoff, never a network callback',()=>{
 let h=queuedRead({},{logoList:true});assert.deepEqual(h.reads,['directory']);assert.equal(h.replies[0],h.response);assert.deepEqual(h.barrier,[true,false]);
 h=queuedRead({},{logoList:true,ota:true});assert.deepEqual(h.reads,[]);assert.equal(h.replies[0].status,503);
 const marker=web.indexOf('server.on("/api/logos"'),route=body(web.slice(marker),'HTTP_GET');
 assert.match(route,/queueStoredFileRead\(request, nullptr\)/);assert.doesNotMatch(route,/visitFiles|LittleFS|prepareLogoListResponse/);
 assert.match(body(web,'static AsyncWebServerResponse* prepareLogoListResponse('),/ReadOnlyStorage::visitFiles/);
});
