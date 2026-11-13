const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),source=fs.readFileSync(path.join(root,'src/wifi/wifi_tx_config.cpp'),'utf8');
const code=source.slice(source.indexOf('{',source.indexOf('extern "C" esp_err_t __wrap_')))
 .replace('wifi_init_config_t bounded = *config;','const bounded = {...config};').replace('const int rxLimit','const rxLimit').replace(/->/g,'.').replace('&bounded','bounded');
test('Wi-Fi TX bounds preserve RX/AMPDU, caller ownership and native errors',()=>{
 for(const type of [0,1])for(const count of [0,1,2,4,8,16,32,128])for(const ba of [6,8,12,16])for(const rx of [0,4,8,32])for(const fixed of [4,6,8,16]){
  const config={tx_buf_type:type,dynamic_tx_buf_num:count,static_rx_buf_num:fixed,dynamic_rx_buf_num:rx,
   magic:0x1234,nvs_enable:1,cache_tx_buf_num:4,rx_ba_win:ba};
  let passed;const call=new Function('config','__real_esp_wifi_init',code);
  assert.equal(call(config,value=>{passed=value;return -123;}),-123);
  assert.equal(config.dynamic_tx_buf_num,count);
  const expected={...config,dynamic_tx_buf_num:type===1?Math.min(count,8):count,
   static_rx_buf_num:fixed,dynamic_rx_buf_num:rx};
  assert.deepEqual(passed,expected);
 }
 let called=false;new Function('config','__real_esp_wifi_init',code)(null,p=>{assert.equal(p,null);called=true;});assert.ok(called);
});
test('normal builds link the wrapper explicitly without editing framework or Wi-Fi binaries',()=>{
 assert.match(fs.readFileSync(path.join(root,'platformio.ini'),'utf8'),/post:tools\/configure_wifi_tx.py/);
 assert.match(fs.readFileSync(path.join(root,'tools/configure_wifi_tx.py'),'utf8'),/--wrap=esp_wifi_init/);
});
