const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test');
const app=fs.readFileSync(path.resolve(__dirname,'../../data/app.js'),'utf8');
function browser(playing=true){
 const pending=[],requests=[],timers=new Map();let serial=0;
 const c=vm.createContext({playing,now:0,Date:{now:()=>c.now},remoteUrl:u=>/^https?:/.test(u),
  setTimeout(fn){timers.set(++serial,fn);return serial;},clearTimeout(id){timers.delete(id);},
  Image:class {set src(url){if(url){requests.push(url);pending.push({url,image:this});}}}});
 vm.runInContext(app.slice(app.indexOf('const artworkImageRequests ='),app.indexOf('\nfunction applyArtworkNode(')),c);
 return {c,pending,requests,timers,active:()=>vm.runInContext('artworkImagesActive',c),size:()=>vm.runInContext('artworkImageRequests.size',c),
  finish(url,ok=true){const at=pending.findIndex(p=>p.url===url);assert.ok(at>=0,url);const {image}=pending.splice(at,1)[0];image[ok?'onload':'onerror']();return image;}};
}
test('playing admits one local image; public images do not consume ESP slots and all queued logos eventually load',async()=>{
 const h=browser(),local=Array.from({length:6},(_,i)=>'/logo'+i),jobs=local.map(u=>h.c.artworkImageReady(u));
 const external=h.c.artworkImageReady('https://public.example/logo');assert.equal(h.requests.length,2);assert.equal(h.active(),1);
 h.finish('https://public.example/logo');for(const u of local){assert.equal(h.active(),1);h.finish(u);}
 assert.deepEqual(await Promise.all([...jobs,external]),Array(7).fill(true));assert.equal(h.active(),0);
 assert.equal(h.requests.filter(u=>u.startsWith('/')).length,6);
});
test('idle permits two; starting playback keeps existing requests but admits only one afterwards',async()=>{
 const h=browser(false),jobs=['/a','/b','/c'].map(u=>h.c.artworkImageReady(u));assert.equal(h.active(),2);
 h.c.playing=true;h.finish('/a');assert.equal(h.requests.length,2);h.finish('/b');assert.equal(h.requests.length,3);
 assert.equal(h.active(),1);h.finish('/c');assert.deepEqual(await Promise.all(jobs),[true,true,true]);
});
test('queue time does not start an image timeout or permit duplicate pending URLs',async()=>{
 const h=browser(),a=h.c.artworkImageReady('/a'),b=h.c.artworkImageReady('/b');
 assert.equal(h.timers.size,1);h.c.now=20000;assert.equal(h.c.artworkImageReady('/b'),b);
 const timeout=[...h.timers.values()][0];timeout();assert.equal(h.requests.length,2);assert.equal(h.timers.size,1);
 h.finish('/b');assert.deepEqual(await Promise.all([a,b]),[false,true]);
 const old=h.pending.find(x=>x.url==='/a');old.image.onerror();assert.equal(h.active(),0);
});
test('removed rows are skipped before admission; another live consumer still shares the same request',async()=>{
 const h=browser();const a=h.c.artworkImageReady('/a');let wanted=true;
 const stale=h.c.artworkImageReady('/removed',()=>wanted),shared=h.c.artworkImageReady('/shared',()=>false);
 assert.equal(h.c.artworkImageReady('/shared',()=>true),shared);wanted=false;h.finish('/a');
 assert.deepEqual(h.requests,['/a','/shared']);h.finish('/shared');
 assert.deepEqual(await Promise.all([a,stale,shared]),[true,false,true]);
 const fresh=h.c.artworkImageReady('/removed');h.finish('/removed');assert.equal(await fresh,true);
});
test('large lists retain in-flight deduplication and trim completed browser cache entries to 96',async()=>{
 const h=browser(),urls=Array.from({length:101},(_,i)=>'/tile'+i),jobs=urls.map(u=>h.c.artworkImageReady(u));
 assert.equal(h.c.artworkImageReady('/tile0'),jobs[0]);for(const u of urls)h.finish(u);
 assert.ok((await Promise.all(jobs)).every(Boolean));assert.equal(h.size(),96);assert.equal(h.requests.length,101);
});
