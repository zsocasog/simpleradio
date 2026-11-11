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
 assert.ok(process.indexOf('StoredFileResponse::create')<process.indexOf('storedReadInProgress.store(false)'));
 assert.ok(ota.indexOf('otaUploadActive = true')<ota.indexOf('while (storedReadInProgress.load())'));
 assert.ok(ota.indexOf('while (storedReadInProgress.load())')<ota.indexOf('LittleFS.end()'));
 assert.match(ota,/storedReadWaitStarted >= 1000U/);
 assert.match(web,/std::atomic<bool> otaUploadActive\{false\}/);
});
