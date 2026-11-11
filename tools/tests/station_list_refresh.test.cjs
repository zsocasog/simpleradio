const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const app = fs.readFileSync(path.resolve(__dirname, '../../data/app.js'), 'utf8');
const section = (from, to) => {
  const start = app.indexOf(from), end = app.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, from);
  return app.slice(start, end);
};
const tick = () => new Promise(resolve => setImmediate(resolve));

// Minimal connected DOM for the real row builder, renderer and async image loader.
// Chrome dialog tests additionally exercise SRUI's nested station identity nodes.
class Element {
  constructor() {
    this.children = []; this.parentNode = null; this.style = {}; this.className = '';
    this.textContent = ''; this.html = ''; this.connectedRoot = false;
    this.dataset = new Proxy({}, { set: (target, key, value) => { target[key] = String(value); return true; } });
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(n => !names.includes(n)).join(' '); }
    };
  }
  get isConnected() { return this.connectedRoot || !!this.parentNode?.isConnected; }
  set innerHTML(value) { this.children.forEach(n => { n.parentNode = null; }); this.children = []; this.html = value; }
  get innerHTML() { return this.html; }
  append(...nodes) { nodes.forEach(n => this.appendChild(n)); }
  appendChild(node) {
    if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(n => n !== node);
    node.parentNode = this; this.children.push(node); return node;
  }
  setAttribute() {}
  addEventListener() {}
  querySelectorAll(selector) {
    const className = selector.match(/^\.([\w-]+)/)?.[1];
    return this.children.flatMap(n => [
      ...(className && n.classList.contains(className) && (!selector.includes('[data-station-id]') || n.dataset.stationId !== undefined) ? [n] : []),
      ...n.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function browser() {
  const quick = new Element(), manager = new Element(); quick.connectedRoot = manager.connectedRoot = true;
  const requests = [], pending = [], controls = [];
  const c = vm.createContext({ stationAssetRevision: 1, stationLogoRevisions: new Map(),
    stations: [1, 2, 3].map(id => ({ id, name: 'Radio ' + id, url: 'stream-' + id, logo: '/logos/' + id + '.png' })),
    currentStationId: 1, savedStationFilter: '', renderedStationId: -1, renderedStationCount: -1, renderedStationFilter: '',
    $: id => ({ stations: quick, stationManager: manager })[id],
    document: { createElement: () => new Element(), querySelectorAll: s => [...quick.querySelectorAll(s), ...manager.querySelectorAll(s)] },
    Date: { now: () => 1000 }, setTimeout: () => 1, clearTimeout() {}, queueMicrotask, console, window: {},
    remoteUrl: s => /^https?:\/\//i.test(s), escapeHtml: s => String(s),
    t: (_key, fallback) => fallback, setText() {}, syncStationPlayButton() {},
    toggleStationPlayback: id => controls.push(id),
    fetch: async () => ({ ok: true, json: async () => ({ stations: c.stations }) }),
    Image: class { set src(url) { requests.push(url); pending.push(this); } }
  });
  vm.runInContext(section('function stationInitial(', 'function clearStationDropTargets(') +
    section('function renderStations(', 'function filterSavedStations(') +
    section('async function loadStations(', 'function updateCover(') +
    section('async function uploadStationLogo(', 'async function cacheArtworkViaBrowser('), c);
  const badges = list => list.querySelectorAll('.station-badge');
  return { c, quick, manager, requests, pending, controls, badges,
    async finish() {
      await tick();
      for (let i=0;i<12 && pending.length;i++) { pending.splice(0).forEach(image => image.onload()); await tick(); }
    }
  };
}

test('adding a station preserves loaded images in both lists without refetching them', async () => {
  const h = browser(); h.c.renderStations(true); await h.finish();
  const quick = h.badges(h.quick), manager = h.badges(h.manager), before = h.requests.length;
  h.c.stations.push({ id: 4, name: 'New Radio', url: 'stream-4', logo: '/logos/4.png' });
  await h.c.loadStations();
  for (let i = 0; i < 3; ++i) {
    assert.equal(h.badges(h.quick)[i], quick[i]); assert.equal(h.badges(h.manager)[i], manager[i]);
    assert.ok(manager[i].classList.contains('has-logo')); assert.ok(quick[i].classList.contains('has-logo'));
  }
  await h.finish();
  assert.equal(h.requests.length - before, 1, 'only the new logo is fetched, shared by both lists');
  assert.equal(h.c.stationAssetRevision, 1);
});

test('an image still loading completes on the same mounted badge across a list refresh', async () => {
  const h = browser(); h.c.renderStations(true); await tick();
  const badges = h.badges(h.manager), before = h.requests.length;
  await h.c.loadStations(); await h.finish();
  assert.equal(before, 2, 'the idle pool starts only two of the three unique logos');
  assert.equal(h.requests.length, 3, 'each queued URL still starts exactly once across the refresh');
  badges.forEach((badge, i) => { assert.equal(h.badges(h.manager)[i], badge); assert.ok(badge.classList.contains('has-logo')); });
});

test('reordering and selection refresh the controls and numbers without replacing loaded badges', async () => {
  const h = browser(); h.c.renderStations(true); await h.finish();
  const badges = h.badges(h.manager), before = h.requests.length;
  h.c.stations.reverse(); h.c.currentStationId = 3; h.c.renderStations(true); await h.finish();
  const rows = h.manager.querySelectorAll('.station-item');
  assert.deepEqual(rows.map(row => row.dataset.stationId), ['3', '2', '1']);
  assert.equal(rows[0].querySelector('.station-badge'), badges[2]);
  assert.ok(rows[0].classList.contains('active')); assert.ok(!rows[2].classList.contains('active'));
  assert.equal(rows[0].querySelector('.station-number').textContent, '#01');
  rows[0].querySelector('.item-actions').children[0].onclick(); assert.deepEqual(h.controls, [3]);
  assert.equal(rows[0].querySelector('.item-actions').children[1].disabled, true);
  assert.equal(rows[2].querySelector('.item-actions').children[2].disabled, true);
  assert.equal(h.requests.length, before);
});

test('uploading a replacement at the same path invalidates only that image, even within one clock tick', async () => {
  const h = browser(); h.c.renderStations(true); await h.finish();
  const original = h.requests.slice(); h.c.logoPngBlob = async () => 'PNG';
  h.c.fetch = async () => ({ ok: true, json: async () => ({ path: '/logos/1.png' }) });
  for (let repeat = 0; repeat < 2; ++repeat) {
    assert.equal(await h.c.uploadStationLogo(1, 'https://logo.example/new.png'), '/logos/1.png');
    const before = h.requests.length; h.c.renderStations(true); await h.finish();
    assert.equal(h.requests.length - before, 1); assert.ok(h.requests.at(-1).startsWith('/logos/1.png?'));
    assert.ok(!original.includes(h.requests.at(-1)));
  }
  assert.equal(new Set(h.requests).size, h.requests.length);
  assert.equal(h.c.stationAssetRevision, 1);
});

test('a failed logo upload and an ordinary list reload keep every existing image valid', async () => {
  const h = browser(); h.c.renderStations(true); await h.finish();
  const before = h.requests.length; h.c.logoPngBlob = async () => 'PNG';
  h.c.fetch = async url => url.startsWith('/api/logo/upload')
    ? { ok: false } : { ok: true, json: async () => ({ stations: h.c.stations }) };
  assert.equal(await h.c.uploadStationLogo(1, 'https://logo.example/new.png'), '');
  await h.c.loadStations(); await h.finish();
  assert.equal(h.requests.length, before); assert.equal(h.c.stationLogoRevisions.size, 0);
});
