const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),src=fs.readFileSync(path.join(root,'src/state/persisted_controls.h'),'utf8');
function body(marker){const at=src.indexOf('{',src.indexOf(marker));let n=0;for(let i=at;i<src.length;i++){if(src[i]==='{')n++;if(src[i]==='}'&&!--n)return src.slice(at,i+1);}throw Error(marker);}
const fields=['stationId','volume','playing','eqLow','eqMid','eqHigh','balance'];
const same=new Function('other',body('bool operator==').replace(new RegExp('(?<![.\\w])('+fields.join('|')+')\\b','g'),'this.$1'));
const save=new Function('same','value','filePresent','write',body('template<class Writer> bool save(')
 .replace(/\b(known_|last_)\b/g,'this.$1').replace('this.last_ == value','same.call(this.last_, value)').replace('this.last_ = value','this.last_ = {...value}'));
function cache(){const c={known_:false,last_:{}};return (v,present,writer)=>save.call(c,same,v,present,writer);}
const value={stationId:5,volume:1,playing:true,eqLow:0,eqMid:0,eqHigh:0,balance:0};
test('identical durable controls skip the write, while every persisted field still triggers a real commit',()=>{
 const c=cache();let writes=0;const write=()=>{writes++;return true;};assert.equal(c(value,true,write),true);assert.equal(writes,1);
 assert.equal(c({...value},true,write),true);assert.equal(writes,1);
 for(const field of fields){const v={...value,[field]:field==='playing'?false:value[field]+1};assert.equal(c(v,true,write),true);assert.equal(writes,2);c(value,true,write);writes=1;}
});
test('missing files, reboot and failed writes cannot be mistaken for a durable cached state',()=>{
 const c=cache();let writes=0;const good=()=>{writes++;return true;},bad=()=>{writes++;return false;};
 c(value,true,good);c(value,false,good);assert.equal(writes,2);
 const changed={...value,stationId:6};assert.equal(c(changed,true,bad),false);assert.equal(c(changed,true,good),true);assert.equal(writes,4);
 assert.equal(c({...changed},true,bad),true);assert.equal(writes,4);
 assert.equal(cache()(changed,true,good),true);assert.equal(writes,5);
});
test('only serialized control fields are deduplicated; metadata stays live and PSRAM allocation failure prevents publication',()=>{
 const cpp=fs.readFileSync(path.join(root,'src/state/state_storage.cpp'),'utf8');
 assert.match(cpp,/ReadOnlyStorage::exists\(LittleFS.mountpoint\(\), "\/state.json"\)/);
 assert.match(cpp,/persisted_\.invalidate\(\)/);assert.match(cpp,/ArtworkJson::Allocator allocator/);
 assert.match(cpp,/return !doc.overflowed\(\) && writeJsonAtomic/);
 assert.doesNotMatch(src,/artist|title|logo|String|malloc|new /);
});
