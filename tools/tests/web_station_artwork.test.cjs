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
  const requests = [], pending = [], statuses = new Map(), nodes = [];
  const c = vm.createContext({ stationAssetRevision: 1, now: 1000,
    Date: { now: () => c.now },
    setTimeout: () => 1, clearTimeout() {}, queueMicrotask,
    remoteUrl: p => /^https?:\/\//i.test(p),
    logoUrl: p => p,
    document: { querySelectorAll: () => nodes.filter(node => node.isConnected !== false) },
    Image: class {
      set src(url) { requests.push(url); pending.push({ image: this, url }); }
    }
  });
  const code = app.slice(app.indexOf('function stationLogoPaths('), app.indexOf('\nfunction updateCover('));
  vm.runInContext(code, c);
  return { c, requests, pending, statuses,
    node: () => {
      const classes = new Set();
      const node = { dataset: {}, style: {}, textContent: '', isConnected: true,
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) } };
      nodes.push(node); return node;
    },
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

test('a station badge created off-DOM loads after its row is appended', async () => {
  const h = browser(), n = h.node(), local = '/api/artwork/station?id=5&sr=s5';
  n.isConnected = false;
  h.c.applyArtworkNode(n, '/api/artwork/station?id=5', 's5', 'DA');
  n.isConnected = true; // stationRow() returns, then renderStations() appends it.
  h.statuses.set(local, true); await tick(); await h.finish();
  assert.deepEqual(h.requests, [local]);
  assert.equal(n.style.backgroundImage, `url("${local}")`);
  assert.equal(n.textContent, ''); assert.ok(n.classList.contains('has-logo'));
});

test('an off-DOM row discarded before mounting never starts an image request', async () => {
  const h = browser(), n = h.node(); n.isConnected = false;
  h.c.applyArtworkNode(n, '/api/artwork/station?id=5', 's5', 'DA');
  await tick(); await h.finish();
  assert.deepEqual(h.requests, []); assert.equal(n.textContent, 'DA');
});

test('an off-DOM badge changed before mounting requests only its final image', async () => {
  const h = browser(), n = h.node(); n.isConnected = false;
  h.c.applyArtworkNode(n, '/old.png', 'old', 'OL');
  h.c.applyArtworkNode(n, '/new.png', 'new', 'NE');
  n.isConnected = true; h.statuses.set('/new.png?sr=new', true);
  await tick(); await h.finish();
  assert.deepEqual(h.requests, ['/new.png?sr=new']);
  assert.equal(n.style.backgroundImage, 'url("/new.png?sr=new")');
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

test('cache-ready notification refreshes a missing saved logo immediately without a player-state change', async () => {
  const h = browser(), n = h.node(), local = '/api/artwork/station?id=5&sr=s5';
  h.c.applyArtworkNode(n, '/api/artwork/station?id=5', 's5', 'DA'); await h.finish();
  assert.equal(n.textContent, 'DA'); assert.ok(n.dataset.artworkRetryAt > h.c.now);
  h.statuses.set(local, true);
  h.c.refreshMissingStationArtwork(); await h.finish();
  assert.equal(n.style.backgroundImage, `url("${local}")`); assert.equal(h.requests.length, 2);
});

test('a ready notification preserves visible images and does not retry unsaved search results', async () => {
  const h = browser(), good = h.node(), missing = h.node(), search = h.node();
  h.statuses.set('/api/artwork/station?id=1&sr=s1', true);
  h.c.applyArtworkNode(good, '/api/artwork/station?id=1', 's1', 'OK');
  h.c.applyArtworkNode(missing, '/api/artwork/station?id=2', 's2', 'NO');
  h.c.applyArtworkNode(search, 'https://missing.example/search.png', 'search', 'SE');
  await h.finish();
  const generation = good.dataset.artworkGeneration;
  h.statuses.set('/api/artwork/station?id=2&sr=s2', true);
  h.c.refreshMissingStationArtwork(); await h.finish();
  assert.equal(h.requests.length, 4); assert.equal(good.dataset.artworkGeneration, generation);
  assert.equal(good.style.backgroundImage, 'url("/api/artwork/station?id=1&sr=s1")');
  assert.equal(missing.style.backgroundImage, 'url("/api/artwork/station?id=2&sr=s2")');
  assert.equal(search.textContent, 'SE');
});

test('an old pending request for the SAME station cannot replace a notification-refreshed image', async () => {
  const h = browser(), n = h.node(), local = '/api/artwork/station?id=5&sr=s5';
  h.c.applyArtworkNode(n, '/api/artwork/station?id=5', 's5', 'DA', ['https://old.example/logo.png']);
  const old = h.pending.shift();
  h.c.refreshMissingStationArtwork();
  h.statuses.set(local, true); await h.finish();
  old.image.onerror(); await tick();
  assert.equal(n.style.backgroundImage, `url("${local}")`);
  assert.deepEqual(h.requests, [local, local]);
});

test('cache notifications and late image responses leave detached list rows alone', async () => {
  const h = browser(), n = h.node();
  h.c.applyArtworkNode(n, '/api/artwork/station?id=5', 's5', 'DA');
  const old = h.pending.shift(); n.isConnected = false;
  h.c.refreshMissingStationArtwork(); old.image.onload(); await tick();
  assert.equal(n.style.backgroundImage, ''); assert.equal(h.requests.length, 1);
});

test('cache-ready messages include an ordinary complete player snapshot for older WebUIs', () => {
  const web = fs.readFileSync(path.join(root, 'src/web/web_server.cpp'), 'utf8');
  const functionText = web.match(/void notifyStationArtworkReady\(\) \{[^]*?\n\}/)[0];
  const code = functionText.slice(functionText.indexOf('{'))
    .replace('String state', 'let state').replace('PlayerState::instance().toJson()', 'snapshot()')
    .replace('state.remove(state.length() - 1);', 'state = state.slice(0, -1);');
  const frames = [], state = { playing: true, volume: 35, stationId: 2, artist: 'Madonna', title: 'Love Sensation [2026]' };
  let snapshots = 0;
  const notify = new Function('ws', 'snapshot', code);
  const snapshot = () => { ++snapshots; return JSON.stringify(state); };
  notify({ count: () => 0, textAll: s => frames.push(s) }, snapshot);
  assert.equal(snapshots, 0);
  notify({ count: () => 1, textAll: s => frames.push(s) }, snapshot);
  const parsed = JSON.parse(frames[0]); assert.equal(parsed.stationArtworkReady, true);
  delete parsed.stationArtworkReady; assert.deepEqual(parsed, state);
  assert.doesNotMatch(code, /Display|render\(/);
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
