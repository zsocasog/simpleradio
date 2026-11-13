const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/web/response_text.h'),'utf8');
function body(marker){const start=source.indexOf('{',source.indexOf(marker));let depth=0;for(let i=start;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&!--depth)return source.slice(start,i+1);}throw Error(marker);}
const translate=code=>code.replace(/static_cast<char\*>\(([^;]+)\)/g,'$1').replace(/return \*this/g,'return this')
 .replace(/\b(data_|size_|valid_)\b/g,'this.$1').replace(/nullptr/g,'null');
function harness(){const live=new Set(),allocations=[],freed=[];let fail=false;
 const Text=new Function('heap_caps_malloc','heap_caps_free','strlen','memcpy','MALLOC_CAP_SPIRAM','MALLOC_CAP_8BIT',`return class {
 data_=null;size_=0;valid_=true;
 assign(text)${translate(body('operator=(const char*'))}
 length()${translate(body('size_t length('))}
 c_str()${translate(body('const char* c_str('))}
 valid()${translate(body('bool valid('))}
 dispose()${translate(body('~SimpleRadioResponseText('))}
 }`)((n,caps)=>{allocations.push({n,caps});if(fail)return null;const p=Buffer.alloc(n);live.add(p);return p;},
 p=>{if(p){assert.ok(live.delete(p),'exactly one owner releases each allocation');freed.push(p);}},
 text=>{const at=text.indexOf(0);return at<0?text.length:at;},(out,text,n)=>text.copy(out,0,0,n),1,2);
 return {text:new Text(),live,allocations,freed,setFailure:v=>{fail=v;}};
}
test('queued UTF-8 JSON owns an exact external-memory copy independent of the temporary source',()=>{
 for(const value of ['árvíztűrő tükörfúrógép','x'.repeat(65536)]){
  const h=harness(),input=Buffer.from(value+'\0'),expected=Buffer.from(input);h.text.assign(input);input.fill(9);
  assert.equal(h.text.valid(),true);assert.equal(h.text.length(),expected.length-1);assert.deepEqual(h.text.c_str(),expected);
  assert.deepEqual(h.allocations,[{n:expected.length,caps:3}]);h.text.dispose();assert.equal(h.live.size,0);
 }
});
test('empty, null, replacement and self assignment preserve one-owner lifetime without internal fallback',()=>{
 const h=harness();h.text.assign(null);h.text.assign(Buffer.from([0]));assert.equal(h.allocations.length,0);
 h.text.assign(Buffer.from('first\0'));const first=h.text.c_str();h.text.assign(first);
 assert.equal(h.allocations.length,1);assert.equal(h.freed.length,0);
 h.text.assign(Buffer.from('second\0'));assert.equal(h.freed.length,1);assert.equal(h.live.size,1);
 h.text.assign(null);assert.equal(h.text.length(),0);assert.equal(h.text.valid(),true);assert.equal(h.live.size,0);h.text.dispose();
});
test('allocation failure invalidates the response instead of publishing a successful truncated body',()=>{
 const h=harness();h.text.assign(Buffer.from('old\0'));h.setFailure(true);h.text.assign(Buffer.from('new\0'));
 assert.equal(h.live.size,0);assert.equal(h.text.length(),0);assert.equal(h.text.c_str(),'');assert.equal(h.text.valid(),false);
 h.setFailure(false);h.text.assign(Buffer.from('recovered\0'));assert.equal(h.text.valid(),true);h.text.dispose();
 assert.doesNotMatch(source,/MALLOC_CAP_INTERNAL|malloc\([^]*?MALLOC_CAP_DEFAULT/);
});
