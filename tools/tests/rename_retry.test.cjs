const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),src=fs.readFileSync(path.join(root,'src/storage/rename_retry.h'),'utf8');
const begin=src.indexOf('{',src.indexOf('bool retryBusy('));
const code=src.slice(begin,src.lastIndexOf('\n}')).replace('const uint32_t started','const started')
 .replace('static_cast<uint32_t>(clock() - started)','((clock() - started) >>> 0)').replace(/\berrno\b/g,'io.errno');
const retry=new Function('io','EBUSY','rename','clock','pause','limitMs',code);
test('an open reader may finish before one atomic rename; unrelated I/O failures never retry',()=>{
 let now=0,attempts=0,pauses=0;const io={errno:0};
 const rename=()=>{attempts++;if(attempts<3){io.errno=16;return false;}return true;};
 assert.equal(retry(io,16,rename,()=>now,()=>{pauses++;now+=5;},1500),true);assert.equal(pauses,2);assert.equal(attempts,3);
 attempts=0;assert.equal(retry(io,16,()=>{attempts++;io.errno=5;return false;},()=>now,()=>{throw Error('must not wait');},1500),false);assert.equal(attempts,1);
});
test('permanent busy readers have a bounded deadline, including a clock wrap',()=>{
 for(const start of [0,0xfffffff0]){let now=start,pauses=0;const io={errno:0};
  assert.equal(retry(io,16,()=>{io.errno=16;return false;},()=>now,()=>{pauses++;now=(now+10)>>>0;},50),false);assert.equal(pauses,5);}
});
test('both JSON commits and logo replacements use the same bounded helper after closing the temporary writer',()=>{
 const atomic=fs.readFileSync(path.join(root,'src/storage/atomic_file.cpp'),'utf8'),web=fs.readFileSync(path.join(root,'src/web/web_server.cpp'),'utf8');
 assert.match(atomic,/replaceFileWhenReadersClose\(temp, target\)/);assert.match(web,/replaceFileWhenReadersClose\(tempPath, targetPath\)/);
 assert.ok(atomic.indexOf('const bool closed = file.close()')<atomic.indexOf('if (!replaceFileWhenReadersClose(temp, target))'));
 assert.match(atomic,/\[\] \{ vTaskDelay\(1\); \}, 1500/);
});
