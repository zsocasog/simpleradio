const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/display/display.cpp'), 'utf8');
const graphics = fs.readFileSync(path.join(root,
  '.pio/libdeps/esp32-s3-devkitc1-n16r8/LovyanGFX/src/lgfx/v1/LGFXBase.cpp'), 'utf8');
function body(text, marker) {
  const at = text.indexOf(marker); assert.ok(at >= 0, marker);
  const start = text.indexOf('{', at); let depth = 0;
  for (let i = start; i < text.length; ++i) {
    if (text[i] === '{') ++depth;
    if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(marker);
}
function translate(code) {
  return code.replace(/\b(?:constexpr|const) (?:int32_t|uint16_t|uint8_t|int) /g, 'const ')
    .replace(/\b(?:int32_t|uint16_t|uint8_t|int) /g, 'let ')
    .replace(/(?:min|max)<(?:int32_t|int)>/g, match => match.startsWith('min') ? 'min' : 'max');
}
// Exercise the installed drawing library's actual round-rectangle algorithm,
// not an idealized circle. This also covers its very short rounded bars.
const round = new Function('x', 'y', 'w', 'h', 'r', translate(body(graphics, 'void LGFXBase::fillRoundRect('))
  .replace('if (_adjust_abs(x, w)||_adjust_abs(y, h)) return;',
    'if (!w || !h) return; if(w<0){x+=w+1;w=-w;} if(h<0){y+=h+1;h=-h;}')
  .replace(/\b(startWrite|endWrite|writeFillRect|writeFastHLine)\(/g, 'this.$1('));
const swap = value => ((value & 255) << 8) | (value >>> 8);
class Canvas {
  constructor(parent = null) { this.parent = parent; this.events = []; this.record = false; }
  setBuffer(buffer, width, height) { this.pixels = buffer; this.width = width; this.height = height; }
  startWrite() {}
  endWrite() {}
  pixel(x, y, color) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y));
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels[y * this.width + x] = this.parent ? swap(color) : color;
    if (this.record) this.events.push([x, y, color]);
  }
  drawFastHLine(x, y, w, color) { for (let i = 0; i < w; ++i) this.pixel(x + i, y, color); }
  writeFastHLine(x, y, w) { this.drawFastHLine(x, y, w, this.color); }
  writeFillRect(x, y, w, h) {
    if (w < 0) { x += w + 1; w = -w; } if (h < 0) { y += h + 1; h = -h; }
    for (let row = 0; row < h; ++row) this.drawFastHLine(x, y + row, w, this.color);
  }
  fillRoundRect(x, y, w, h, r, color) { this.color = color; round.call(this, x, y, w, h, r); }
  setAddrWindow(x, y, w, h) { this.window = { x, y, w, h }; }
  writePixels(pixels, count, native) {
    const { x, y, w, h } = this.window; assert.equal(count, w * h);
    for (let i = 0; i < count; ++i) this.pixel(x + i % w, y + Math.floor(i / w), native ? pixels[i] : swap(pixels[i]));
  }
}
function renderer(width = 480, height = 320, accent = 0xfd20, bg = 0x0821) {
  const sy = value => Math.floor((value * height + 160) / 320);
  const sx = value => Math.floor((value * width + 240) / 480);
  const barWidth = Math.min(sx(9), sy(9)), maxH = width === 480 ? 32 : 24;
  const lcd = new Canvas(); lcd.setBuffer(new Uint16Array(width * height), width, height);
  const context = vm.createContext({ lcd, Sprite: Canvas, Uint16Array, SCREEN_W: width, SCREEN_H: height,
    VU_BAR_W: barWidth, VU_BAR_GAP: Math.min(sx(7), sy(7)), VU_BAR_COUNT: 24,
    VU_SYMMETRIC_MAX_H: maxH, cBg: bg, cPanel: 0x1082, cPanelAlt: 0x2104, cLine: 0x39e7,
    min: Math.min, max: Math.max, sy, constrain: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    blend565: (a, b, alpha) => Math.round((a * alpha + b * (255 - alpha)) / 255),
    vuBarColor: () => accent });
  const definitions = [
    ['playerSurfaceColorAtY', 'y'], ['drawPlayerSurfaceRegion', 'x,y,w,h'],
    ['vuBarXInLayout', 'layout,index'], ['drawVuBarInLayout', 'layout,index,height'],
    ['restoreVuRect', 'x,y,w,h'], ['restoreShrinkingVuBar', 'layout,index,oldHeight,newHeight'],
    ['drawVuBaselineInLayout', 'layout,x,w'], ['drawSpectrumBarBuffered', 'layout,index,height'],
  ].map(([name, args]) => {
    const marker = new RegExp(`static (?:void|uint16_t|int) ${name}\\(`).exec(source)[0];
    let code = body(source, marker)
      .replace(/uint16_t pixels\[([^;]+)\];/, 'const pixels = new Uint16Array($1);')
      .replace('lgfx::LGFX_Sprite bar(&lcd);', 'const bar = new Sprite(lcd);');
    return `function ${name}(${args}) ${translate(code)}`;
  }).join('\n');
  vm.runInContext(definitions, context);
  const layout = { symmetric: true, classic: false, barWidth, barGap: Math.min(sx(7), sy(7)),
    maxH, meterX: 30, axisY: height - sy(40) };
  function full(value) {
    context.drawPlayerSurfaceRegion(0, 0, width, height);
    context.drawVuBaselineInLayout(layout, layout.meterX, barWidth);
    context.drawVuBarInLayout(layout, 0, value);
  }
  return { context, lcd, layout, full };
}

test('each buffered transition equals a fresh LCD drawing at every spectrum height', () => {
  for (const [width, height] of [[480, 320], [320, 240]]) {
    const { context: p, lcd, layout, full } = renderer(width, height);
    for (let old = 0; old <= layout.maxH; ++old) {
      full(old); const before = lcd.pixels.slice();
      for (let next = 0; next <= layout.maxH; ++next) {
        full(next); const expected = lcd.pixels.slice(); lcd.pixels.set(before);
        p.drawSpectrumBarBuffered(layout, 0, next);
        assert.deepEqual(lcd.pixels, expected, `${width}x${height}: ${old}->${next}`);
      }
    }
  }
});

test('a one-pixel shrink no longer blanks retained cap pixels before restoring them', () => {
  const { context: p, lcd, layout, full } = renderer();
  full(20); const before = lcd.pixels.slice(); full(19); const after = lcd.pixels.slice();
  const retained = new Set();
  for (let i = 0; i < before.length; ++i) if (before[i] === 0xfd20 && after[i] === 0xfd20) retained.add(i);
  const flashes = () => lcd.events.filter(([x, y, color]) => retained.has(y * lcd.width + x) && color !== 0xfd20).length;
  lcd.pixels.set(before); lcd.events = []; lcd.record = true;
  p.restoreShrinkingVuBar(layout, 0, 20, 19);
  p.drawVuBaselineInLayout(layout, layout.meterX, layout.barWidth);
  p.drawVuBarInLayout(layout, 0, 19);
  assert.ok(flashes() > 0, 'fixture must reproduce the direct erase/redraw defect');
  lcd.pixels.set(before); lcd.events = [];
  p.drawSpectrumBarBuffered(layout, 0, 19);
  assert.equal(flashes(), 0);
  assert.deepEqual(lcd.pixels, after);
});

test('buffered output preserves theme color order and the existing gradient in both theme polarities', () => {
  for (const color of [0xf800, 0x07e0, 0x001f, 0xfd20]) for (const bg of [0x0000, 0xffff]) {
    const { context: p, lcd, layout, full } = renderer(480, 320, color, bg);
    full(0); p.drawSpectrumBarBuffered(layout, 0, 20);
    assert.equal(lcd.pixels[layout.axisY * lcd.width + layout.meterX + 4], color);
    const actual = lcd.pixels.slice(); full(20); assert.deepEqual(lcd.pixels, actual);
  }
});

test('only changed spectrum columns use the stack buffer; conventional VU retains its drawing path', () => {
  const draw = body(source, 'static void drawVuMeter(');
  assert.match(draw, /if \(renderedVuBars\[i\] == vuBars\[i\]\) continue;\s*if \(footerMode\(\) == DisplayFooterMode::Spectrum\) \{\s*drawSpectrumBarBuffered/);
  assert.match(draw, /drawSpectrumBarBuffered[\s\S]*?continue;\s*\}\s*restoreShrinkingVuBar/);
  const buffered = body(source, 'static void drawSpectrumBarBuffered(');
  assert.doesNotMatch(buffered, /createSprite|malloc|heap_caps|pushImageDMA|writePixelsDMA|restoreVuRect/);
  assert.match(buffered, /writePixels\(pixels, VU_BAR_W \* bufferH, false\)/);
});
