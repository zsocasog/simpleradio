const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const cpp = fs.readFileSync(path.join(root, 'src/display/display.cpp'), 'utf8');
const header = fs.readFileSync(path.join(root, 'src/display/display.h'), 'utf8');
function body(name) {
  const at = cpp.search(new RegExp(`(?:void|bool) Display::${name}\\(`)); assert.ok(at >= 0, name);
  const start = cpp.indexOf('{', at); let depth = 0;
  for (let i = start; i < cpp.length; i++) {
    if (cpp[i] === '{') depth++;
    if (cpp[i] === '}' && --depth === 0) return cpp.slice(start, i + 1);
  }
  throw Error(name);
}
const js = code => code.replace(/\bconst (?:uint8_t|uint32_t)\b/g, 'const')
  .replace(/\bconst int\b/g, 'const')
  .replace(/\b(?:bool|int|uint32_t|DisplayModel) (\w+)/g, 'let $1')
  .replace(/static_cast<uint8_t>\(([^)]+)\)/g, '$1');
function harness() {
  const draws = [], requests = [];
  const atomic = () => ({ value: false, store(v) { this.value = v; }, exchange(v) { const old = this.value; this.value = v; return old; } });
  const c = vm.createContext({
    hasRenderedModel: true, lastFooterMode: 0, desired: 4, now: 1000,
    bootActive: false, idleBlanked: false, idleClockActive: false, idleGuardBlanked: false,
    deferredArtworkRefresh: false, drawArtIfNeeded() { c.deferredArtworkRefresh = false; requests.push('art'); },
    lastModel: { apMode: false }, stationPickerActive: false, volumePopupUntil: 0,
    millis: () => c.now, footerRenderKey: () => c.desired,
    growthForFooter: key => key === 2 ? 28 : 0,
    playerLayout: { position: 0, target: 0,
      snap(v) { this.target = this.position = v; },
      active() { return this.target !== this.position; },
      start(v) { this.target = v; },
      advance() { this.position = c.nextPosition ?? this.position; return c.nextPosition !== undefined; }
    },
    playerSlide: { running: false, prepare() { return this.running = !c.noMemory; }, beginTiming() {}, clearFooter() {}, paint() {}, warm() {} },
    FOOTER_REGION_X: 0, FOOTER_REGION_Y: 242, FOOTER_REGION_W: 480, FOOTER_REGION_H: 78,
    drawPlayerSurfaceRegion() {}, setSpectrumDisplayVisibility() {},
    renderCurrent() { c.playerLayout.snap(c.growthForFooter(c.desired)); c.playerSlide.running = false; c.drawFooterRegion(); c.lastFooterMode = c.desired; },
    clearVuBars() {}, resetVuAutoScale() {}, drawFooterRegion() { draws.push(c.desired); c.onDraw?.(); },
    taskStarted: true, pendingMutex: {}, pendingConfigApply: atomic(), pendingActivity: atomic(), pendingArtworkRefresh: atomic(),
    pdTRUE: 1, pdMS_TO_TICKS: v => v, xSemaphoreTake: () => 0, xSemaphoreGive() { throw Error('Unowned mutex'); },
    applyConfigNow: () => requests.push('config'), notifyActivityNow: () => requests.push('activity'),
    refreshArtworkNow: () => requests.push('artwork'), tickNow() {},
  });
  for (const name of ['renderPlayerLayout', 'renderFooterConfigFrame', 'applyConfig', 'notifyActivity', 'refreshArtwork', 'taskLoop']) {
    vm.runInContext(`function ${name}(${name === 'renderPlayerLayout' ? 'footerKey' : ''}) ${js(body(name))}`, c);
  }
  return { c, draws, requests };
}
test('changing visible footers paints without another player update, then stays unchanged', () => {
  const { c, draws } = harness(); c.renderFooterConfigFrame();
  assert.deepEqual(draws, [4]); assert.equal(c.lastFooterMode, 4);
  c.renderFooterConfigFrame(); assert.deepEqual(draws, [4]);
});
test('a hidden footer is not acknowledged; the latest selection paints when visible', () => {
  for (const key of ['bootActive', 'idleBlanked', 'idleClockActive', 'idleGuardBlanked', 'stationPickerActive']) {
    const { c, draws } = harness(); c[key] = true; c.renderFooterConfigFrame();
    assert.equal(c.lastFooterMode, 0, key); assert.deepEqual(draws, []);
    c.desired = 3; c[key] = false; c.renderFooterConfigFrame();
    assert.deepEqual(draws, [3], key); assert.equal(c.lastFooterMode, 3);
  }
});
test('AP mode, startup without a model, and volume popup defer footer painting', () => {
  for (const setup of [c => c.lastModel.apMode = true, c => c.hasRenderedModel = false, c => c.volumePopupUntil = 1200]) {
    const { c, draws } = harness(); setup(c); c.renderFooterConfigFrame();
    assert.equal(c.lastFooterMode, 0); assert.deepEqual(draws, []);
    c.lastModel.apMode = false; c.hasRenderedModel = true; c.now = 1201;
    c.renderFooterConfigFrame(); assert.deepEqual(draws, [4]);
  }
});
test('a setting changed during painting is reconciled on the next frame', () => {
  const { c, draws } = harness(); c.onDraw = () => { c.desired = 5; };
  c.renderFooterConfigFrame(); assert.equal(c.lastFooterMode, 4);
  c.renderFooterConfigFrame(); assert.deepEqual(draws, [4, 5]); assert.equal(c.lastFooterMode, 5);
});

test('off grows once, a quick reversal starts at the painted width and the selected footer wins', () => {
  const { c, draws } = harness();
  c.desired = 2; c.renderFooterConfigFrame();
  c.nextPosition = 12; c.renderFooterConfigFrame();
  assert.equal(c.playerLayout.position, 12); assert.deepEqual(draws, []);
  c.desired = 5; c.nextPosition = 8; c.renderFooterConfigFrame();
  assert.equal(c.playerLayout.position, 8); assert.deepEqual(draws, []);
  c.desired = 3; c.nextPosition = 0; c.renderFooterConfigFrame();
  assert.deepEqual(draws, [3]); assert.equal(c.playerSlide.running, false);
  c.renderFooterConfigFrame(); assert.deepEqual(draws, [3]);
});

test('reversal before the first frame restores the footer that was already erased', () => {
  const { c, draws } = harness();
  c.desired = 2; c.renderFooterConfigFrame();
  c.desired = c.lastFooterMode; c.renderFooterConfigFrame();
  assert.deepEqual(draws, [0]); assert.equal(c.playerSlide.running, false);
});

test('the completed transition publishes pending artwork without another model update', () => {
  const { c, requests } = harness();
  c.desired = 2; c.renderFooterConfigFrame();
  c.deferredArtworkRefresh = true;
  c.nextPosition = 9; c.renderFooterConfigFrame();
  assert.deepEqual(requests, []);
  c.nextPosition = 28; c.renderFooterConfigFrame(); c.renderFooterConfigFrame();
  assert.deepEqual(requests, ['art']);
});

test('an exhausted animation buffer settles directly, and a picker releases an interrupted transition', () => {
  const { c, draws } = harness(); c.desired = 2; c.noMemory = true;
  c.renderFooterConfigFrame();
  assert.deepEqual(draws, [2]); assert.equal(c.playerLayout.position, 28);
  c.noMemory = false; c.desired = 4; c.renderFooterConfigFrame();
  c.stationPickerActive = true; c.renderFooterConfigFrame();
  assert.equal(c.playerSlide.running, false); assert.deepEqual(draws, [2]);
  c.stationPickerActive = false; c.nextPosition = 0; c.renderFooterConfigFrame();
  assert.deepEqual(draws, [2,4]);
});
test('config, wake and artwork requests survive a busy model mailbox and coalesce', () => {
  const { c, requests } = harness();
  c.xSemaphoreTake = () => { throw Error('A flag-only producer must not wait for model copying'); };
  for (let n = 0; n < 4; n++) { c.applyConfig(); c.notifyActivity(); c.refreshArtwork(); }
  c.xSemaphoreTake = () => 0; c.taskLoop();
  assert.deepEqual(requests, ['activity', 'config', 'artwork']);
  c.taskLoop(); assert.equal(requests.length, 3);
  for (const name of ['pendingConfigApply', 'pendingActivity', 'pendingArtworkRefresh']) {
    assert.match(header, new RegExp(`std::atomic<bool> ${name}`));
  }
});
test('requests arriving while a prior request is handled survive until the next iteration', () => {
  const { c, requests } = harness(); let first = true;
  c.applyConfigNow = () => { requests.push('config'); if (first) { first = false; c.applyConfig(); } };
  c.applyConfig(); c.taskLoop(); c.taskLoop(); c.taskLoop();
  assert.deepEqual(requests, ['config', 'config']);
});
test('rendering records the footer only after painting, and a periodic retry remains connected', () => {
  assert.doesNotMatch(body('renderNow'), /lastFooterMode\s*=/);
  for (const name of ['renderCurrent', 'renderPartial'])
    assert.match(body(name), /const uint8_t drawnFooter = footerRenderKey\(\);[^]*?drawFooterRegion\(m\);\s*lastFooterMode = drawnFooter;/);
  assert.match(body('tickNow'), /renderFooterConfigFrame\(\);\s*renderAudioMeterFrame\(false\);/);
});
