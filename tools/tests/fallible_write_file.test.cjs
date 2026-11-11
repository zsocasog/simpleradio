const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),src=fs.readFileSync(path.join(root,'src/storage/write_only_file.h'),'utf8');
function body(s,marker){const b=s.indexOf('{',s.indexOf(marker));let depth=0;for(let i=b;i<s.length;i++){if(s[i]==='{')depth++;if(s[i]==='}'&&!--depth)return s.slice(b,i+1);}throw Error(marker);}
function file({writes=[],sync=[],closeOk=true,valid=true}={}){
 let error=0,closed=0;const bytes=[];
 const js=s=>s.replace('size_t done = 0;','let done=0;').replace('const ssize_t count','const count').replace('int result;','let result;')
  .replace('::write(fd_, data + done, length - done)','io.write(fd_, data.subarray(done), length-done)')
  .replace(/::fsync/g,'io.sync').replace(/::close/g,'io.close').replace(/\b(fd_|failed_)\b/g,'this.$1').replace(/\berrno\b/g,'io.error()');
 const io={write(fd,data,n){assert.equal(fd,7);const item=writes.length?writes.shift():n;if(item<0){error=-item;return -1;}const count=Math.min(item,n);bytes.push(...data.subarray(0,count));return count;},
  sync(fd){assert.equal(fd,7);const item=sync.length?sync.shift():0;error=-item;return item<0?-1:0;},
  close(fd){assert.equal(fd,7);closed++;return closeOk?0:-1;},error:()=>error};
 const f={fd_:valid?7:-1,failed_:false};
 for(const [name,marker,args] of [['write','size_t write(',['data','length']],['flush','bool flush(',[]],['close','bool close(',[]]])
  f[name]=new Function('io','EINTR',...args,js(body(src,marker))).bind(f,io,4);
 return {f,bytes,closed:()=>closed};
}
test('partial writes and EINTR preserve every byte without allocating a FILE buffer',()=>{
 const h=file({writes:[3,-4,2,8]}),input=Buffer.from('abcdefghi');assert.equal(h.f.write(input,input.length),input.length);
 assert.deepEqual(Buffer.from(h.bytes),input);assert.equal(h.f.flush(),true);assert.equal(h.f.close(),true);h.f.close();assert.equal(h.closed(),1);
 assert.doesNotMatch(src.replace(/\/\/[^\n]*/g,''),/fopen\(|malloc\(|new |xTaskCreate/);
});
test('invalid descriptors, zero writes and ENOSPC fail without spinning or accepting subsequent data',()=>{
 assert.equal(file({valid:false}).f.write(Buffer.alloc(3),3),0);
 for(const plan of [[0],[2,-28]]){const h=file({writes:plan}),data=Buffer.alloc(8,3);assert.ok(h.f.write(data,8)<8);
  assert.equal(h.f.write(data,8),0);assert.equal(h.f.flush(),false);assert.equal(h.f.close(),false);assert.equal(h.closed(),1);}
});
test('sync retries EINTR, while real sync/close failures prevent an atomic commit',()=>{
 assert.equal(file({sync:[-4,0]}).f.flush(),true);assert.equal(file({sync:[-5]}).f.flush(),false);
 assert.equal(file({closeOk:false}).f.close(),false);
 const atomic=fs.readFileSync(path.join(root,'src/storage/atomic_file.cpp'),'utf8');const write=body(atomic,'bool writeJsonAtomic(');
 assert.match(write,/complete = complete && synced/);assert.match(write,/complete = complete && closed/);
 assert.doesNotMatch(write,/LittleFS.open|LittleFS.exists|setBufferSize/);
});
test('runtime logo checks and cache probes never allocate newlib FILE streams just to test existence',()=>{
 const web=fs.readFileSync(path.join(root,'src/web/web_server.cpp'),'utf8'),cache=fs.readFileSync(path.join(root,'src/artwork/artwork_cache.cpp'),'utf8');
 assert.doesNotMatch(web,/LittleFS.exists\(/);assert.doesNotMatch(cache,/LittleFS.exists\(/);
 assert.match(body(web,'static bool storeStationLogo('),/WriteOnlyStorage::File/);
 assert.match(body(web,'static bool isPngFile('),/ReadOnlyStorage::File/);
});
