const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../src/display/station_picker_policy.h'), 'utf8');
const display = fs.readFileSync(path.resolve(__dirname, '../../src/display/display.cpp'), 'utf8');

function body(signature, text = source) {
  const at = text.indexOf(signature); assert.ok(at >= 0, signature);
  const start = text.indexOf('{', at); let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(start, i+1);
  }
  throw new Error(signature);
}
const translate = text => text.replace(/\bconst (?:int|size_t) /g, 'const ')
  .replace(/\bint /g, 'let ').replace(/static_cast<(?:size_t|int)>\(/g, 'Number(');
const view = vm.runInNewContext(`
  function windowStart(current, selected, count, visible) ${translate(body('inline int windowStart('))}
  function rowParts(x,width,height,logoX,logoY,logoSize,parts) ${translate(body('inline void rowParts('))
    .replace(/parts\[(\d)\] = \{([^}]+)\};/g, 'parts[$1] = rect($2);')}
  function rect(x,y,w,h) { return {x,y,w,h}; }
  function shiftRows(pixels,width,height,rows,delta) ${translate(body('inline bool shiftRows('))
    .replace('memmove(pixels + dst, pixels + src, count * sizeof(uint16_t));', 'pixels.copyWithin(dst, src, src + count);')}
  ({windowStart,rowParts,shiftRows});
`);

test('list edges scroll by one row, with correct ends, wraparound and short lists', () => {
  assert.equal(view.windowStart(0, 4, 20, 5), 0);
  assert.equal(view.windowStart(0, 5, 20, 5), 1);
  assert.equal(view.windowStart(1, 0, 20, 5), 0);
  assert.equal(view.windowStart(1, 19, 20, 5), 15);
  assert.equal(view.windowStart(15, 0, 20, 5), 0);
  assert.equal(view.windowStart(15, 3, 4, 5), 0);
  for (let count = 1; count <= 30; count++) {
    let start = 0;
    for (const selected of [...Array(count).keys(), ...Array(count).keys()].reverse()) {
      start = view.windowStart(start, selected, count, 5);
      assert.ok(start >= 0 && start <= Math.max(0, count-5));
      assert.ok(selected >= start && selected < start+5);
    }
  }
});

test('selection dirty areas cover the row once while leaving every logo pixel untouched', () => {
  for (const [x,width,height,logoX,logoY,size] of [[26,428,42,34,5,32],[17,286,32,23,4,24]]) {
    const parts = []; view.rowParts(x,width,height,logoX,logoY,size,parts);
    const painted = new Uint8Array(width*height);
    for (const r of parts) {
      assert.ok(r.w >= 0 && r.h >= 0);
      for (let y = r.y; y < r.y+r.h; y++) for (let px = r.x; px < r.x+r.w; px++) {
        assert.ok(px >= x && px < x+width && y >= 0 && y < height);
        painted[y*width+px-x]++;
      }
    }
    for (let y=0; y<height; y++) for (let px=x; px<x+width; px++) {
      const logo = px >= logoX && px < logoX+size && y >= logoY && y < logoY+size;
      assert.equal(painted[y*width+px-x], logo ? 0 : 1);
    }
  }
});

test('both scroll directions retain exact cached pixels for every overlapping row', () => {
  const width = 7, height = 3, rows = 5, stride = width*height;
  for (const delta of [-4,-3,-2,-1,1,2,3,4]) {
    const original = Uint16Array.from({length:stride*rows}, (_, i) => i+100);
    const pixels = original.slice();
    assert.equal(view.shiftRows(pixels,width,height,rows,delta), true);
    for (let row=0; row<rows; row++) {
      const sourceRow = row+delta;
      if (sourceRow < 0 || sourceRow >= rows) continue;
      assert.deepEqual(pixels.slice(row*stride,(row+1)*stride),
        original.slice(sourceRow*stride,(sourceRow+1)*stride));
    }
  }
});

test('nonoverlapping jumps and unavailable buffers request fresh composition without changing pixels', () => {
  for (const delta of [-10,-5,0,5,10]) {
    const pixels = Uint16Array.from({length:15}, (_, i) => i);
    const original = pixels.slice();
    assert.equal(view.shiftRows(pixels,3,1,5,delta), false);
    assert.deepEqual(pixels, original);
  }
  assert.equal(view.shiftRows(null,3,1,5,1), false);
});

function compositorHarness({cached = true} = {}) {
  const width=7, height=2, rows=5, stride=width*height;
  const pixels = new Uint16Array(stride*rows), paints=[], transfers=[];
  const stations = Array.from({length:20}, (_, id) => ({id, logo:'logo-'+id}));
  const frame = {getBuffer:()=>pixels, fillSprite:color=>pixels.fill(color)};
  const manager = {
    count:()=>stations.length, indexOfStation:id=>id,
    stationAtIndex:(i,out)=>{if(!stations[i])return false; Object.assign(out,stations[i]); return true;},
    idAtIndex:i=>stations[i]?.id ?? -1
  };
  const draw = (row,index,selected,_offset,logo,present) => {
    paints.push({row,index,logo,present});
    const base=row*stride, tile=pixels[base+2];
    for(let i=0;i<stride;i++)pixels[base+i]=index*20+i;
    pixels[base+2]=logo ? 0x1000+index : tile;
    if(index===selected)pixels[base]=0xffff;
  };
  for(let row=0;row<rows;row++)draw(row,row,4,0,true,false);
  paints.length=0;
  const context = vm.createContext({SCREEN_W:width,PICKER_ROW_H:height,PICKER_VISIBLE_ROWS:rows,
    PICKER_ROW_Y:54,PICKER_VIEWPORT_H:rows*height,cBg:0,pickerViewportValid:cached,
    stationManager:manager,pickerCanvas:()=>frame,StationPickerPolicy:view,
    pickerLogoReady:()=>{},drawStationPickerPagedRow:draw,
    presentPickerCanvas:(_frame,y,h)=>transfers.push({y,h,pixels:pixels.slice()})
  });
  const code = translate(body('static void drawStationPickerViewport(',display))
    .replace('StationManager& manager = StationManager::instance();','const manager = stationManager;')
    .replace('lgfx::LGFX_Sprite* frame','const frame').replace(/\bconst bool /g,'const ')
    .replace('Station station;','const station={};')
    .replace('static_cast<uint16_t*>(frame->getBuffer())','frame.getBuffer()')
    .replace(/frame->/g,'frame.').replace(/StationPickerPolicy::/g,'StationPickerPolicy.')
    .replace(/\*frame/g,'frame').replace(/nullptr/g,'null')
    .replace('manager.stationIdAtIndex(index, stationId)','((stationId=manager.idAtIndex(index))>=0)');
  vm.runInContext('function compose(selectedId,start,previousStart,previousSelected) '+code,context);
  function expected(start,selected) {
    const result=new Uint16Array(pixels.length);
    for(let row=0;row<rows;row++) {
      const index=start+row,base=row*stride;
      for(let i=0;i<stride;i++)result[base+i]=index*20+i;
      result[base+2]=0x1000+index;
      if(index===selected)result[base]=0xffff;
    }
    return result;
  }
  return {context,pixels,paints,transfers,expected};
}

test('viewport composition scrolls cached rows coherently and rasterizes only the entering row logo', () => {
  const h=compositorHarness();
  h.context.compose(5,1,0,4);
  assert.deepEqual(h.pixels,h.expected(1,5));
  assert.deepEqual(h.paints.filter(p=>p.logo).map(p=>p.index),[5]);
  assert.ok(h.paints.every(p=>p.present===false));
  assert.equal(h.transfers.length,1);
  assert.equal(h.transfers[0].y,54);
  assert.equal(h.transfers[0].h,10);
  h.paints.length=0; h.transfers.length=0;
  h.context.compose(0,0,1,5);
  assert.deepEqual(h.pixels,h.expected(0,0));
  assert.deepEqual(h.paints.filter(p=>p.logo).map(p=>p.index),[0]);
  assert.equal(h.transfers.length,1);
});

test('a large jump or invalidated viewport composes a complete new list before one LCD transfer', () => {
  for(const cached of [true,false]) {
    const h=compositorHarness({cached});
    h.context.compose(19,15,0,4);
    assert.deepEqual(h.pixels,h.expected(15,19));
    assert.equal(h.paints.filter(p=>p.logo).length,5);
    assert.equal(h.transfers.length,1);
  }
});

test('viewport cache refuses low or fragmented PSRAM and never allocates internal RAM', () => {
  const code=body('static lgfx::LGFX_Sprite* pickerCanvas(',display)
    .replace('static lgfx::LGFX_Sprite frame(&lcd);','')
    .replace(/static (?:bool|unsigned long) (?:ready|attempted|lastAttempt) = [^;]+;/g,'')
    .replace(/\bconst (?:size_t|uint32_t) /g,'const ')
    .replace('sizeof(uint16_t)','2').replace('void* buffer','const buffer')
    .replace(/frame->/g,'frame.').replace(/&frame/g,'frame').replace(/nullptr/g,'null');
  for(const [free,largest,expected] of [[700000,230400,false],[900000,200000,false],[900000,230400,true]]) {
    const allocations=[];
    const h=vm.createContext({ready:false,attempted:false,lastAttempt:0,pickerViewportValid:true,
      SCREEN_W:480,PICKER_VIEWPORT_H:240,MALLOC_CAP_SPIRAM:4,MALLOC_CAP_8BIT:8,
      millis:()=>10000,heap_caps_get_free_size:()=>free,heap_caps_get_largest_free_block:()=>largest,
      heap_caps_malloc:(bytes,caps)=>{allocations.push({bytes,caps});return {};},heap_caps_free:()=>{},
      frame:{buffer:null,setBuffer(buffer){this.buffer=buffer;},getBuffer(){return this.buffer;}}
    });
    vm.runInContext('function canvas() '+code,h);
    assert.equal(Boolean(h.canvas()),expected);
    assert.equal(allocations.length,expected ? 1 : 0);
    if(expected)assert.deepEqual(allocations[0],{bytes:230400,caps:12});
  }
});

function transferHarness() {
  const width=7,height=8,pixels=Uint16Array.from({length:width*height},(_,i)=>i+100);
  const screen=new Uint16Array(width*height),writes=[];
  let window,cursor=0;
  const lcd={startWrite(){},endWrite(){},setAddrWindow(x,y,w,h){window={x,y,w,h};cursor=0;},
    writePixels(data,count,swap) {
      assert.equal(swap,false);writes.push(count);
      for(let i=0;i<count;i++,cursor++) {
        const x=window.x+cursor%window.w, y=window.y+Math.floor(cursor/window.w);
        assert.ok(cursor < window.w*window.h);
        screen[y*width+x]=data[i];
      }
    }
  };
  const h=vm.createContext({SCREEN_W:width,lcd,frame:{getBuffer:()=>pixels}});
  const code=translate(body('static void presentPickerRect(',display))
    .replace(/const uint16_t\* pixels = [^;]+;/,'const pixels = frame.getBuffer();')
    .replace('pixels + sourceY * SCREEN_W','pixels.subarray(sourceY * SCREEN_W)')
    .replace('pixels + (sourceY + line) * SCREEN_W + x','pixels.subarray((sourceY + line) * SCREEN_W + x)');
  vm.runInContext('function present(x,sourceY,width,height,screenY) '+code,h);
  return {h,pixels,screen,writes,width};
}

test('cropped LCD transfers retain the full sprite stride and leave unrelated pixels untouched', () => {
  const {h,pixels,screen,writes,width}=transferHarness();
  h.present(2,1,3,2,4);
  for(let y=0;y<8;y++)for(let x=0;x<width;x++) {
    assert.equal(screen[y*width+x],y>=4&&y<6&&x>=2&&x<5 ? pixels[(y-3)*width+x] : 0);
  }
  assert.deepEqual(writes,[3,3]);
});

test('a full-width list band uses a single contiguous LCD write', () => {
  const {h,pixels,screen,writes,width}=transferHarness();
  h.present(0,2,width,3,4);
  assert.deepEqual(screen.slice(4*width,7*width),pixels.slice(2*width,5*width));
  assert.deepEqual(writes,[3*width]);
});
