const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(root, 'data/app.js'), 'utf8');
function body(source, marker) {
  const at = source.indexOf(marker); assert.ok(at >= 0, marker);
  const start = source.indexOf('{', at); let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(marker);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function browser() {
  const requests = [], pending = [], statuses = new Map();
  const c = vm.createContext({ stationAssetRevision: 1, now: 1000,
    Date: { now: () => c.now },
    setTimeout: () => 1, clearTimeout() {},
    remoteUrl: p => /^https?:\/\//i.test(p),
    logoUrl: p => p,
    Image: class {
      set src(url) { requests.push(url); pending.push({ image: this, url }); }
    }
  });
  const code = app.slice(app.indexOf('function stationLogoPaths('), app.indexOf('\nfunction updateCover('));
  vm.runInContext(code, c);
  return { c, requests, pending, statuses,
    node: () => ({ dataset: {}, style: {}, textContent: '', classList: { add() {}, remove() {} } }),
    async finish() {
      for (let turn = 0; turn < 10; ++turn) {
        for (const { image, url } of pending.splice(0)) (statuses.get(url) ? image.onload : image.onerror)();
        await tick(); if (!pending.length) break;
      }
    }
  };
}

test('a cached station logo displays even when the external original is gone', async () => {
  const h = browser(), n = h.node();
  const paths = h.c.stationLogoPaths(2, 'https://origin.example/logo.png');
  const local = paths[0] + '&sr=station2'; h.statuses.set(local, true);
  h.c.applyArtworkNode(n, paths[0], 'station2', 'DA', paths.slice(1)); await h.finish();
  assert.equal(n.style.backgroundImage, `url("${local}")`);
  assert.deepEqual(h.requests, [local]);
  h.c.applyArtworkNode(n, paths[0], 'station2', 'DA', paths.slice(1));
  assert.equal(h.requests.length, 1); // Stable updates never reload a good image.
});

test('a missing local thumbnail falls back to the advertised original without altering its URL', async () => {
  const h = browser(), n = h.node(), remote = 'https://origin.example/logo.png?token=signed';
  h.statuses.set(remote, true);
  h.c.applyArtworkNode(n, '/api/artwork/station?id=5', 's5', 'SR', [remote]); await h.finish();
  assert.equal(n.style.backgroundImage, `url("${remote}")`);
  assert.equal(h.requests.length, 2);
});

test('missing logos show initials and retry when idle prewarming has completed', async () => {
  const h = browser(), n = h.node(), local = '/api/artwork/station?id=5&sr=s5';
  h.c.applyArtworkNode(n, '/api/artwork/station?id=5', 's5', 'DA'); await h.finish();
  assert.equal(n.textContent, 'DA'); assert.equal(n.style.backgroundImage, '');
  h.c.now += 5001; h.statuses.set(local, true);
  h.c.applyArtworkNode(n, '/api/artwork/station?id=5', 's5', 'DA'); await h.finish();
  assert.equal(n.style.backgroundImage, `url("${local}")`);
});

test('a late old station image cannot overwrite the new station', async () => {
  const h = browser(), n = h.node();
  h.c.applyArtworkNode(n, '/old.png', 'old', 'OL');
  const old = h.pending.shift();
  h.c.applyArtworkNode(n, '/new.png', 'new', 'NE');
  h.statuses.set('/new.png?sr=new', true); await h.finish();
  old.image.onload(); await tick();
  assert.equal(n.style.backgroundImage, 'url("/new.png?sr=new")');
});

test('RAM album images retain direct display without station preloading', () => {
  const h = browser(), n = h.node();
  h.c.applyArtworkNode(n, '/api/artwork/album?id=1234', 'song', 'SR', ['/station.png']);
  assert.equal(n.style.backgroundImage, 'url("/api/artwork/album?id=1234&sr=song")');
  assert.deepEqual(h.requests, []);
});

test('the real BMP streamer preserves RGB565 and arbitrary HTTP fragments', () => {
  const cpp = fs.readFileSync(path.join(root, 'src/artwork/lcd_bmp_stream.h'), 'utf8');
  let hdr = body(cpp, 'Header header(').replace('Header out{};', 'const out = new Uint8Array(66);')
    .replace('auto le32 = [&](size_t offset, uint32_t value)', 'const le32 = (offset, value) =>')
    .replace(/static_cast<uint8_t>\((value >> \(8 \* i\))\)/g, '($1)')
    .replace('static_cast<uint32_t>(width)', 'width')
    .replace(/const uint32_t /g, 'const ').replace(/unsigned i/g, 'let i')
    .replace(/0U/g, '0').replace(/~3U/g, '~3')
    .replace(/'([BM])'/g, (_, c) => c.charCodeAt(0));
  let reader = body(cpp, 'size_t read(Source&').replace(/const (?:size_t|uint8_t) /g, 'const ')
    .replace(/size_t (count|done)/g, 'let $1').replace(/size_t i/g, 'let i')
    .replace(/uint8_t pair\[2\];/, 'const pair = new Uint8Array(2);')
    .replace(/bmp.size\(\)/g, 'bmp.length').replace(/size_t\(1\)/g, '1')
    .replace(/memcpy\(out, bmp.data\(\) \+ index, n\);/, 'out.set(bmp.subarray(index, index+n));')
    .replace(/source.read\(out \+ done, pairs\)/, 'source.read(out.subarray(done), pairs)');
  const header = new Function('width', 'height', hdr)(2, 2);
  const read = new Function('source', 'bmp', 'out', 'capacity', 'index', 'total', reader);
  const sourceBytes = Buffer.from([83,82,53,54,2,0,2,0, 0xf8,0,0x07,0xe0,0,0x1f,0xff,0xff]);
  const expected = Buffer.concat([Buffer.from(header), Buffer.from([0,0xf8,0xe0,0x07,0x1f,0,0xff,0xff])]);
  for (const chunk of [1,2,3,5,17,65,66,67,200]) {
    let pos = 0, offset = 0; const result = [];
    const file = { seek(n) { pos=n; return pos <= sourceBytes.length; },
      read(out,n) { const bytes=sourceBytes.subarray(pos,pos+n); out.set(bytes); pos+=bytes.length; return bytes.length; } };
    while (offset < expected.length) {
      const out = Buffer.alloc(chunk); const n = read(file,header,out,chunk,offset,expected.length);
      assert.ok(n > 0); result.push(...out.subarray(0,n)); offset+=n;
    }
    assert.deepEqual(Buffer.from(result), expected, `fragment size ${chunk}`);
  }
  assert.equal(Buffer.from(header).readInt32LE(22), -2);
  assert.equal(Buffer.from(header).readUInt32LE(54), 0xf800);
  const outDir = path.join(root, '.pio/freeze-investigation'); fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'rgb565-check.bmp'), expected);
});
