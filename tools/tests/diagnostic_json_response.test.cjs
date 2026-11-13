const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),source=fs.readFileSync(path.join(root,'src/web/diagnostic_json_response.h'),'utf8');
function body(s,marker){const b=s.indexOf('{',s.indexOf(marker));let depth=0;for(let i=b;i<s.length;i++){if(s[i]==='{')depth++;if(s[i]==='}'&&!--depth)return s.slice(b,i+1);}throw Error(marker);}
function make(payload,{fail=false,overflow=false,short=false}={}){
 const bytes=Buffer.from(payload),allocations=[],freed=[];
 const translate=s=>s.replace(/const size_t /g,'const ')
  .replace('static_cast<uint8_t*>(heap_caps_malloc(bytes + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT))','allocate(bytes+1)')
  .replace('reinterpret_cast<char*>(data_)','data_').replace(/\b(data_|offset_|valid_|_contentLength|_contentType|_sendContentLength|_code)\b/g,'this.$1');
 const Response=new Function('doc','measureJson','serializeJson','allocate','heap_caps_free','memcpy',`return class {
  data_=null;offset_=0;valid_=false;
  constructor()${translate(body(source,'explicit DiagnosticJsonResponse('))}
  valid()${translate(body(source,'bool _sourceValid('))}
  fill(buffer,maxLen)${translate(body(source,'size_t _fillBuffer(')).replace('this.data_ + this.offset_','this.data_.subarray(this.offset_)')}
  dispose()${translate(body(source,'~DiagnosticJsonResponse()'))}
 }`)({overflowed:()=>overflow},()=>bytes.length,(d,out,n)=>{bytes.copy(out,0,0,n-1);return short?bytes.length-1:bytes.length;},
  n=>{allocations.push(n);return fail?null:Buffer.alloc(n);},p=>freed.push(p),(out,from,n)=>from.copy(out,0,0,n));
 return {r:new Response(),allocations,freed,bytes};
}
test('diagnostics stream exact UTF-8 JSON in partial callbacks and release their owned payload',()=>{
 for(const chunk of [1,3,512,8192]){
  const h=make(JSON.stringify({message:'mérés',rows:Array(60).fill({count:123})}));assert.ok(h.r.valid());
  const parts=[];for(;;){const b=Buffer.alloc(chunk),n=h.r.fill(b,chunk);if(!n)break;parts.push(b.subarray(0,n));}
  assert.deepEqual(Buffer.concat(parts),h.bytes);assert.ok(h.r.valid());h.r.dispose();assert.equal(h.freed.length,1);
 }
});
test('failed, oversized or overflowed observations cannot fall back to internal RAM or publish partial JSON',()=>{
 for(const options of [{fail:true},{overflow:true},{short:true}]){
  const h=make('{"ok":true}',options);assert.equal(h.r.valid(),false);assert.equal(h.r.fill(Buffer.alloc(5),5),0);h.r.dispose();
 }
 assert.equal(make('x'.repeat(16385)).allocations.length,0);
 assert.match(source,/MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT/);assert.doesNotMatch(source,/String out|xTaskCreate/);
});
test('normal firmware omits the diagnostic response; logo listing uses metadata without FILE buffers',()=>{
 const web=fs.readFileSync(path.join(root,'src/web/web_server.cpp'),'utf8');
 assert.match(web,/#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS\s+#include "diagnostic_json_response.h"\s+#endif/);
 const route=body(web,'server.on("/api/diagnostics"');assert.match(route,/DiagnosticJsonResponse\(doc\)/);
 assert.doesNotMatch(route,/String out|serializeJson\(doc, out\)/);
 const list=body(web,'static AsyncWebServerResponse* prepareLogoListResponse(');assert.match(list,/ReadOnlyStorage::visitFiles/);
 assert.doesNotMatch(list,/LittleFS.open|getNextFileName|drawPng|fopen/);
});
