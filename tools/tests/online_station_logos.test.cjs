const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.resolve(__dirname, '../../data/app.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function element() {
  const classes = new Set();
  return { dataset: {}, style: {}, children: [], textContent: '',
    classList: { add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name) },
    querySelector: () => null,
    set innerHTML(value) { this.children = []; this.html = value; },
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); }
  };
}
function browser(stations = []) {
  const list = element(), pending = [], requests = [], timers = new Map();
  let timer = 0;
  const c = vm.createContext({ stations, URL, URLSearchParams, stationAssetRevision: 1,
    document: { createElement: element }, $: () => list,
    stationInitial: name => name.trim().slice(0, 2).toUpperCase(),
    stationStreamUrl: result => result.url_resolved || result.url || '',
    remoteUrl: value => /^https?:\/\//i.test(value), logoUrl: value => value,
    escapeHtml: value => value || '', t: (_key, fallback) => fallback,
    setTimeout(fn) { timers.set(++timer, fn); return timer; },
    clearTimeout: id => timers.delete(id),
    Image: class {
      set src(url) { if (url) { requests.push(url); pending.push({ image: this, url }); } }
    }
  });
  vm.runInContext(app.slice(app.indexOf('function stationLogoPaths('),
    app.indexOf('\nfunction updateCover(')), c);
  vm.runInContext(app.slice(app.indexOf('function onlineStationLogoThumbnail('),
    app.indexOf('\nfunction renderSearchMoreControl(')), c);
  return { c, list, requests, pending, timers,
    render(result, append = false) { c.renderSearchResults([result], append); return list.children.at(-1).children[0]; },
    async complete(ok) { const request = pending.shift(); assert.ok(request); request.image[ok ? 'onload' : 'onerror'](); await tick(); return request.url; }
  };
}
const result = (favicon, name = 'Example Radio') => ({ name, favicon, url: 'https://stream.example.org/live' });

test('a search result without a logo keeps its initials and makes no image request', () => {
  const h = browser(), badge = h.render(result(''));
  assert.equal(badge.textContent, 'EX');
  assert.equal(badge.classList.contains('has-logo'), false);
  assert.deepEqual(h.requests, []);
});

test('initials stay visible until the original image has actually loaded', async () => {
  const h = browser(), source = 'https://radio.example.org/logo.png', badge = h.render(result(source));
  assert.equal(badge.textContent, 'EX'); assert.equal(badge.style.backgroundImage, '');
  await h.complete(true);
  assert.equal(badge.textContent, ''); assert.equal(badge.classList.contains('has-logo'), true);
  assert.equal(badge.style.backgroundImage, `url("${source}")`);
  assert.deepEqual(h.requests, [source]); // Working originals need no extra request.
});

test('a failed/HTML image tries a small public thumbnail without hiding the initials', async () => {
  const h = browser(), source = 'https://radio.example.org/old.png', badge = h.render(result(source));
  await h.complete(false);
  assert.equal(badge.textContent, 'EX'); assert.equal(badge.classList.contains('has-logo'), false);
  const thumbnail = new URL(h.pending[0].url);
  assert.equal(thumbnail.hostname, 'wsrv.nl');
  assert.equal(thumbnail.searchParams.get('url'), source);
  assert.equal(thumbnail.searchParams.get('w'), '96');
  assert.equal(thumbnail.searchParams.get('h'), '96');
  await h.complete(true);
  assert.equal(badge.textContent, ''); assert.equal(badge.classList.contains('has-logo'), true);
});

test('when every source fails, a search result retains initials rather than a black tile', async () => {
  const h = browser(), badge = h.render(result('https://radio.example.org/gone.png'));
  await h.complete(false); await h.complete(false);
  assert.equal(badge.textContent, 'EX'); assert.equal(badge.style.backgroundImage, '');
  assert.equal(badge.classList.contains('has-logo'), false); assert.equal(h.requests.length, 2);
});

test('timeouts also preserve the initials and continue to the next candidate', async () => {
  const h = browser(), badge = h.render(result('https://radio.example.org/slow.png'));
  h.timers.values().next().value(); await tick();
  assert.equal(badge.textContent, 'EX'); assert.equal(h.requests.length, 2);
  h.pending.shift(); await h.complete(true);
  assert.equal(badge.classList.contains('has-logo'), true);
});

test('saved logos are reused across stream variants before contacting the broken original', async () => {
  const source = 'https://radio.example.org/gone.png';
  const h = browser([{ id: 7, url: 'https://stream.example.org/320k', logo: source }]);
  const badge = h.render(result(source));
  assert.match(h.requests[0], /^\/api\/artwork\/station\?id=7&source=/);
  await h.complete(true);
  assert.equal(badge.classList.contains('has-logo'), true); assert.equal(h.requests.length, 1);
});

test('a matching saved stream supplies a logo even when the directory has no favicon', async () => {
  const h = browser([{ id: 3, url: 'https://stream.example.org/live', logo: '/logos/upload.png' }]);
  const badge = h.render(result('')); await h.complete(true);
  assert.equal(badge.style.backgroundImage, 'url("/logos/upload.png?sr=https%3A%2F%2Fstream.example.org%2Flive")');
});

test('identical online logos share one request and appending results preserves existing rows', async () => {
  const h = browser(), source = 'https://radio.example.org/shared.png';
  const first = h.render(result(source, 'First Radio'));
  const second = h.render(result(source, 'Second Radio'), true);
  assert.equal(h.list.children.length, 2); assert.equal(h.requests.length, 1);
  await h.complete(true);
  assert.equal(first.classList.contains('has-logo'), true); assert.equal(second.classList.contains('has-logo'), true);
});

test('late completion of a removed search result cannot replace a new result', async () => {
  const h = browser(); h.render(result('https://radio.example.org/old.png'));
  const latest = h.render(result('https://radio.example.org/new.png', 'New Radio'));
  await h.complete(true);
  assert.equal(h.list.children.length, 1); assert.equal(latest.textContent, 'NE');
  await h.complete(true); assert.equal(latest.style.backgroundImage, 'url("https://radio.example.org/new.png")');
});

test('private, signed and already resized URLs are never forwarded to a public resizer', () => {
  const h = browser();
  for (const source of ['', '/logos/local.png', 'file:///logo.png', 'data:image/png;base64,AAAA',
    'http://192.168.0.213/logo.png', 'http://127.1/logo.png', 'http://[::1]/logo.png',
    'http://radio.local/logo.png', 'http://radio/logo.png', 'https://radio.example.org:9443/logo.png',
    'https://user:pass@radio.example.org/logo.png', 'https://radio.example.org/logo.png?token=secret',
    'https://radio.example.org/logo.png?%61uth=secret', 'https://radio.example.org/logo.png#private',
    'https://wsrv.nl/?url=example.org/logo.png', 'https://images.weserv.nl/?url=example.org/logo.png']) {
    assert.equal(h.c.onlineStationLogoThumbnail(source), '', source);
  }
});

test('candidate selection does not replace the original favicon stored when saving', () => {
  const h = browser(), entry = result('https://radio.example.org/old.png');
  const before = JSON.stringify(entry); h.c.onlineStationLogoPaths(entry);
  assert.equal(JSON.stringify(entry), before);
});
