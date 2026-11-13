const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const helper=fs.readFileSync(path.join(root,'src/web/tx_budget.h'),'utf8');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/web-tx-budget.json'),'utf8'));
function body(text,marker){const at=text.indexOf(marker);assert.ok(at>=0,marker);const start=text.indexOf('{',at);let depth=0;
 for(let i=start;i<text.length;++i){if(text[i]==='{')++depth;if(text[i]==='}'&&!--depth)return text.slice(start,i+1);}}
class Atomic {
 value=0;failures=0;
 load(){return this.value;}
 store(value){this.value=value;}
 fetch_add(n){const old=this.value;this.value+=n;return old;}
 compare_exchange_weak(expected,next){if(this.failures>0){--this.failures;return false;}if(this.value!==expected)return false;this.value=next;return true;}
}
const translate=code=>code.replace(/\bconst size_t /g,'const ').replace(/\bsize_t /g,'let ').replace(/\bused_/g,'this.used_');
const Budget=new Function('Atomic',`return class {
 used_=new Atomic();
 ${['used','reserve','charge','release'].map(name=>`${name}(${name==='reserve'?'wanted,limit':name==='charge'||name==='release'?'bytes':''})${translate(body(helper,name+'('))}`).join('\n')}
}`)(Atomic);
const memoryAllowance=new Function('wanted','freeDma','largestDma','mss','outstanding',body(helper,'responseTxMemoryAllowance(').replace(/(\d+)U/g,'$1'));
const audioSource=helper.split('class AudioHttpWindow {')[1].split('inline AudioHttpWindow&')[0];
const AudioWindow=new Function('Atomic',`return class {
 started_=new Atomic();active_=Object.assign(new Atomic(),{value:false});
 ${['begin','blocked'].map(n=>`${n}(now)${body(audioSource,n+'(uint32_t now)').replace(/\b(started_|active_)\b/g,'this.$1').replace('static_cast<uint32_t>(now - this.started_.load())','((now - this.started_.load()) >>> 0)').replace(/1500U/g,'1500')}`).join('\n')}
}`)(Atomic);
const queueSource=helper.split('class ResponseTxQueue {')[1].split('// A short header')[0];
const Queue=new Function(`return class {
 head_=null;tail_=null;
 front(){return this.head_;}
 ${['enter','remove'].map(n=>`${n}(turn)${body(queueSource,n+'(ResponseTxTurn* turn)').replace(/ResponseTxTurn\* previous/g,'let previous').replace(/auto\* current/g,'let current').replace(/nullptr/g,'null').replace(/->/g,'.').replace(/\b(head_|tail_)\b/g,'this.$1')}`).join('\n')}
}`)();
const gateSource=helper.split('class ResponseTxGate {')[1].split('class ResponseTxPermit')[0];
const Gate=new Function('Budget',`return class {
 holds_=new Budget();writers_=new Budget();
 ${['enter','leave','hold','release','quiet'].map(n=>`${n}()${body(gateSource,(['enter','quiet'].includes(n)?'bool ':'void ')+n+'()').replace(/\b(holds_|writers_)\b/g,'this.$1')}`).join('\n')}
}`)(Budget);
function harness(mss=1436,windowMss=mss){
 const sharedResponseTx=new Budget();
 const sharedResponseSlots=new Budget();
 const sharedResponseGate=new Gate();
 const sharedResponseQueue=new Queue();
 const audioWindow=new AudioWindow();let now=100;
 const pump = new Function('sharedResponseQueue',body(fixture.methods.pumpResponseTx,'{').replace(/\bunsigned attempt/g,'let attempt')
  .replace('std::shared_ptr<AsyncWebServerRequest> next;', 'let next;')
  .replace(/port(?:ENTER|EXIT)_CRITICAL\(&responseTurnMux\);/g,'')
  .replace('if (auto* turn = sharedResponseQueue.front())','const turn = sharedResponseQueue.front(); if (turn)')
  .replace('static_cast<AsyncWebServerRequest*>(turn->owner)->_this','turn.owner')
  .replace(/->/g,'.').replace('next.get()', 'next'));
 const memory={free:40000,largest:30000};
 const member=code=>{
  code=code.replace(/#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS[^]*?#endif/g,'');
  const permit=code.includes('ResponseTxPermit permit(sharedResponseGate);');
  code=code.replace('ResponseTxPermit permit(sharedResponseGate);','const permit={ok:sharedResponseGate.enter(),acquired(){return this.ok;}}; try {')
   .replace(/const (?:size_t|bool) /g,'const ').replace(/(\d+)U/g,'$1').replace(/std::min(?:<size_t>)?/g,'Math.min').replace(/\b(_responseTxBytes|_client|_responseNeedsFlush|_responseTurnBytes)\b/g,'this.$1')
   .replace(/port(?:ENTER|EXIT)_CRITICAL\(&responseTurnMux\);/g,'').replace(/&_responseTxTurn/g,'_responseTxTurn')
   .replace(/->/g,'.').replace(/nullptr/g,'null').replace(/\b_responseTxTurn\b/g,'this._responseTxTurn')
   .replace(/(?<![\w.])(releaseResponseBytes|releaseResponseTurn)\(/g,'this.$1(');
  return permit?code.slice(0,-1)+'} finally {if(permit.ok)sharedResponseGate.leave();} }':code;
 };
 const Request=new Function('sharedResponseTx','sharedResponseSlots','sharedResponseGate','sharedResponseQueue','responseAudioWindow','millis','SHARED_RESPONSE_TX_LIMIT','Budget',
  'responseTxMemoryAllowance','heap_caps_get_free_size','heap_caps_get_largest_free_block','MALLOC_CAP_INTERNAL','MALLOC_CAP_8BIT','MALLOC_CAP_DMA','CONFIG_LWIP_TCP_MSS','SIMPLE_RADIO_HTTP_SEGMENT_BYTES',`return class {
 _responseTxBytes=new Budget();_client={allowance:Infinity,getMss(){return SIMPLE_RADIO_HTTP_SEGMENT_BYTES;},canSend(){return this.allowance>0;},add(_data,n){return Math.min(n,this.allowance);}};
 _responseNeedsFlush=false;_responseTurnBytes=0;
 _responseTxTurn={waiting:false,next:null};
 sendResponse()${member(fixture.methods.sendResponse)}
 releaseResponseTurn()${member(fixture.methods.releaseResponseTurn)}
 releaseResponseBytes(length)${member(fixture.methods.releaseResponseBytes)}
 addToResponse(data,length)${member(fixture.methods.addToResponse)}
 }`)(sharedResponseTx,sharedResponseSlots,sharedResponseGate,sharedResponseQueue,()=>audioWindow,()=>now,4*windowMss,Budget,memoryAllowance,()=>memory.free,()=>memory.largest,1,2,4,windowMss,mss);
 return {shared:sharedResponseTx,slots:sharedResponseSlots,gate:sharedResponseGate,
  pump:()=>pump(sharedResponseQueue),
  audioWindow,setNow:value=>{now=value;},
  holds:{charge:()=>sharedResponseGate.hold(),release:()=>sharedResponseGate.release()},memory,request:()=>new Request()};
}

test('a cross-core hold waits for an already-entered writer and blocks all new writers',()=>{
 const g=new Gate();assert.equal(g.enter(),true);g.hold();assert.equal(g.quiet(),false);
 assert.equal(g.enter(),false);g.leave();assert.equal(g.quiet(),true);
 g.hold();g.release();assert.equal(g.enter(),false);g.release();assert.equal(g.enter(),true);g.leave();assert.equal(g.quiet(),true);
 const h=harness(),r=h.request();r._client.add=(_data,n)=>{h.gate.hold();assert.equal(h.gate.quiet(),false);return n;};
 assert.equal(r.addToResponse('',1000),1000);assert.equal(h.gate.quiet(),true);
 assert.equal(h.request().addToResponse('',1000),0);h.gate.release();r.releaseResponseBytes(Infinity);
 assert.equal(h.gate.quiet(),true);
});

test('audio startup pauses new payloads for a bounded interval, even through the millis rollover',()=>{
 const w=new AudioWindow();assert.equal(w.blocked(0),false);
 for(const start of [0,100,0xfffffc00,0xffffffff]){
  w.begin(start);assert.equal(w.blocked(start),true);
  assert.equal(w.blocked((start+1499)>>>0),true);assert.equal(w.blocked((start+1500)>>>0),false);
 }
 const h=harness(),r=h.request();h.audioWindow.begin(100);assert.equal(r.addToResponse('',100),0);
 h.setNow(1600);assert.equal(r.addToResponse('',100),100);
});
test('concurrent reservations and spurious CAS failures never exceed the byte limit',()=>{
 const b=new Budget();b.used_.failures=3;assert.equal(b.reserve(4000,5744),4000);
 assert.equal(b.reserve(4000,5744),1744);assert.equal(b.reserve(1,5744),0);
 assert.equal(b.used(),5744);assert.equal(b.release(6000),5744);assert.equal(b.release(1),0);
});
test('refused and partial real TCP writes refund only unused reservations',()=>{
 const h=harness(),a=h.request(),b=h.request();a._client.allowance=0;
 assert.equal(a.addToResponse('',2000),0);assert.equal(h.shared.used(),0);
 a._client.allowance=123;assert.equal(a.addToResponse('',2000),123);
 assert.equal(h.shared.used(),123);assert.equal(a._responseTxBytes.used(),123);
 assert.equal(b.addToResponse('',3000),1436);assert.equal(h.shared.used(),1559);
 a.releaseResponseBytes(100);assert.equal(h.shared.used(),1459);
 a.releaseResponseBytes(Infinity);assert.equal(h.shared.used(),1436);
 a.releaseResponseBytes(10000);assert.equal(h.shared.used(),1436);
 b.releaseResponseBytes(Infinity);assert.equal(h.shared.used(),0);
});
test('twelve clients share one bounded byte window until actual ACKs or disconnects',()=>{
 const h=harness(),requests=Array.from({length:12},()=>h.request());let seed=1;
 for(let i=0;i<1000;++i){seed=(seed*1664525+1013904223)>>>0;const r=requests[(seed>>>8)%12];
  if(seed&1)r.addToResponse('',Math.min(1436,Math.max(0,2872-r._responseTxBytes.used())));
  else r.releaseResponseBytes(seed%7===0?Infinity:431);
  assert.ok(h.shared.used()<=5744);assert.equal(requests.reduce((n,r)=>n+r._responseTxBytes.used(),0),h.shared.used());
  assert.ok(h.slots.used()<=2);assert.equal(requests.filter(r=>r._responseTxBytes.used()).length,h.slots.used());
 }
 for(const r of requests)r.releaseResponseBytes(Infinity);assert.equal(h.shared.used(),0);
});

test('tiny headers cannot bypass the two-owner limit, and failed first writes free their slot',()=>{
 const h=harness(),[a,b,c]=[h.request(),h.request(),h.request()];
 assert.equal(a.addToResponse('',100),100);assert.equal(b.addToResponse('',100),100);
 assert.equal(c.addToResponse('',100),0);assert.equal(h.slots.used(),2);assert.equal(h.shared.used(),200);
 a.releaseResponseBytes(100);c._client.allowance=0;assert.equal(c.addToResponse('',100),0);assert.equal(h.slots.used(),1);
 c._client.allowance=Infinity;assert.equal(c.addToResponse('',100),100);assert.equal(h.slots.used(),2);
 b.releaseResponseBytes(Infinity);c.releaseResponseBytes(Infinity);assert.equal(h.slots.used(),0);
});

test('continuous fresh file readers cannot overtake a waiting control response',()=>{
 const h=harness(),a=h.request(),b=h.request(),control=h.request(),fresh=h.request();
 a.addToResponse('',100);b.addToResponse('',100);assert.equal(control.addToResponse('',100),0);
 a.releaseResponseBytes(Infinity);assert.equal(fresh.addToResponse('',100),0);
 assert.equal(control.addToResponse('',100),100);
 b.releaseResponseBytes(Infinity);assert.equal(fresh.addToResponse('',100),100);
});

test('ACK handoff immediately starts waiting responses without waiting for their poll',()=>{
 const h=harness(),a=h.request(),b=h.request(),c=h.request(),d=h.request();
 a.addToResponse('',100);b.addToResponse('',100);
 for(const r of [c,d]){r._client.canSend=()=>true;r._response={_finished:()=>false,_ack:request=>request.addToResponse('',100)};r.addToResponse('',100);}
 a.releaseResponseBytes(Infinity);b.releaseResponseBytes(Infinity);h.pump();
 assert.equal(c._responseTxBytes.used(),100);assert.equal(d._responseTxBytes.used(),100);
 assert.equal(h.shared.used(),200);
});

test('a waiting client which loses its TCP window cannot block a ready control response',()=>{
 const h=harness(),a=h.request(),b=h.request(),slow=h.request(),ready=h.request();
 a.addToResponse('',100);b.addToResponse('',100);
 for(const r of [slow,ready]){r._response={_finished:()=>false,_ack:request=>request.addToResponse('',100)};r.addToResponse('',100);}
 slow._client.allowance=0;a.releaseResponseBytes(Infinity);b.releaseResponseBytes(Infinity);h.pump();
 assert.equal(ready._responseTxBytes.used(),100);assert.equal(slow._responseTxTurn.waiting,false);
 slow._client.allowance=Infinity;assert.equal(slow.addToResponse('',100),100);
});

test('abandoning the first waiting client releases its turn, including repeated cleanup',()=>{
 const h=harness(),a=h.request(),b=h.request(),abandoned=h.request(),next=h.request();
 a.addToResponse('',100);b.addToResponse('',100);
 abandoned.addToResponse('',100);next.addToResponse('',100);
 abandoned.releaseResponseTurn();abandoned.releaseResponseTurn();a.releaseResponseBytes(Infinity);
 assert.equal(next.addToResponse('',100),100);
});
test('production ownership releases on TCP ACK/disconnect, independently of the response object',()=>{
 assert.ok(fixture.methods._onAck.indexOf('releaseResponseBytes(len)')<fixture.methods._onAck.indexOf('_response->_ack('));
 assert.ok(fixture.methods._onDisconnect.indexOf('releaseResponseBytes(')<fixture.methods._onDisconnect.indexOf('_onDisconnectfn()'));
 const h=harness(),r=h.request();r.addToResponse('',1000);r.addToResponse('',1000);
 const response={finished:true};assert.ok(response.finished);assert.equal(h.shared.used(),2000);
 r.releaseResponseBytes(700);assert.equal(h.shared.used(),1300);r.releaseResponseBytes(Infinity);assert.equal(h.shared.used(),0);
});

test('a finished response retains its charge and connection until its last partial ACK',()=>{
 const h=harness(),r=h.request();r.addToResponse('',1436);r.addToResponse('',1364);
 r._response={_finished:()=>true};r._client.closed=false;r._client.close=function(){this.closed=true;};
 let code=fixture.methods._onAck.replace(/#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS[^]*?#endif/g,'').replace(/std::shared_ptr<AsyncWebServerRequest> self = _this;/,'')
  .replace(/->/g,'.').replace(/\b(_responseTxBytes|_client|_response)\b/g,'this.$1')
  .replace(/(?<![\w.])releaseResponseBytes\(/g,'this.releaseResponseBytes(');
 const call=(len)=>new Function('len','time','pumpResponseTx',code).call(r,len,0,h.pump);
 call(200);assert.equal(h.shared.used(),2600);assert.equal(r._client.closed,false);
 call(1200);assert.equal(h.shared.used(),1400);assert.equal(r._client.closed,false);
 call(1400);assert.equal(h.shared.used(),0);assert.equal(r._client.closed,true);
});

test('actual DMA headroom and a scoped save hold pause new sends without spending a slot',()=>{
 const h=harness(),r=h.request();h.memory.free=2500;
 assert.equal(r.addToResponse('',1000),0);assert.equal(h.slots.used(),0);
 h.memory.free=30000;h.memory.largest=1000;assert.equal(r.addToResponse('',1000),0);
 h.memory.largest=10000;h.holds.charge(1);h.holds.charge(1);
 assert.equal(r.addToResponse('',1000),0);h.holds.release(1);assert.equal(r.addToResponse('',1000),0);
 h.holds.release(1);assert.equal(r.addToResponse('',1000),1000);r.releaseResponseBytes(Infinity);
 assert.equal(h.shared.used(),0);assert.equal(h.slots.used(),0);
 assert.equal(memoryAllowance(4000,11575,10000,1436,1),0);
 assert.equal(memoryAllowance(4000,11576,10000,1436,1),1436);
 assert.equal(memoryAllowance(4000,10000,10000,1436,0),1436);
 assert.equal(memoryAllowance(4000,2971,10000,1436,0),0);
 assert.equal(memoryAllowance(4000,2972,10000,1436,0),1436);
 assert.equal(memoryAllowance(4000,3864,3316,536,0),536);
 assert.equal(memoryAllowance(4000,3864,3316,536,1),0);
});

test('low DMA reserve permits one drain packet and waits for its ACK before any next sender',()=>{
 const h=harness(),a=h.request(),b=h.request();h.memory.free=9000;
 assert.equal(a.addToResponse('',1000),1000);assert.equal(a.addToResponse('',1000),0);
 assert.equal(b.addToResponse('',1000),0);a.releaseResponseBytes(999);
 assert.equal(b.addToResponse('',1000),0);a.releaseResponseBytes(1);
 assert.equal(b.addToResponse('',1000),1000);b.releaseResponseBytes(Infinity);
 assert.equal(h.shared.used(),0);assert.equal(h.slots.used(),0);
});

test('small TCP allocations retain a full byte window for the peer while draining fragmented RAM',()=>{
 const h=harness(536,1436),a=h.request(),b=h.request();h.memory.free=11032;h.memory.largest=1588;
 for(const r of [a,b]){for(let i=0;i<5;i++)assert.equal(r.addToResponse('',5000),536);assert.equal(r.addToResponse('',5000),192);assert.equal(r.addToResponse('',1),0);}
 assert.equal(h.shared.used(),5744);a.releaseResponseBytes(Infinity);b.releaseResponseBytes(Infinity);assert.equal(h.shared.used(),0);
});
test('a waiting control reply gets a turn after one byte-window burst instead of the entire image',()=>{
 const h=harness(),image=h.request(),other=h.request(),control=h.request();
 image.addToResponse('',1436);image.addToResponse('',1436);other.addToResponse('',1436);
 control._response={_finished:()=>false,_ack:r=>r.addToResponse('',100)};control.addToResponse('',100);
 image.releaseResponseBytes(1436);assert.equal(image.addToResponse('',1436),0);
 image.releaseResponseBytes(1436);h.pump();assert.equal(control._responseTxBytes.used(),100);
});
