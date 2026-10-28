const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const root=path.resolve(__dirname,'../..');
const source=fs.readFileSync(path.join(root,'src/audio/spectrum_log.cpp'),'utf8');
const analyzer=fs.readFileSync(path.join(root,'src/audio/audio_spectrum.cpp'),'utf8');
function body(text,name){
  const at=text.indexOf(name);assert.ok(at>=0,name);
  const begin=text.indexOf('{',at);let depth=0;
  for(let i=begin;i<text.length;++i){
    if(text[i]==='{')++depth;
    if(text[i]==='}' && --depth===0)return text.slice(begin,i+1);
  }
  throw new Error(name);
}
function translate(text){
  return text.replace(/const (?:size_t|uint32_t) /g,'const ').replace(/\bsize_t /g,'let ')
    .replace(/const bool /g,'const ')
    .replace(/std::min<size_t>\(/g,'Math.min(').replace(/std::max\(/g,'Math.max(')
    .replace(/static_cast<int>\(/g,'Math.trunc(')
    .replace(/&statsMux/g,'statsMux').replace(/&message/g,'message')
    .replace(/!Serial\b/g,'!Serial.connected')
    .replace('strnlen(message.text, sizeof(message.text))','Math.min(message.text.length,512)')
    .replace('reinterpret_cast<const uint8_t*>(message.text) + offset','message.text.slice(offset)');
}
const postBody=translate(body(source,'bool post('));
const writerBody=translate(body(source,'void writeMessage('));
function harness({connected=true,space=1024,write,initialized=true}={}){
  const context=vm.createContext({now:0,Math,sent:[],overwrites:0,mailbox:initialized?{}:null,
    statsMux:0,writeMaxUs:0,skipped:0,pdPASS:1,writerTask:null});
  context.Serial={connected,availableForWrite:()=>space,write:(text,count)=>{
    if(write)return write(context,text,count);
    context.sent.push(text.slice(0,count));context.now+=10;return count;
  }};
  context.micros=()=>context.now;
  context.vTaskDelay=()=>{++context.now;};
  context.portENTER_CRITICAL=context.portEXIT_CRITICAL=()=>{};
  context.xQueueOverwrite=(queue,message)=>{queue.latest={...message};++context.overwrites;return 1;};
  vm.runInContext(`function noteSkip(){++skipped;}
    function post(message) ${postBody}
    function writeMessage(message) ${writerBody}`,context);
  return context;
}

test('producer never touches USB, and a stopped consumer keeps only the latest report',()=>{
  const h=harness({connected:false});
  h.Serial.availableForWrite=h.Serial.write=()=>{throw new Error('producer reached USB');};
  for(let i=0;i<10000;++i)assert.equal(h.post({text:`report ${i}`}),true);
  assert.equal(h.mailbox.latest.text,'report 9999');assert.equal(h.overwrites,10000);
  assert.equal(h.now,0);
});

test('artwork events use a bounded FIFO and never touch a blocked USB driver',()=>{
  const queued=[];
  const h=harness({connected:false});
  h.events={};
  h.Serial.write=h.Serial.availableForWrite=()=>{throw new Error('event producer reached USB');};
  h.xQueueSend=(_queue,event,timeout)=>{
    assert.equal(timeout,0);
    if(queued.length===8)return 0;
    queued.push(event.text);return 1;
  };
  const eventBody=translate(body(source,'bool postEvent('))
    .replace('Event event;','const event={text:""};')
    .replace('snprintf(event.text, sizeof(event.text), "%s", text);','event.text=text.slice(0,255);')
    .replace('&event','event');
  vm.runInContext('function event(text) '+eventBody,h);
  for(let i=0;i<1000;i++)h.event('album event '+i);
  assert.deepEqual(queued,Array.from({length:8},(_,i)=>'album event '+i));
  assert.equal(h.skipped,992);
  assert.equal(h.now,0);
});

test('closed monitor and connected-but-full USB both drop without writing or waiting',()=>{
  for(const options of [{connected:false},{connected:true,space:0}]){
    const h=harness(options);
    h.Serial.write=()=>{throw new Error('should not write');};
    h.writeMessage({text:'[spectrum] report\n'});
    assert.equal(h.skipped,1);assert.equal(h.now,0);
  }
});

test('a two-second blocked USB writer cannot stop producers or build a backlog',()=>{
  const h=harness({write:(ctx,_text,_count)=>{
    for(let i=0;i<80;++i){ctx.now+=25000;assert.equal(ctx.post({text:`during block ${i}`}),true);}
    return 0;
  }});
  h.writeMessage({text:'[spectrum] old report\n'});
  assert.equal(h.now,2000000);assert.equal(h.writeMaxUs,2000000);
  assert.equal(h.mailbox.latest.text,'during block 79');assert.equal(h.skipped,1);
});

test('open monitor receives bounded chunks of a complete status and band report',()=>{
  const h=harness();const text='[spectrum] pcm=54 fft=200\n[spectrum] bands-dB low->high: '+Array(24).fill('-24').join(',')+'\n';
  h.writeMessage({text});
  assert.equal(h.sent.join(''),text);assert.ok(h.sent.every(part=>part.length<=64));
  assert.equal(h.skipped,0);assert.ok(h.writeMaxUs>0);
});

test('short writes are not retried, and reporting still works after monitor recovery',()=>{
  const h=harness({write:()=>0});h.writeMessage({text:'first'});
  assert.equal(h.skipped,1);
  h.Serial.connected=false;h.writeMessage({text:'disconnected'});
  h.Serial.connected=true;h.Serial.write=(text,count)=>{h.sent.push(text.slice(0,count));return count;};
  h.post({text:'fresh after reconnect\n'});h.writeMessage(h.mailbox.latest);
  assert.equal(h.sent.join(''),'fresh after reconnect\n');
});

test('unavailable logger disables logging without preventing spectrum startup',()=>{
  const h=harness({initialized:false});assert.equal(Boolean(h.post({text:'report'})),false);
  const begin=body(source,'bool begin(');
  assert.match(begin,/return false; \/\/ No synchronous Serial fallback/);
  assert.match(analyzer,/SpectrumLog::begin\(\);/);
  assert.doesNotMatch(analyzer,/if\s*\([^)]*SpectrumLog::begin/);
});

test('low internal memory skips the optional writer before allocating a task',()=>{
  const code=body(source,'bool begin(')
    .replace(/sizeof\(Message\)/g,'512').replace(/&mailboxControl/g,'mailboxControl')
    .replace(/&eventControl/g,'eventControl')
    .replace(/&writerTask/g,'writerTask').replace('tskIDLE_PRIORITY','0').replace(/nullptr/g,'null');
  let allocations=0;
  const start=new Function('writerTask','heap_caps_get_free_size','MALLOC_CAP_INTERNAL','MALLOC_CAP_8BIT',
    'xQueueCreateStatic','xTaskCreatePinnedToCore','mailbox','mailboxStorage','mailboxControl','writerEntry','pdPASS',code);
  assert.equal(start(null,()=>15000,1,2,()=>{++allocations;},()=>{++allocations;},null,{}, {},()=>{},1),false);
  assert.equal(allocations,0);
});

test('all spectrum USB IO is isolated from FFT/capture, with one complete mailbox report',()=>{
  assert.doesNotMatch(analyzer,/\bSerial\s*[.]/);
  const report=body(analyzer,'void AudioSpectrum::reportDiagnostics(');
  assert.equal((report.match(/SpectrumLog::post\(/g)||[]).length,1);
  assert.match(report,/log-write-max=/);assert.match(report,/log-skipped=/);
  assert.match(report,/firstBand \? "" : ","/);
  assert.match(source,/xQueueCreateStatic\(1, sizeof\(Message\)/);
  assert.match(source,/tskIDLE_PRIORITY/);
  assert.doesNotMatch(body(source,'bool post('),/Serial|vTaskDelay|malloc|new |xQueueSend/);
  assert.doesNotMatch(source,/setTxTimeoutMs|setDebugOutput|Serial\.begin|Serial\.end|Serial\.flush/);
});
