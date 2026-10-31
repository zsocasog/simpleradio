const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../src/display/display.cpp'), 'utf8');

function body(signature) {
  const at = source.indexOf(signature); assert.ok(at >= 0, signature);
  const start = source.indexOf('{', at); let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(signature);
}

// Execute the production stroke rasterizer, dirty rectangles and update loop.
// The LCD/font backend is a deterministic patterned static face, allowing an
// independent full composition to catch any trail, overlap or stride damage.
function translate(text) {
  return text
    .replace(/const ClockHandSegment (before|after)\[3\] = \{([^]*?)\};/g, 'const $1 = [$2];')
    .replace(/const bool changed\[3\] = \{([^]*?)\};/, 'const changed = [$1];')
    .replace('uint16_t pixels[tileWidth * tileHeight];', 'const pixels = new Uint16Array(tileWidth * tileHeight);')
    .replace('ClockTile tile = {pixels, x, y, min(tileWidth, right - x), min(tileHeight, bottom - y)};',
      'const tile = {pixels, x, y, width:min(tileWidth,right-x), height:min(tileHeight,bottom-y)};')
    .replace(/analogClockAngles\(timeinfo, haveTime, hourAngle, minuteAngle, secondAngle\);/g,
      '({hour:hourAngle,minute:minuteAngle,second:secondAngle} = angles(timeinfo));')
    .replace(/static_cast<(?:int|u?int\d+_t)>\(/g, 'Math.trunc(')
    .replace(/static_cast<float>\(/g, 'Number(')
    .replace(/\b([0-9]+(?:\.[0-9]*)?)f\b/g, '$1')
    .replace(/\b(?:floorf|ceilf|cosf|sinf|sqrtf|lroundf)\b/g, word => ({
      floorf:'Math.floor',ceilf:'Math.ceil',cosf:'Math.cos',sinf:'Math.sin',sqrtf:'Math.sqrt',lroundf:'roundAway',
    })[word])
    .replace(/\bstatic constexpr int /g, 'const ')
    .replace(/\bconst (?:float|int|bool|ClockHandSegment) /g, 'const ')
    .replace(/\b(?:float|int|bool) /g, 'let ')
    .replace(/\(kVuShape\[i\] \* maxHeight \+ 127\) \/ 255/g,
      'Math.trunc((kVuShape[i] * maxHeight + 127) / 255)')
    .replace('maxHeight * (endDistance + 1) / 3', 'Math.trunc(maxHeight * (endDistance + 1) / 3)')
    .replace('(width + 1) / 2', 'Math.trunc((width + 1) / 2)')
    .replace('(hand.width + 1) / 2', 'Math.trunc((hand.width + 1) / 2)')
    .replace('clockTile = &tile', 'clockTile = tile')
    .replace(/->/g, '.')
    .replace(/\bnullptr\b/g, 'null');
}

function harness(width, height) {
  let expected, frame, writes = 0, window;
  const base = Uint16Array.from({ length:width*height }, (_, index) => index % 19 === 0 ? 15000 : 1000);
  const shape = source.match(/kVuShape\[VU_BAR_COUNT\] = \{([^]*?)\};/)[1];
  const context = vm.createContext({
    SCREEN_W:width, SCREEN_H:height, CLOCK_PI:Math.PI, cBg:0, cText:45000, cAccent:60000,
    VU_BAR_COUNT:24, kVuShape:JSON.parse(`[${shape}]`),
    clockTile:null, analogClockHandsValid:true,
    analogClockLastHourAngle:0,analogClockLastMinuteAngle:0,analogClockLastSecondAngle:0,
    sx:n=>Math.floor((n*width+240)/480),sy:n=>Math.floor((n*height+160)/320),
    ss:n=>Math.min(Math.floor((n*width+240)/480),Math.floor((n*height+160)/320)),
    roundAway:n=>n<0 ? -Math.round(-n) : Math.round(n), min:Math.min, max:Math.max,
    constrain:(n,lo,hi)=>Math.max(lo,Math.min(hi,n)),
    writeClockPixel(x,y,color,alpha) {
      const t=context.clockTile;
      assert.ok(t, 'all moving pixels must be composed before LCD transfer');
      const index=(y-t.y)*t.width+x-t.x;
      assert.ok(x>=t.x&&y>=t.y&&x<t.x+t.width&&y<t.y+t.height);
      t.pixels[index]=Math.trunc((color*alpha+t.pixels[index]*(255-alpha))/255);
    },
    drawAnalogClockMarks() {
      const t=context.clockTile; assert.ok(t);
      for(let row=0;row<t.height;row++) for(let col=0;col<t.width;col++)
        t.pixels[row*t.width+col]=base[(row+t.y)*width+col+t.x];
    },
    drawAnalogClockFace() { throw new Error('unexpected full-screen repaint'); },
    lcd:{startWrite(){},endWrite(){},setAddrWindow(x,y,w,h){window={x,y,w,h};},
      writePixels(pixels,count,swap) {
        assert.equal(context.clockTile,null);assert.equal(swap,true);
        assert.equal(count,window.w*window.h);assert.ok(count<=32*24);
        for(let row=0;row<window.h;row++) for(let col=0;col<window.w;col++) {
          const at=(window.y+row)*width+window.x+col;
          const value=pixels[row*window.w+col];
          assert.equal(value,expected[at], 'every transmitted tile must already contain the finished hands');
          frame[at]=value;
        }
        writes++;
      }},
  });
  const angles = translate(body('static void analogClockAngles(')).slice(1,-1);
  let segment = translate(body('static ClockHandSegment clockHandSegment('))
    .replace('return {', 'const values = [')
    .replace('width};', 'width]; return {x1:values[0],y1:values[1],x2:values[2],y2:values[3],width};');
  const functions = [
    ['drawClockStroke','x1,y1,x2,y2,color,width','static void drawClockStroke('],
    ['drawClockHand','cx,cy,angle,length,color,width,tail=0','static void drawClockHand('],
    ['drawClockWaveHand','cx,cy,angle','static void drawClockWaveHand('],
    ['clockHandChanged','before,after','static bool clockHandChanged('],
    ['clockHandTouchesTile','hand,tile','static bool clockHandTouchesTile('],
    ['drawAnalogClockHands','hourAngle,minuteAngle,secondAngle','static void drawAnalogClockHands('],
    ['update','timeinfo,haveTime','static void drawAnalogClockHandsOnly('],
  ].map(([name,args,signature])=>`function ${name}(${args}) ${translate(body(signature))}`).join('\n');
  vm.runInContext(`function angles(timeinfo) {const haveTime=true;let hourAngle,minuteAngle,secondAngle;
    ${angles};return {hour:hourAngle,minute:minuteAngle,second:secondAngle};}
    function clockHandSegment(cx,cy,angle,length,width,tail=0) ${segment}
    ${functions}`,context,{filename:'analog-clock-pixels.js'});
  function full(time) {
    const pixels=base.slice();context.clockTile={pixels,x:0,y:0,width,height};
    context.sample=time;
    vm.runInContext('{const a=angles(sample); drawAnalogClockHands(a.hour,a.minute,a.second)}',context);
    context.clockTile=null;
    return pixels;
  }
  return {
    start(time) {
      frame=full(time);context.sample=time;
      vm.runInContext('{const b=angles(sample);analogClockLastHourAngle=b.hour;analogClockLastMinuteAngle=b.minute;analogClockLastSecondAngle=b.second}',context);
    },
    tick(time) {
      expected=full(time);context.sample=time;writes=0;
      vm.runInContext('update(sample,true)',context);
      assert.equal(context.clockTile,null);assert.deepEqual(frame,expected);
      return writes;
    },
  };
}

test('analog tiles match a fresh full composition across intersections, minute changes and twelve oclock', () => {
  for(const [width,height] of [[480,320],[320,240]]) {
    const h=harness(width,height);
    for(const start of [3*3600+15*60+28,6*3600+30*60+28,9*3600+59*60+57,11*3600+59*60+57]) {
      const time=seconds=>({tm_hour:Math.floor(seconds/3600)%24,tm_min:Math.floor(seconds/60)%60,tm_sec:seconds%60});
      h.start(time(start));
      assert.equal(h.tick(time(start)),0,'unchanged pixel geometry must not touch the LCD');
      for(let tick=1;tick<=7;tick++) assert.ok(h.tick(time(start+tick))>0);
    }
  }
});

test('waveform second hand leaves no trails through a complete revolution at both LCD sizes', () => {
  for (const [width,height] of [[480,320],[320,240]]) {
    const h=harness(width,height);
    const time=seconds=>({tm_hour:9,tm_min:18+Math.floor(seconds/60),tm_sec:seconds%60});
    h.start(time(0));
    for (let second=1;second<=60;second++) assert.ok(h.tick(time(second))>0);
    assert.equal(h.tick(time(60)),0);
  }
});
