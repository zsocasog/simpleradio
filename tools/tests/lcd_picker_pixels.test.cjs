const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/display/display.cpp'), 'utf8');
// Execute the production SR56 decoder and channel averaging with a 4x4 fixture.
// The smaller 2:1 reduction keeps the C++ integer loop bounds identical in JS.
const pixel = source.match(/static uint16_t thumbnailRgb565\([^]*?\n\}/)[0]
  .replace(/static uint16_t thumbnailRgb565\([^)]*\)/, 'function thumbnailRgb565(row, column)')
  .replace(/static_cast<uint16_t>\(([^)]+)\)/g, '($1)');
const reduction = source.match(/static bool readPickerLogoRow\([^]*?\n\}/)[0]
  .replace(/static bool readPickerLogoRow\([^)]*\)/, 'function readPickerLogoRow(file, pixels, y)')
  .replace(/uint8_t sourceRow\[[^;]+;/, 'const sourceRow = new Uint8Array(ART_SIZE * 2);')
  .replace(/uint32_t red\[[^;]+;/, 'const red = new Uint32Array(PICKER_LOGO_SIZE), green = new Uint32Array(PICKER_LOGO_SIZE), blue = new Uint32Array(PICKER_LOGO_SIZE);')
  .replace(/sizeof\(sourceRow\)/g, 'sourceRow.length')
  .replace(/\bconst (?:int|unsigned) /g, 'const ')
  .replace(/\b(?:int|uint16_t) /g, 'let ');

function downsample(colors) {
  const bytes = Uint8Array.from(colors.flatMap(color => [color >> 8, color & 255]));
  let offset = 0;
  const context = vm.createContext({ ART_SIZE: 4, PICKER_LOGO_SIZE: 2,
    entry: { pixels: new Uint16Array(4) },
    file: { read(row, size) {
      const chunk = bytes.subarray(offset, offset + size);
      row.set(chunk); offset += chunk.length; return chunk.length;
    } }
  });
  vm.runInContext(pixel + '\n' + reduction + '\nfunction run() { for (let y=0; y<PICKER_LOGO_SIZE; y++) { if (!readPickerLogoRow(file, entry.pixels, y)) return []; } return entry.pixels; }', context);
  return Array.from(context.run());
}

test('picker keeps primary colors from the big-endian SR56 sprite bytes', () => {
  const r = 0xf800, g = 0x07e0, b = 0x001f, w = 0xffff;
  assert.deepEqual(downsample([
    r, r, g, g, r, r, g, g,
    b, b, w, w, b, b, w, w
  ]), [r, g, b, w]);
});

test('picker averages RGB565 channels without inventing colors at logo edges', () => {
  assert.deepEqual(downsample([
    0xf800, 0x001f, 0xffff, 0x0000,
    0x001f, 0xf800, 0x0000, 0xffff,
    0x07e0, 0x0000, 0xffff, 0xffff,
    0x0000, 0x07e0, 0xffff, 0xffff
  ]), [0x780f, 0x7bef, 0x03e0, 0xffff]);
});

test('the display consumes averaged picker pixels as native RGB565', () => {
  const row = source.slice(source.indexOf('static void drawPickerLogoTile('), source.indexOf('static void drawStationPickerPagedRow('));
  assert.match(row, /canvas\.writePixels\(pickerLogos\[row\]\.pixels, PICKER_LOGO_SIZE \* PICKER_LOGO_SIZE, true\)/);
});
