const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./fixtures/web-response-backpressure-3.12.1.json');
const dependency = path.resolve(__dirname, '../../.pio/libdeps/esp32-s3-devkitc1-n16r8/ESPAsyncWebServer/src/WebResponses.cpp');

function method(source, type='AsyncAbstractResponse') {
  const start = source.indexOf('{', source.indexOf('size_t '+type+'::write_send_buffs('));
  let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error('Response method missing');
}

function enabledBranches(code) {
  let enabled = true;
  const stack = [];
  return code.split('\n').filter(line => {
    if (line.startsWith('#if')) { stack.push(enabled); return !(enabled = enabled && true); }
    if (line.startsWith('#else')) { enabled = !enabled && stack.at(-1); return false; }
    if (line.startsWith('#endif')) { enabled = stack.pop(); return false; }
    return enabled;
  }).join('\n');
}

function compile(code) {
  // Execute the pinned production state machine; translate C++ syntax only.
  code = enabledBranches(code)
    .replace(/\(void\)time;/g, '')
    .replace(/void\* memory = [^;]+;/g, '')
    .replace(/auto\* p = memory \? new \(memory\) SendBuffer : nullptr;/g, 'let p = makeBuffer();')
    .replace(/size_t payloadlen\{0\};/g, 'let payloadlen = 0;')
    .replace(/size_t const |const size_t /g, 'const ')
    .replace(/size_t |auto /g, 'let ')
    .replace(/static constexpr char hexChars\[\]/g, 'const hexChars')
    .replace(/reinterpret_cast<char \*>\(/g, '(')
    .replace(/request->client\(\)->/g, 'request.client().')
    .replace(/request->addToResponse\(/g,'request.addToResponse(')
    .replace(/request->sendResponse\(/g,'request.sendResponse(')
    .replace(/_content\.c_str\(\) \+ _sentLength/g,'source.subarray(_sentLength)')
    .replace(/_assembled_headers\.c_str\(\) \+ _writtenHeadersLength/g,
      'new TextEncoder().encode(_assembled_headers).subarray(_writtenHeadersLength)')
    .replace(/_assembled_headers\.length\(\)/g, '_assembled_headers.length')
    .replace(/_send_buffer->data\(\) \+ ([A-Za-z0-9_]+)/g, '_send_buffer.bytes.subarray($1)')
    .replace(/_send_buffer->data\(\)/g, '_send_buffer.bytes')
    .replace(/_send_buffer->size\(\)/g, '_send_buffer.bytes.length')
    .replace(/_send_buffer->at\(([^)]+)\)/g, '_send_buffer.bytes[$1]')
    .replace(/_send_buffer\.reset\(p\)/g, '(_send_buffer = p)')
    .replace(/_send_buffer\.reset\(\)/g, '(_send_buffer = null)')
    .replace(/std::min/g, 'Math.min').replace(/String\(\)/g, "''")
    .replace(/nullptr/g, 'null');
  return new Function('request', 'len', 'time', `with(this) ${code}`);
}

function context(code, { bytes=15000, chunked=false, allowance=Infinity, factoryFailures=0, shared=null }={}) {
  const c = { RESPONSE_FAILED:5, RESPONSE_END:4, RESPONSE_WAIT_ACK:3, RESPONSE_CONTENT:2, RESPONSE_HEADERS:1,
    RESPONSE_TRY_AGAIN:0xffffffff, CONFIG_LWIP_TCP_WND_DEFAULT:5760, CONFIG_LWIP_TCP_MSS:1436,
    ASYNC_RESPONCE_BUFF_SIZE:2872, _state:2, _source_eof:false, _chunked:chunked,
    _sendContentLength:!chunked, _contentLength:chunked?0:bytes, _sentLength:0, _ackedLength:0,
    _writtenLength:0, _writtenHeadersLength:0, _assembled_headers:'', _in_flight:0, _in_flight_credit:2,
    _send_buffer:null, _send_buffer_len:0, _send_buffer_offset:0, readOffset:0, fillCalls:0,
    _sourceValid:()=>true, source:Uint8Array.from({length:bytes},(_,i)=>i%251),
    makeBuffer:()=>factoryFailures-- > 0 ? null : {bytes:new Uint8Array(2872)} };
  c._content={length:()=>bytes};
  c._fillBufferAndProcessTemplates = (out, max) => {
    ++c.fillCalls;
    const n = Math.min(max, c.source.length-c.readOffset);
    out.set(c.source.subarray(c.readOffset,c.readOffset+n)); c.readOffset+=n;return n;
  };
  const client = {wire:[], queued:0, allowance, closed:false, maxAdd:Infinity,
    space(){return Math.max(0,5744-this.queued);},
    add(data,count){const n=Math.min(count,this.space(),this.allowance,this.maxAdd);
      this.wire.push(...data.subarray(0,n));this.queued+=n;this.allowance-=n;return n;},
    flushCalls:0,sendFailures:0,transmitted:0,
    send(){++this.flushCalls;if(this.sendFailures>0){--this.sendFailures;return false;}this.transmitted=this.wire.length;return true;}, close(){this.closed=true;} };
  const request = {client:()=>client,sendResponse:()=>client.send(),addToResponse:(data,count)=>{
    if(shared?.active && !shared.active.has(client) && shared.active.size>=2)return 0;
    const n=client.add(data,shared?Math.min(count,shared.available,2872-client.queued):count);
    if(shared)shared.available-=n;if(n){shared?.active?.add(client);request._responseNeedsFlush=true;}return n;
  }};
  const run = compile(code);
  return {c,client,request,tick:(acked=0)=>run.call(c,request,acked,0)};
}

test('a refused flush is retried by the real request poll even with a full response window',()=>{
 const methods=require('./fixtures/web-tx-budget.json').methods;
 const h=context(installed,{bytes:15000}),r=h.request;
 Object.assign(r,{_client:h.client,_responseNeedsFlush:false,_deferredResponse:{exchange:()=>null},_response:{_ack:()=>h.tick()}});
 h.client.canSend=()=>h.client.space()>0;
 const send=methods.sendResponse.replace(/#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS[^]*?#endif/g,'').replace(/const bool /g,'const ').replace(/->/g,'.');
 r.sendResponse=new Function(`with(this) ${send}`);
 const poll=methods._onPoll.replace(/#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS[^]*?#endif/g,'').replace(/std::shared_ptr<AsyncWebServerRequest> self = _this;/,'')
  .replace(/if \(auto \*pending = _deferredResponse.exchange\(nullptr, std::memory_order_acq_rel\)\)/,'const pending = _deferredResponse.exchange(); if(pending)')
  .replace(/->/g,'.');
 const tickPoll=new Function('pumpResponseTx',`with(this) ${poll}`).bind(r,()=>{});
 h.client.sendFailures=1;h.tick();assert.equal(h.client.transmitted,0);assert.equal(r._responseNeedsFlush,true);
 h.tick();assert.equal(h.client.transmitted,0,'A full response window cannot flush through its writer');
 tickPoll.call(r);assert.equal(h.client.transmitted,2872);assert.equal(r._responseNeedsFlush,false);
 const calls=h.client.flushCalls;tickPoll.call(r);assert.equal(h.client.flushCalls,calls,'A successful flush must not be resent/reset its ACK timer on every poll');
 finish(h);
});

test('bounded positive writes fill the byte window before waiting for a real ACK',()=>{
 const h=context(installed,{bytes:15000});h.client.maxAdd=536;h.tick();
 assert.equal(h.client.queued,2872);assert.equal(h.client.transmitted,2872);
 assert.deepEqual(Uint8Array.from(h.client.wire),h.c.source.subarray(0,2872));finish(h);
 assert.deepEqual(Uint8Array.from(h.client.wire),h.c.source);
});

function finish(h) {
  h.client.allowance=Infinity;h.client.maxAdd=Infinity;
  for(let i=0;i<100 && h.c._state!==4;++i) {
    const ack=h.client.queued;h.client.queued=0;h.tick(ack);
  }
  assert.equal(h.c._state,4,'Response did not finish');
  assert.equal(h.c._send_buffer_len,0,'Response ended with unsent bytes');
}

const installed = fs.existsSync(dependency) ? method(fs.readFileSync(dependency,'utf8')) : fixture.patched;
const basicInstalled=fs.existsSync(dependency)?method(fs.readFileSync(dependency,'utf8'),'AsyncBasicResponse'):fixture.basicPatched;

test('basic JSON and file responses share the same bounded real-ACK window',()=>{
  assert.equal(basicInstalled,fixture.basicPatched);
  const shared={available:5744,active:new Set()};
  const all=Array.from({length:12},(_,i)=>{
    const h=context(i%2?basicInstalled:installed,{bytes:12000+i,shared});
    Object.assign(h.c,{_state:1,_assembled_headers:'H'.repeat(200)});return h;
  });
  for(let round=0;round<2000&&all.some(h=>h.c._state!==4||h.client.queued);++round){
    for(const h of all){
      const ack=Math.min(431,h.client.queued);h.client.queued-=ack;shared.available+=ack;
      if(!h.client.queued)shared.active.delete(h.client);
      if(h.c._state!==4)h.tick(ack);
      assert.equal(h.client.closed,false);
      assert.ok(h.client.queued<=2872);
      assert.ok(shared.active.size<=2);
      assert.equal(all.reduce((n,r)=>n+r.client.queued,0),5744-shared.available);
    }
  }
  assert.equal(shared.available,5744);
  for(const h of all){assert.equal(h.c._state,4);assert.deepEqual(Uint8Array.from(h.client.wire.slice(200)),h.c.source);}
});

test('zero-content basic replies still flush headers and retry a closed admission window',()=>{
  const shared={available:0},h=context(basicInstalled,{bytes:0,shared});
  Object.assign(h.c,{_state:1,_assembled_headers:'H'.repeat(200)});
  h.tick();assert.equal(h.c._state,1);assert.equal(h.client.closed,false);
  shared.available=5744;h.tick();assert.equal(h.c._state,4);assert.equal(h.client.wire.length,200);
});

test('fixture matches the production response writer when installed',()=>{
  assert.equal(installed,fixture.patched);
});

test('reproduce pinned upstream early completion on a partial final TCP write',()=>{
  const h=context(fixture.original,{bytes:1000,allowance:200});h.tick();
  assert.equal(h.c._state,4);assert.equal(h.c._send_buffer_len,1000);
  assert.equal(h.client.wire.length,200);
});

test('reproduce pinned upstream permanent credit loss after zero-byte writes',()=>{
  const h=context(fixture.original,{allowance:0});
  Object.assign(h.c,{_sentLength:8000,_contentLength:15000,_in_flight_credit:1});h.tick();h.tick();
  assert.equal(h.c._in_flight_credit,0);h.client.allowance=Infinity;h.tick();
  assert.equal(h.client.wire.length,0);
});

test('final partial writes retain the response until every byte is queued',()=>{
  const h=context(installed,{bytes:1000,allowance:200});h.tick();
  assert.equal(h.c._state,2);assert.equal(h.c._writtenLength,200);
  const ack=h.client.queued;h.client.queued=0;h.client.allowance=Infinity;h.tick(ack);
  finish(h);assert.deepEqual(Uint8Array.from(h.client.wire),h.c.source);
});

test('zero-byte writes preserve credit and recover on a later poll',()=>{
  const h=context(installed,{allowance:0});
  Object.assign(h.c,{_sentLength:8000,_contentLength:15000,_in_flight_credit:1,
                    readOffset:8000});h.tick();h.tick();
  assert.equal(h.c._in_flight_credit,1);finish(h);
  assert.deepEqual(Uint8Array.from(h.client.wire),h.c.source.subarray(8000));
});

test('memory allocation refusal can retry without losing in-flight credit',()=>{
  const h=context(installed,{factoryFailures:3});
  Object.assign(h.c,{_sentLength:8000,readOffset:8000,_in_flight_credit:1});
  h.tick();h.tick();h.tick();assert.equal(h.c._in_flight_credit,1);finish(h);
  assert.deepEqual(Uint8Array.from(h.client.wire),h.c.source.subarray(8000));
});

test('normal long file keeps exact bytes across repeated ACKs',()=>{
  const h=context(installed,{bytes:100000});h.tick();finish(h);
  assert.deepEqual(Uint8Array.from(h.client.wire),h.c.source);
  assert.equal(h.c._writtenLength,100000);
});
test('headers and content together never exceed two outstanding TCP segments',()=>{
  const h=context(installed,{bytes:100000});
  Object.assign(h.c,{_state:1,_assembled_headers:'H'.repeat(4000)});
  h.tick();assert.ok(h.client.queued<=2*h.c.CONFIG_LWIP_TCP_MSS);
  for(let i=0;i<500&&h.c._state!==4;++i){
    const ack=Math.min(431,h.client.queued);h.client.queued-=ack;h.tick(ack);
    assert.ok(h.client.queued<=2*h.c.CONFIG_LWIP_TCP_MSS);
    assert.ok(h.c._in_flight<=2*h.c.CONFIG_LWIP_TCP_MSS);
  }
  assert.equal(h.c._state,4);assert.equal(h.client.wire.length,104000);
  assert.deepEqual(Uint8Array.from(h.client.wire.slice(4000)),h.c.source);
});
test('polls cannot refill a full unacknowledged window, and partial ACKs replenish bytes',()=>{
  const h=context(installed,{bytes:100000});h.tick();const before=h.client.wire.length;
  for(let i=0;i<10;++i)h.tick();assert.equal(h.client.wire.length,before);
  h.client.queued-=123;h.tick(123);assert.equal(h.client.wire.length,before+123);
  finish(h);assert.deepEqual(Uint8Array.from(h.client.wire),h.c.source);
});

test('chunked terminator is not complete until its remainder is queued',()=>{
  const h=context(installed,{bytes:0,chunked:true,allowance:3});h.tick();
  assert.equal(h.c._state,2);const calls=h.c.fillCalls;finish(h);
  assert.equal(h.c.fillCalls,calls,'Must not generate another terminating chunk');
  assert.equal(h.client.wire.length,8);
});

test('chunked header writes that queue nothing retain their retry credit',()=>{
  const h=context(installed,{bytes:0,chunked:true,allowance:0});
  Object.assign(h.c,{_state:1,_assembled_headers:'HTTP/1.1 200 OK\r\n\r\n'});
  h.tick();h.tick();h.tick();assert.equal(h.c._in_flight_credit,2);
  finish(h);assert.equal(h.client.wire.length,h.c._writtenHeadersLength+8);
});

test('source TRY_AGAIN without bytes can recover on a poll',()=>{
  const h=context(installed);
  Object.assign(h.c,{_sentLength:8000,readOffset:8000,_in_flight_credit:1});
  const fill=h.c._fillBufferAndProcessTemplates;let pending=true;
  h.c._fillBufferAndProcessTemplates=(...args)=>pending?h.c.RESPONSE_TRY_AGAIN:fill(...args);
  h.tick();h.tick();assert.equal(h.c._in_flight_credit,1);pending=false;
  finish(h);assert.deepEqual(Uint8Array.from(h.client.wire),h.c.source.subarray(8000));
});

test('repeated short and refused writes preserve every byte until completion',()=>{
  const h=context(installed,{bytes:15000});
  for(let i=0;i<800 && h.c._state!==4;++i){
    const ack=h.client.queued;h.client.queued=0;
    h.client.maxAdd=i%4===0?0:37;h.tick(ack);
  }
  assert.equal(h.c._state,4);assert.equal(h.c._send_buffer_len,0);
  assert.deepEqual(Uint8Array.from(h.client.wire),h.c.source);
  assert.equal(h.c._writtenLength,15000);
});
