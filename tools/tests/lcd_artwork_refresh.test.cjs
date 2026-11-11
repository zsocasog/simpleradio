// Exercise the actual completion -> queued display -> render-key path. Hardware
// writes are recorded; model equality and redraw decisions use production code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const cache = fs.readFileSync(path.join(root, 'src/artwork/artwork_cache.cpp'), 'utf8');
const display = fs.readFileSync(path.join(root, 'src/display/display.cpp'), 'utf8');
function body(source, marker) {
  const at = source.indexOf(marker); assert.ok(at >= 0, marker);
  const start = source.indexOf('{', at); let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(marker);
}
function js(source) {
  return source.replace(/auto finishRender = \[\]\(bool\) \{\};/, 'const finishRender = () => {};')
    .replace(/const auto ram =/g,'const ram =').replace(/LcdThumbnailRam::/g,'LcdThumbnailRam.')
    .replace('static_cast<long>(ram.modified())','ram.modified()')
    .replace(/const DisplayModel& /g, 'const ')
    .replace(/\b(?:const )?(?:DisplayFooterMode|DisplayModel|String|bool|int|uint8_t|uint32_t) /g, 'let ')
    .replace(/static_cast<uint8_t>\(([^)]+)\)/g, 'Number($1)')
    .replace(/\.length\(\)/g, '.length').replace(/\.c_str\(\)/g, '')
    .replace(/DisplayFooterMode::/g, 'DisplayFooterMode.')
    .replace(/AlbumArtStore::/g, 'AlbumArtStore.')
    .replace(/ArtworkCache::/g, 'ArtworkCache.');
}
function model(fields = {}) {
  return { station: 'Retro Rádió', stationId: 2, artist: '', title: '', playing: true,
    logoPath: '/logos/station-2-retro-radio.png', isAlbumArtwork: false,
    albumArtworkMode: true, apMode: false, networkConnected: true, volume: 50,
    hasStreamImage: false, ...fields,
    equals(other) { return Object.keys(this).filter(k => k !== 'equals').every(k => this[k] === other[k]); }
  };
}
function harness() {
  const draws = [], files = new Set(), valid = new Set(), ready = new Set(), ram = new Map();
  const thumb = (image, fill = false) => image.startsWith('/api/artwork/album?')
    ? image : `${image}${fill ? '_fill' : ''}.sr565`;
  const c = vm.createContext({ model, now: 1000, millis: () => c.now,
    taskStarted: true, pendingMutex: {}, hasPendingModel: false, pendingModel: null,
    pendingArtworkRefresh: false, deferredArtworkRefresh: false,
    pendingConfigApply: false, pendingActivity: false, pendingBootProgress: -1,
    pendingBootFinish: false, pendingPickerAction: 0, pendingPickerStationId: -1, pendingPickerRequest: 0,
    bootActive: false, hasDeferredBootModel: false, hasRenderedModel: true,
    idleBlanked: false, idleClockActive: false, idleGuardBlanked: false,
    stationPickerActive: false, volumePopupUntil: 0, lastFooterMode: 3,
    lastModel: model(), selectedModel: model(), lastArtworkRefreshPath: '',
    lastRenderedArtKey: 'placeholder:Retro Rádió:/logos/station-2-retro-radio.png',
    footerRenderKey: () => 3, footerMode: () => 3, audioFooterMode: () => true,
    DisplayFooterMode: { Station: 1, Volume: 2 },
    xSemaphoreTake: () => true, xSemaphoreGive() {}, pdTRUE: true, pdMS_TO_TICKS: ms => ms,
    displayModelsDifferForPlaybackInteraction: (a, b) => a.stationId !== b.stationId,
    clearVuBars() {}, resetVuAutoScale() {}, tickNow() {}, applyConfigNow() {}, notifyActivityNow() {},
    drawPlayerSurface() {}, drawInfoRegion() {}, drawFooterRegion() {},
    drawArt: m => draws.push({ path: m.logoPath, key: c.artRenderKeyFor(m) }),
    LittleFS: { exists: image => files.has(image) },
    LcdThumbnailRam: {acquire: image => ram.has(image) ? {modified:()=>ram.get(image)} : false},
    lcdThumbnailPath: thumb,
    stateUsesArtworkPath: (_state, image) => image === c.selectedModel.logoPath,
    thumbnailKnownReady: (_image, imageThumb) => ready.has(imageThumb),
    markThumbnailReady: (_image, imageThumb) => ready.add(imageThumb),
    validLcdThumbnailFile: imageThumb => valid.has(imageThumb),
    lcdThumbnailReady: image => valid.has(image),
    Serial: { printf() {} }, artworkTraceSerial: { printf() {} },
    AlbumArtStore: { isPath: image => image.startsWith('/api/artwork/album?'),
      instance: () => ({ acquire: image => valid.has(image) }) },
    AppConfig: { instance: () => ({ displayArtworkMode: c.selectedModel.albumArtworkMode ? 'album' : 'station' }) },
    PlayerState: { instance: () => ({}) },
    DisplayPresenter: { build: () => c.selectedModel }
  });
  c.ArtworkCache = { instance: () => ({ lcdThumbnailPath: thumb, artworkExists: image => files.has(image) }) };
  c.Display = { instance: () => ({ render: m => c.render(m), refreshArtwork: () => c.refreshArtwork() }) };
  for (const [name, args] of [
    ['render', 'm'], ['renderNow', 'm'], ['renderCurrent', ''], ['renderPartial', 'previous, footerModeChanged'],
    ['refreshArtwork', ''], ['refreshArtworkNow', ''], ['taskLoop', ''],
    ['artRenderKeyFor', 'm'], ['drawArtIfNeeded', 'm, force = false']
  ]) {
    const signature = name === 'artRenderKeyFor' ? 'String Display::artRenderKeyFor(' : `void Display::${name}(`;
    vm.runInContext(`function ${name}(${args}) ${js(body(display, signature))}`, c);
  }
  let completion = body(cache, 'bool ArtworkCache::refreshArtworkIfThumbnailReady(')
    .replace(/Display::/g, 'Display.').replace(/AppConfig::/g, 'AppConfig.')
    .replace(/DisplayPresenter::/g, 'DisplayPresenter.').replace(/PlayerState::/g, 'PlayerState.');
  vm.runInContext('function completed(imagePath, state, fillFrame = false) '+js(completion), c);
  files.add(c.lastModel.logoPath);
  return { c, draws, files, valid, ready, thumb,ram,
    prepare(image = c.selectedModel.logoPath, fill = false) {
      files.add(image); files.add(thumb(image, fill)); valid.add(thumb(image, fill));
    },
    complete(fill = false) { return c.completed(c.selectedModel.logoPath, { playing: c.selectedModel.playing }, fill); },
    service() { c.taskLoop(); }
  };
}

test('a local logo becoming ready in album mode redraws even without metadata or a model change', () => {
  const h = harness(); h.prepare(); assert.equal(h.complete(), true); h.service();
  assert.deepEqual(h.draws, [{ path: h.c.lastModel.logoPath, key: `thumb:${h.thumb(h.c.lastModel.logoPath)}` }]);
  assert.equal(h.c.lastModel.artist, ''); assert.equal(h.c.lastModel.title, '');
});

test('RAM-only station pixels refresh without a disk thumbnail and same-path replacement changes the render key',()=>{
  const h=harness(),image=h.c.selectedModel.logoPath,t=h.thumb(image);
  h.valid.add(t);h.ram.set(t,-1);h.complete();h.service();
  assert.equal(h.draws.length,1);assert.equal(h.draws[0].key,`ram-thumb:${t}:-1`);
  assert.equal(h.files.has(t),false);
  h.ram.set(t,-2);h.complete();h.service();
  assert.equal(h.draws.length,2);assert.equal(h.draws[1].key,`ram-thumb:${t}:-2`);
});

test('the same completion mechanism still refreshes station-logo mode', () => {
  const h = harness(); h.c.lastModel.albumArtworkMode = false; h.c.selectedModel.albumArtworkMode = false;
  h.prepare(); h.complete(); h.service(); assert.equal(h.draws.length, 1);
});

test('repeated readiness notifications do not redraw a logo already on screen', () => {
  const h = harness(); h.prepare(); h.complete(); h.service();
  for (let i = 0; i < 20; ++i) { h.complete(); h.service(); }
  assert.equal(h.draws.length, 1);
});

test('a RAM album replaces the fallback and is rendered only once', () => {
  const h = harness(); h.c.selectedModel = model({ logoPath: '/api/artwork/album?id=track1', isAlbumArtwork: true });
  h.prepare(); h.complete(); h.service();
  assert.equal(h.draws.length, 1); assert.equal(h.draws[0].key, 'memory:/api/artwork/album?id=track1');
  h.complete(); h.service(); assert.equal(h.draws.length, 1);
});

test('a file-backed album uses its prepared fill thumbnail, not the station variant', () => {
  const h = harness(); h.c.selectedModel = model({ logoPath: '/cache/art_album.jpg', isAlbumArtwork: true });
  h.prepare(h.c.selectedModel.logoPath, true); h.complete(true); h.service();
  assert.equal(h.draws.length, 1); assert.equal(h.draws[0].key, 'thumb:/cache/art_album.jpg_fill.sr565');
});

test('a newly ready fill thumbnail refreshes even when the source filename stays the same', () => {
  const h = harness(); const source = '/cache/art_stream.jpg';
  h.c.lastModel = model({ logoPath: source });
  h.c.selectedModel = model({ logoPath: source, isAlbumArtwork: true });
  h.c.lastRenderedArtKey = `thumb:${h.thumb(source)}`;
  h.prepare(source); h.prepare(source, true); h.complete(true); h.service();
  assert.equal(h.draws.length, 1); assert.equal(h.draws[0].key, 'thumb:/cache/art_stream.jpg_fill.sr565');
});

test('a remote cached logo has the same completion behavior as a local upload', () => {
  const h = harness(); const source = '/cache/art_station.png';
  h.c.lastModel = model({ logoPath: source }); h.c.selectedModel = model({ logoPath: source });
  h.c.lastRenderedArtKey = `placeholder:Retro Rádió:${source}`;
  h.prepare(source); h.complete(); h.service();
  assert.equal(h.draws.length, 1); assert.equal(h.draws[0].key, `thumb:${h.thumb(source)}`);
});

for (const overlay of ['stationPickerActive', 'idleBlanked', 'volumePopupUntil']) {
  test(`an image ready behind ${overlay} waits safely until the player is visible`, () => {
    const h = harness(); h.c[overlay] = overlay === 'volumePopupUntil' ? 2000 : true;
    h.prepare(); h.complete(); h.service();
    assert.equal(h.draws.length, 0); assert.equal(h.c.deferredArtworkRefresh, true);
    h.c[overlay] = overlay === 'volumePopupUntil' ? 0 : false; h.c.renderCurrent();
    assert.equal(h.draws.length, 1); assert.equal(h.c.deferredArtworkRefresh, false);
  });
}

test('an obsolete station completion cannot request a redraw of the current station', () => {
  const h = harness(); h.prepare('/logos/old.png');
  assert.equal(h.c.completed('/logos/old.png', {}), false); h.service();
  assert.equal(h.draws.length, 0); assert.equal(h.c.pendingArtworkRefresh, false);
});

test('an unfinished thumbnail cannot publish itself as ready', () => {
  const h = harness(); assert.equal(h.complete(), false); h.service();
  assert.equal(h.draws.length, 0); assert.equal(h.c.lastArtworkRefreshPath, '');
});
