const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../../src/input/input_controller.cpp'),'utf8');
const body=name=>source.match(new RegExp('static bool '+name+'\\([^]*?\\n\\}'))[0].replace(/^static bool [^{]+/,'');
function receiver() {
  const c=vm.createContext({UNKNOWN:-1,UNUSED:0,lastIrCode:0,lastIrCodeMs:0,IR_REPEAT_WINDOW_MS:800,now:1000});
  c.millis=()=>c.now;
  const valid=body('validIrFrame').replace('0xFFFFFFFFFFFFFFFFULL','0xffffffffffffffffn');
  const decode=body('decodedIrCode').replace(/(?<![.\w])code\b/g,'out.code').replace(/(?<![.\w])repeat\b/g,'out.repeat');
  vm.runInContext(`function validIrFrame(result) ${valid}\nfunction decode(result,out) ${decode}`,c);
  return {c,read(result){const out={};return c.decode(result,out)?out:null;}};
}
const full={overflow:false,decode_type:1,repeat:false,rawlen:68,bits:32,value:0xff02fd};
test('the complete frame and continuous NEC repeat chain work beyond 800 milliseconds',()=>{
  const h=receiver();assert.equal(h.read(full).code,full.value);
  for(let elapsed=110;elapsed<5000;elapsed+=110) {
    h.c.now=1000+elapsed;const decoded=h.read({...full,repeat:true,rawlen:4,bits:0,value:0});
    assert.ok(decoded,elapsed);assert.equal(decoded.code,full.value);assert.equal(decoded.repeat,true);
  }
});
test('isolated, expired and malformed frames cannot reuse the last command',()=>{
  const h=receiver();assert.equal(h.read({...full,repeat:true}),null);
  h.read(full);h.c.now+=801;assert.equal(h.read({...full,repeat:true}),null);
  for(const altered of [{overflow:true},{decode_type:-1},{decode_type:0},{rawlen:3},{bits:2},{value:1},{value:0xffffffffffffffffn}])
    assert.equal(h.read({...full,...altered}),null,JSON.stringify(altered,(_,v)=>typeof v==='bigint'?v.toString():v));
});
test('ordinary remote capture ends before the next repeat and is resumed only by the saved-buffer decoder',()=>{
  assert.match(source,/IR_CAPTURE_TIMEOUT_MS = 15/);
  assert.match(source,/IRrecv irrecv\(IR_PIN, IR_CAPTURE_BUFFER_SIZE, IR_CAPTURE_TIMEOUT_MS, true\)/);
  const loop=source.slice(source.indexOf('void InputController::loop()'));
  assert.doesNotMatch(loop,/irrecv\.resume\(/);
  assert.match(source,/if \(repeat\) return;/); // Learning still requires a complete initial code.
});
test('holds repeat volume and navigation, while toggle, view, digits and station presets stay single-shot',()=>{
  const body=source.match(/static bool repeatableIrAction\([^]*?\n\}/)[0].replace(/^static bool [^{]+/,'');
  const repeatable=new Function('action','strcmp',body),strcmp=(a,b)=>a===b?0:1;
  for(const action of ['volUp','volDown','prev','next','up','down','left','right'])assert.ok(repeatable(action,strcmp),action);
  for(const action of ['toggle','ok','mute','list','back','power','hash','star','digit1','station1'])assert.equal(repeatable(action,strcmp),false,action);
  assert.match(source,/if \(repeat && !repeatableIrAction\(action\)\) return;\s*applyIrAction\(action\)/);
});
