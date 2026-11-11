const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/web/web_server.cpp'),'utf8');
const body=source.match(/^static bool commitLogoUpload\([^]*?^}/m)[0];
function harness({old=true,valid=true,renameOk=true}={}) {
 const files=new Map([['/new.upload','new'],['/logo.bak','stale']]);if(old)files.set('/logo','old');
 const operations=[];
 const c=vm.createContext({isPngFile:()=>valid,Publication:class{},LittleFS:{
  exists:p=>files.has(p), remove:p=>{operations.push(['remove',p]);return files.delete(p);},
  rename:(a,b)=>{operations.push(['rename',a,b]);if(!renameOk)return false;files.set(b,files.get(a));files.delete(a);return true;}
 },ArtworkCache:{instance:()=>({invalidateLcdThumbnail:p=>operations.push(['invalidate',p])})}});
 const js=body.slice(body.indexOf('{')).replace(/ArtworkRevision::Publication publication;/,'const publication=new Publication();')
  .replace('replaceFileWhenReadersClose(tempPath, targetPath)','LittleFS.rename(tempPath, targetPath)')
  .replace(/ReadOnlyStorage::exists\(LittleFS.mountpoint\(\), (\w+)\.c_str\(\)\)/g,'LittleFS.exists($1)')
  .replace(/\bString /g,'const ').replace(/\.length\(\)/g,'.length').replace(/::/g,'.');
 vm.runInContext('function commitLogoUpload(tempPath,targetPath,error)'+js,c);
 return {files,operations,commit:()=>c.commitLogoUpload('/new.upload','/logo','')};
}
test('replacement performs one atomic rename and invalidates only after the new durable file exists',()=>{
 const h=harness();assert.equal(h.commit(),true);assert.equal(h.files.get('/logo'),'new');
 assert.deepEqual(h.operations,[['rename','/new.upload','/logo'],['invalidate','/logo'],['remove','/logo.bak']]);
});
test('failed replacement leaves the existing logo and its thumbnail intact',()=>{
 const h=harness({renameOk:false});assert.equal(h.commit(),false);assert.equal(h.files.get('/logo'),'old');
 assert.equal(h.files.has('/new.upload'),false);assert.equal(h.files.get('/logo.bak'),'stale');
 assert.equal(h.operations.some(op=>op[0]==='invalidate'),false);
});
test('first upload commits without requiring an older logo and invalid uploads never replace it',()=>{
 const fresh=harness({old:false});assert.equal(fresh.commit(),true);assert.equal(fresh.files.get('/logo'),'new');
 const bad=harness({valid:false});assert.equal(bad.commit(),false);assert.equal(bad.files.get('/logo'),'old');
 assert.equal(bad.operations.some(op=>op[0]==='rename'),false);
});
