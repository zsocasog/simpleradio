const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),test=require('node:test');
const root=path.resolve(__dirname,'../..'),source=fs.readFileSync(path.join(root,'tools/patch_web_deferred.py'),'utf8');
function body(s,marker){const b=s.indexOf('{',s.indexOf(marker));let depth=0;for(let i=b;i<s.length;i++){if(s[i]==='{')depth++;if(s[i]==='}'&&!--depth)return s.slice(b,i+1);}throw Error(marker);}
function make(connected=true){
 const sent=[],freed=[],slot={value:null,compare_exchange_strong(expected,value){if(this.value!==expected)return false;this.value=value;return true;},exchange(value){const old=this.value;this.value=value;return old;}};
 const submit=new Function('slot','response',body(source,'bool AsyncWebServerRequest::sendDeferred(')
  .replace('AsyncWebServerResponse *expected = nullptr;','const expected=null;').replace('_deferredResponse','slot')
  .replace(/std::memory_order_(release|relaxed)/g,'0'));
 const poll=new Function('slot','client','send','dispose',`const pending=slot.exchange(null);if(pending)${body(source,'if (auto *pending = _deferredResponse.exchange')
  .replace(/_client/g,'client').replace(/->/g,'.').replace('delete pending;','dispose(pending);')}`);
 return {slot,sent,freed,submit:r=>submit(slot,r),poll:()=>poll(slot,{connected:()=>connected},r=>sent.push(r),r=>freed.push(r)),
  dispose(){const pending=slot.exchange(null);if(pending)freed.push(pending);}};
}
test('main publishes a complete immutable response; only the network poll starts it exactly once',()=>{
 const h=make(),reply={headers:'ready',body:'{"ok":true}'};assert.equal(h.submit(reply),true);assert.deepEqual(h.sent,[]);
 h.poll();h.poll();assert.deepEqual(h.sent,[reply]);assert.equal(h.slot.value,null);h.dispose();assert.deepEqual(h.freed,[]);
});
test('a second completion cannot overwrite an owned response, and disconnected requests release pending ownership',()=>{
 const h=make(false),a={},b={};assert.equal(h.submit(null),false);assert.equal(h.submit(a),true);assert.equal(h.submit(b),false);
 h.poll();assert.deepEqual(h.sent,[]);assert.deepEqual(h.freed,[a]);h.dispose();assert.deepEqual(h.freed,[a]);
 const beforePoll=make();beforePoll.submit(b);beforePoll.dispose();assert.deepEqual(beforePoll.freed,[b]);beforePoll.poll();assert.deepEqual(beforePoll.sent,[]);
});
test('station and settings completion never start response headers in main',()=>{
 const web=fs.readFileSync(path.join(root,'src/web/web_server.cpp'),'utf8');
 for(const marker of ['static void completeStationSave(', 'static void processSettingsSave(']){
  const fn=body(web,marker);assert.match(fn,/sendDeferredReply\(request.get\(\),/);assert.doesNotMatch(fn,/request->send\(/);
 }
 assert.match(body(web,'static void sendDeferredReply('),/request->sendDeferred\(response\)/);
});
