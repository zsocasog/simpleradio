const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
const app = read('data/app.js'), ui = read('data/ui.js'), display = read('src/display/display.cpp');
function body(source, marker) {
  const start=source.indexOf('{',source.indexOf(marker)); assert.ok(start>=0,marker); let depth=0;
  for(let i=start;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&--depth===0)return source.slice(start,i+1);}
  throw Error(marker);
}

test('only the playing station stops; every other station starts normally',()=>{
  const commands=[];
  const c=vm.createContext({playing:true,currentStationId:2,sendCommand:cmd=>commands.push(JSON.parse(JSON.stringify(cmd))),selectStation:id=>commands.push({station:id,play:true})});
  vm.runInContext('function toggleStationPlayback(id) '+body(app,'function toggleStationPlayback('),c);
  c.toggleStationPlayback(2); c.toggleStationPlayback(3); c.playing=false; c.toggleStationPlayback(2);
  assert.deepEqual(commands,[{play:false},{station:3,play:true},{station:2,play:true}]);
});

test('play/stop labels and icons update without rebuilding rows or logos',()=>{
  let writes=0;const c=vm.createContext({playing:true,currentStationId:2,t:(_key,fallback)=>fallback,
    window:{SRUI:{ready:true,icon:name=>name}}});
  vm.runInContext('function syncStationPlayButton(button,stationId) '+body(app,'function syncStationPlayButton('),c);
  const button={dataset:{},setAttribute(k,v){this[k]=v;},set innerHTML(v){writes++;this.icon=v;}};
  c.syncStationPlayButton(button,2); assert.equal(button.icon,'player-stop');assert.equal(button['aria-label'],'Megállítás');
  c.syncStationPlayButton(button,2);assert.equal(writes,1);
  c.playing=false;c.syncStationPlayButton(button,2);assert.equal(button.icon,'player-play');
  c.playing=true;c.currentStationId=3;c.syncStationPlayButton(button,2);assert.equal(writes,2);
});

test('editing ignores backdrop clicks; explicit Cancel closes and discards only the draft',()=>{
  const code=ui.match(/n.addEventListener\("click", e => ([^\n]+)\);/)[1];let closes=0;
  const dialog={dataset:{dismissOnBackdrop:'false'},getBoundingClientRect:()=>({left:800}),close:()=>closes++};
  const click=new Function('n','e',code);
  click(dialog,{target:dialog,clientX:200});assert.equal(closes,0);
  dialog.dataset.dismissOnBackdrop='true';click(dialog,{target:dialog,clientX:200});assert.equal(closes,1);
  let resets=0;const editor={open:true};
  const cancel=new Function('clearStationForm','$','window',body(app,'function cancelStationEdit('));
  cancel(open=>{assert.equal(open,false);resets++;},()=>editor,{SRUI:{stationDialog:dialog}});
  assert.equal(resets,1);assert.equal(editor.open,false);assert.equal(closes,2);
  assert.match(read('data/index.html'),/onclick="cancelStationEdit\(\)" data-i18n="action.cancel">Mégse/);
});

test('off mode hides and disables standby brightness, and other modes restore its saved value',()=>{
  const rows={};const nodes=Object.fromEntries(['displayIdleEnabled','displayIdleMode','displayIdleBlank','displayClockEnabled','displayClockOptions','displayIdleBrightness'].map(name=>{
    rows[name]={classList:{toggle(_name,value){this.hidden=value;}}};
    return [name,{checked:true,value:name==='displayIdleMode'?'blank':'77',classList:{toggle(){}},closest:()=>rows[name]}];
  }));
  const sync=new Function('$',body(app,'function syncDisplayIdleMode('));
  sync(id=>nodes[id]);assert.equal(nodes.displayIdleBrightness.disabled,true);assert.equal(rows.displayIdleBrightness.classList.hidden,true);
  assert.equal(nodes.displayIdleBrightness.value,'77');
  nodes.displayIdleMode.value='clock';sync(id=>nodes[id]);assert.equal(nodes.displayIdleBrightness.disabled,false);
  assert.equal(rows.displayIdleBrightness.classList.hidden,false);assert.equal(nodes.displayIdleBrightness.value,'77');
});

function lcd() {
  const calls=[];
  const config={displayIdleEnabled:true,displayIdleSeconds:120,displayIdleBlank:true,displayClockEnabled:false,
    displayIdleBrightness:77,brightness:255,autoBrightness:false,displayInvert:false,themeAccent:'amber',themeCustomColor:'',displayClockStyleId:'digital'};
  const c=vm.createContext({configRef:config,now:200000,millis:()=>c.now,
    lastModel:{playing:false,apMode:false},lastActivityMs:1000,stationPickerActive:false,
    volumePopupUntil:0,isVolumeScreenActive:()=>false,panelSleeping:false,idleBlanked:false,idleClockActive:false,
    idleGuardBlanked:false,idleGuardLastMs:0,idleGuardRestoreMs:0,IDLE_LCD_GUARD_MS:600000,IDLE_LCD_GUARD_BLACK_MS:450,
    lastBrightness:-1,lastInvert:false,lastThemeAccent:'amber',lastThemeCustomColor:'',lastClockStamp:-1,lastClockMinuteStamp:-1,
    lastClockStyle:'',hasRenderedModel:true,TFT_BLACK:0,TFT_BL:14,
    lcd:{wakeup:()=>calls.push('wake'),sleep:()=>calls.push('sleep'),fillScreen:()=>calls.push('black'),invertDisplay(){}},
    pdMS_TO_TICKS:ms=>ms,vTaskDelay:ms=>calls.push(['settle',ms]),
    ledcWrite:(_pin,value)=>calls.push(['brightness',value]),
    renderCurrent:()=>calls.push('redraw'),renderIdleClock:()=>calls.push('clock'),applyPalette(){},
    DisplayClockStyle:{Analog:'analog'},getLocalTime:()=>false,
    StatusLed:{instance:()=>({setDisplayBacklight(){}})}});
  let code=body(display,'void Display::applyConfigNow(')
    .replace('AppConfig& config = AppConfig::instance();','const config = configRef;')
    .replace(/static_cast<unsigned long>\(([^)]+)\)/g,'Number($1)')
    .replace(/\b(?:const )?(?:bool|uint8_t|uint16_t|unsigned long|String) /g,'let ')
    .replace('struct tm timeinfo;','const timeinfo = {};').replace('getLocalTime(&timeinfo, 5)','getLocalTime(timeinfo,5)')
    .replace(/DisplayClockStyle::/g,'DisplayClockStyle.').replace(/StatusLed::/g,'StatusLed.')
    .replace(/(\d+)UL/g,'$1').replace(/^#(?:if|endif).*$/gm,'');
  vm.runInContext('function apply() '+code,c);
  return {c,config,calls,run:()=>c.apply()};
}

test('off means black pixels, backlight zero and one panel sleep command',()=>{
  const h=lcd();h.run();h.run();assert.equal(h.c.panelSleeping,true);assert.equal(h.c.lastBrightness,0);
  assert.deepEqual(h.calls,['black',['brightness',0],'sleep']);
});

test('activity wakes and redraws the panel, including a full 100% brightness setting',()=>{
  const h=lcd();h.run();h.calls.length=0;h.c.lastActivityMs=h.c.now;h.run();
  assert.equal(h.c.panelSleeping,false);assert.equal(h.c.idleBlanked,false);assert.equal(h.c.lastBrightness,255);
  assert.deepEqual(h.calls,['wake',['settle',130],'redraw',['brightness',255]]);
  h.calls.length=0;h.run();assert.deepEqual(h.calls,[]);
});

test('clock/dim selection wakes an off panel and retains the configured standby brightness',()=>{
  for(const clock of [false,true]){const h=lcd();h.run();h.calls.length=0;h.config.displayIdleBlank=false;h.config.displayClockEnabled=clock;h.run();
    assert.equal(h.c.panelSleeping,false);assert.equal(h.c.lastBrightness,77);assert.ok(h.calls.includes(clock?'clock':'redraw'));}
});

test('playback, station picker and WiFi setup cannot be put to sleep by the idle timer',()=>{
  for(const key of ['playing','apMode','picker']){const h=lcd();if(key==='picker')h.c.stationPickerActive=true;else h.c.lastModel[key]=true;
    h.run();assert.equal(h.c.panelSleeping,false);assert.ok(!h.calls.includes('sleep'));}
});
