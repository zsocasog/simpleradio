const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/artwork/lcd_thumbnail_ram.cpp'),'utf8');
function body(marker){const start=source.indexOf('{',source.indexOf(marker));assert.ok(start>=0,marker);let depth=0;
 for(let i=start;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&!--depth)return source.slice(start,i+1);}throw Error(marker);}
function translate(code){return code
 .replace(/port(?:ENTER|EXIT)_CRITICAL\(&mux\);/g,'')
 .replace(/Block\* old\[Slots\]\{\};/g,'const old=Array(Slots).fill(null);')
 .replace(/Block\* old = nullptr;/g,'let old=null;')
 .replace(/Lease result;/g,'const result={slot_:-1,data_:null,bytes_:0,modified_:0};')
 .replace(/auto\* next = static_cast<Block\*>\(heap_caps_malloc\(allocation, MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT\)\);/g,'const next=allocate(allocation);')
 .replace(/const uint8_t header\[8\] = ([^;]+);/g,(_,v)=>'const header=Uint8Array.from('+v.replace('{','[').replace('}',']')+');')
 .replace(/sizeof\(Block::path\)/g,'96').replace(/offsetof\(Block, data\)/g,'128').replace(/sizeof\(header\)/g,'8')
 .replace(/static_cast<time_t>\(sequence\)/g,'sequence').replace(/static_cast<int>\(i\)/g,'i')
 .replace(/uint8_t\(([^)]+)\)/g,'($1 & 255)').replace(/\bint\(i\)/g,'i')
 .replace(/heap_caps_get_free_size\(MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT\)/g,'freeBytes')
 .replace(/for \(auto& slot : slots\)/g,'for (const slot of slots)').replace(/for \(auto\* block : old\)/g,'for (const block of old)')
 .replace(/auto& slot =/g,'const slot =').replace(/const size_t /g,'const ').replace(/size_t i/g,'let i').replace(/int chosen/g,'let chosen')
 .replace(/Slot\{next, \+\+clock, 0, true\}/g,'({block:next,used:++clock,readers:0,visible:true})')
 .replace(/slot = Slot\(\)/g,'slots[index]={block:null,readers:0,used:0,visible:false}')
 .replace(/nullptr/g,'null').replace(/->/g,'.').replace(/strlen\(path\)/g,'path.length').replace(/!\*path/g,'!path.length')
 .replace(/'([SR56])'/g,(_,c)=>c.charCodeAt(0))
 .replace(/strcpy\(next.path, path\)/g,'next.path=path')
 .replace(/memcpy\(next.data, header, 8\)/g,'next.data.set(header)')
 .replace(/memcpy\(next.data \+ 8, pixels, bytes - 8\)/g,'next.data.set(pixels.subarray(0,bytes-8),8)');}
function harness({freeBytes=8*1024*1024,failAllocation=false}={}){
 const live=new Set();let peak=0;
 const allocate=n=>{if(failAllocation)return null;const b={data:new Uint8Array(n-128)};live.add(b);peak=Math.max(peak,live.size);return b;};
 const releaseBlock=b=>{if(b)assert.ok(live.delete(b),'each frame freed once and only after its last reader');};
 let retire=translate(body('void retire(')).replace(/slots\[index\]/g,'slots[i]');
 const api=new Function('allocate','free','freeBytes',`const Slots=8,MaxSide=176;let sequence=0,clock=0;
 const slots=Array.from({length:Slots},()=>({block:null,readers:0,used:0,visible:false}));
 const strcmp=(a,b)=>a===b?0:1;function matches(slot,path)${translate(body('bool matches('))}
 function release(index)${translate(body('void release('))}
 function acquire(path)${translate(body('Lease acquire('))}
 function publish(path,pixels,side)${translate(body('bool publish('))}
 function retire(path)${retire}
 return {acquire,publish,retire,release};`)(allocate,releaseBlock,freeBytes);
 return {...api,live,peak:()=>peak};
}
const pixels=n=>Uint8Array.from({length:n*n*2},(_,i)=>i%251);
test('SR56 publication preserves exact wire-order pixels and geometry',()=>{
 const h=harness(),p=pixels(176);assert.equal(h.publish('/cache/a.sr565',p,176),true);
 const frame=h.acquire('/cache/a.sr565');assert.ok(frame.slot_>=0);assert.equal(frame.bytes_,8+p.length);
 assert.deepEqual([...frame.data_.subarray(0,8)],[83,82,53,54,176,0,176,0]);assert.deepEqual(frame.data_.subarray(8,frame.bytes_),p);
 h.release(frame.slot_);h.retire('/cache/a.sr565');assert.equal(h.live.size,0);
});
test('replacement and retirement retain old readers, expose only new pixels, and free after release',()=>{
 const h=harness(),a=pixels(2),b=new Uint8Array(8).fill(99);
 h.publish('/cache/a',a,2);const first=h.acquire('/cache/a');h.publish('/cache/a',b,2);const second=h.acquire('/cache/a');
 assert.notEqual(first.modified_,second.modified_);assert.deepEqual(first.data_.subarray(8,16),a);assert.deepEqual(second.data_.subarray(8,16),b);
 h.retire('/cache/a');assert.equal(h.acquire('/cache/a').slot_,-1);assert.equal(h.live.size,2);
 h.release(first.slot_);assert.equal(h.live.size,1);h.release(second.slot_);assert.equal(h.live.size,0);
});
test('all eight leased slots fail closed without orphan frames or overwriting readers',()=>{
 const h=harness(),leases=[];
 for(let i=0;i<8;i++){assert.equal(h.publish('/cache/'+i,pixels(2),2),true);leases.push(h.acquire('/cache/'+i));}
 for(let i=0;i<20;i++)assert.equal(h.publish('/cache/overflow',pixels(2),2),false);
 assert.equal(h.live.size,8);assert.equal(h.peak(),9,'only one unpublished preparation beyond the eight retained slots');
 h.release(leases.shift().slot_);assert.equal(h.publish('/cache/overflow',pixels(2),2),true);assert.equal(h.acquire('/cache/0').slot_,-1);
});
test('least-recently-used unleased frames can be rebuilt, while active readers remain pinned',()=>{
 const h=harness();for(let i=0;i<8;i++)h.publish('/cache/'+i,pixels(2),2);
 const pinned=h.acquire('/cache/0'),recent=h.acquire('/cache/1');h.release(recent.slot_);
 h.publish('/cache/next',pixels(2),2);assert.equal(h.acquire('/cache/2').slot_,-1);
 assert.ok(h.acquire('/cache/1').slot_>=0);assert.ok(h.acquire('/cache/0').slot_>=0);h.release(pinned.slot_);
});
test('allocation pressure and invalid geometry do not consume any cache slot',()=>{
 for(const options of [{freeBytes:512*1024},{failAllocation:true}]){const h=harness(options);assert.equal(h.publish('/a',pixels(2),2),false);assert.equal(h.live.size,0);}
 const h=harness();for(const [p,side] of [['',2],['x'.repeat(96),2],['/a',0],['/a',177]])assert.equal(h.publish(p,pixels(2),side),false);
 assert.equal(h.live.size,0);
});
