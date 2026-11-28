const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = readFileSync(path.join(__dirname, '../../data/wifi.js'), 'utf8');
// Run the shipped page handlers with deterministic scan, association and reachability events.
function setup({ scans = [[]], statuses = [{ state: 'idle' }], reachable = true, acknowledge = 204 } = {}) {
  function element() {
    const attributes = new Map();
    return {
      children: [], hidden: false, value: '', style: {}, classList: { toggle() {} },
      setAttribute(k, v) { attributes.set(k, v); }, removeAttribute(k) { attributes.delete(k); },
      querySelector() { return element(); }, replaceChildren() { this.children = []; },
      append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); },
      focus() {}
    };
  }
  const nodes = new Map(), calls = [], probes = [], visits = [];
  const field = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  field('setupHostnameField').hidden = true;
  const response = (code, data) => ({ status: code, ok: code < 400, json: async () => data, headers: new Headers() });
  const next = list => list.length > 1 ? list.shift() : list[0];
  const location = { href: 'http://192.168.4.1/', replace: url => visits.push(url) };
  const context = {
    window: {}, location, URL, URLSearchParams, AbortController,
    document: { getElementById: field, createElement: element, addEventListener() {} },
    setTimeout(fn, ms) { if (ms < 2200) queueMicrotask(fn); return 1; }, clearTimeout() {},
    Image: class { set src(url) { probes.push(new URL(url)); queueMicrotask(() => reachable ? this.onload() : this.onerror()); } },
    fetch: async (url, opts) => {
      calls.push({ url, body: opts.body });
      if (url.startsWith('/scan')) {
        const data = next(scans);
        return typeof data === 'number' ? response(data, []) : response(200, data);
      }
      if (url === '/setup/status') return response(200, next(statuses));
      if (url === '/save') return response(202, {});
      if (url === '/setup/finish') return response(acknowledge, {});
      throw Error(url);
    }
  };
  vm.runInNewContext(source.replace('  init();', '  window.ready = init();'), context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { ready: context.window.ready, field, calls, probes, visits, settle };
}

test('an empty or failed scan can be retried and duplicate networks keep their strongest entry', async () => {
  const page = setup({ scans: [503, [], 202, [
    { ssid: 'Home', rssi: -81, open: false }, { ssid: 'Guest', rssi: -65, open: true },
    { ssid: 'Home', rssi: -42, open: false }
  ]] });
  const { field } = page;
  await page.ready;
  assert.equal(field('rescan').disabled, false);
  await field('rescan').onclick();
  assert.equal(field('connect').disabled, true);
  await field('rescan').onclick();
  const options = field('networks').children;
  assert.deepEqual(options.map(row => row.children[1].textContent), ['Home', 'Guest']);
  options[1].onclick();
  assert.equal(field('passwordField').hidden, true);
  assert.equal(field('connect').disabled, false);
  options[0].onclick();
  assert.equal(field('passwordField').hidden, false);
  assert.equal(field('connect').disabled, true);
});

const connected = { state: 'connected', id: 'afc01234', ip: '192.168.1.27' };
test('setup supports named and automatic hosts while older firmware keeps its original save contract', async () => {
  const defaults = { defaultHostname: 'simpleradio-ab1234', hostname: 'simpleradio-ab1234' };
  for (const [info, initial, entered, expected] of [
    [defaults, '', 'Konyha-2', 'konyha-2'],
    [{ ...defaults, hostname: 'elozo-radio' }, 'elozo-radio', '', ''],
    [{}, '', '', null]
  ]) {
    const page = setup({ scans: [[{ ssid: 'Guest', open: true }]],
      statuses: [{ state: 'idle', ...info }, { ...connected, hostname: expected || info.defaultHostname }] });
    await page.ready;
    assert.equal(page.field('setupHostnameField').hidden, expected === null);
    const input = page.field('setupHostname');
    assert.equal(input.value, initial);
    input.value = entered;
    page.field('networks').children[0].onclick();
    page.field('setupForm').onsubmit({ preventDefault() {} });
    await page.settle();
    assert.equal(page.calls.find(c => c.url === '/save').body.get('hostname'), expected);
    assert.equal(page.field('joinedHostname').hidden, expected === null);
    assert.deepEqual(page.visits, ['http://192.168.1.27/']);
  }
});

test('failed credentials leave the form usable and a corrected attempt opens the verified LAN address', async () => {
  const page = setup({ scans: [[{ ssid: 'Home', open: false }]],
    statuses: [{ state: 'idle' }, { state: 'join_failed' }, { state: 'connecting' }, connected] });
  const { field, calls, probes, visits } = page;
  await page.ready;
  field('networks').children[0].onclick();
  for (const value of ['bad-demo', 'correct-demo']) {
    field('pass').value = value; field('pass').oninput();
    field('setupForm').onsubmit({ preventDefault() {} });
    await page.settle();
    if (value === 'bad-demo') assert.equal(field('pass').disabled, false);
  }
  assert.equal(calls.filter(c => c.url === '/save').length, 2);
  assert.equal(calls.find(c => c.url === '/setup/finish').body.get('ip'), connected.ip);
  assert.equal(probes[0].searchParams.get('id'), connected.id);
  assert.deepEqual(visits, ['http://192.168.1.27/']);
  assert.equal(field('pass').value, '');
});

test('an unreachable radio leaves a usable address without navigating', async () => {
  const page = setup({ statuses: [connected], reachable: false });
  await page.ready;
  assert.ok(page.probes.length > 1);
  assert.deepEqual(page.visits, []);
  assert.equal(page.field('radioLink').href, 'http://192.168.1.27/');
  assert.equal(page.field('handoff').hidden, false);
});

test('a changed address or a lost link before acknowledgement returns to the join flow', async () => {
  const page = setup({ statuses: [connected, { state: 'join_failed' }], acknowledge: 409 });
  await page.ready;
  assert.equal(page.field('setupForm').hidden, false);
  assert.equal(page.probes.length, 0);
  assert.deepEqual(page.visits, []);
});
