const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), test = require('node:test');
const source = fs.readFileSync(path.resolve(__dirname, '../../src/storage/atomic_file.cpp'), 'utf8');
const code = source.slice(source.indexOf('bool writeJsonAtomic(')).replace(/^bool writeJsonAtomic[^]*?\{/, '')
  .replace(/SR_PERF_SPAN\([^;]+;/g, '').replace(/String (target|temp|backup)\(([^)]+)\);/g, 'const $1 = $2;')
  .replace(/String (temp|backup) =/g, 'const $1 =')
  .replace('WriteOnlyStorage::File file(LittleFS.mountpoint(), temp.c_str());','const file=LittleFS.open(temp,"w");')
  .replace(/ReadOnlyStorage::exists\(LittleFS.mountpoint\(\), (\w+)\.c_str\(\)\)/g,'LittleFS.exists($1)')
  .replace('if (!file) return false;', 'if (!file.valid) return false;')
  .replace('BufferedWriter<WriteOnlyStorage::File> writer(file, yieldFlashWriter);', 'const writer = file.writer;')
  .replace('replaceFileWhenReadersClose(temp, target)','LittleFS.rename(temp, target)')
  .replace(/const bool /g,'const ')
  .replace(/size_t written =/g, 'const written =').replace(/bool complete =/g, 'let complete =');
const write = new Function('LittleFS', 'serializeJsonPretty', 'serializeJson', `return function(path,doc,pretty=false){${code}`);
function harness({short=false, flushShort=false, failSync=false, failClose=false, failRename=false, failOpen=false, crashAt=0}={}) {
  const files=new Map([['/config.json','old-valid'],['/config.json.bak','legacy-valid'],['/config.json.tmp','stale']]);
  const ops=[]; let step=0,bufferSize=0;
  const checkpoint=()=>{ if (++step===crashAt) throw Error('power-cut'); };
  const storage={
    exists:p=>files.has(p),
    remove:p=>{ops.push(['remove',p]);files.delete(p);checkpoint();return true;},
    open:(p,mode)=>{ops.push(['open',p,mode]);if(failOpen)return {valid:false};files.set(p,'');checkpoint();return {
      valid:true,setBufferSize:n=>{bufferSize=n;},
      writer:{flush:()=>!short},
      flush:()=>{if(flushShort)files.set(p,'partial');checkpoint();return !flushShort&&!failSync;},
      size:()=>files.get(p).length,close:()=>{checkpoint();return !failClose;},
    };},
    // The LittleFS API replaces an existing file in a single transaction.
    rename:(a,b)=>{ops.push(['rename',a,b]);assert.equal(files.get('/config.json'),'old-valid');
      if(failRename)return false;files.set(b,files.get(a));files.delete(a);checkpoint();return true;},
  };
  const serialize=doc=>{files.set('/config.json.tmp',short?'part':doc);checkpoint();return short?0:doc.length;};
  return {files,ops,run:()=>write(storage,serialize,serialize)('/config.json','new-valid',true)};
}
test('synced JSON replaces the existing target in one rename, then retires legacy backup',()=>{
  const h=harness();assert.equal(h.run(),true);assert.equal(h.files.get('/config.json'),'new-valid');
  assert.equal(h.files.has('/config.json.tmp'),false);assert.equal(h.files.has('/config.json.bak'),false);
  assert.deepEqual(h.ops.filter(x=>x[0]==='rename'),[['rename','/config.json.tmp','/config.json']]);
  assert.equal(h.ops.some(x=>x[0]==='remove'&&x[1]==='/config.json'),false);
});
for(const failure of ['short','flushShort','failSync','failClose','failRename','failOpen'])test(`${failure} preserves the prior target and legacy recovery copy`,()=>{
  const h=harness({[failure]:true});assert.equal(h.run(),false);
  assert.equal(h.files.get('/config.json'),'old-valid');assert.equal(h.files.get('/config.json.bak'),'legacy-valid');
});
test('interrupting each completed storage operation leaves either the old or new valid target',()=>{
  for(let i=1;i<=7;i++) {
    const h=harness({crashAt:i});try{h.run();}catch(e){assert.match(e.message,/power-cut/);}
    assert.ok(['old-valid','new-valid'].includes(h.files.get('/config.json')));
  }
});
