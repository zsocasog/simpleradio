// Firmware source contracts plus real execution of the unchanged web helper.
// Pool/parser arithmetic is compiled separately in album_art_policy.cpp.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const read = (name) => readFileSync(join(__dirname, "../..", name), "utf8");
const cache = read("src/artwork/artwork_cache.cpp");
const store = read("src/artwork/album_art_store.cpp");
const header = read("src/artwork/album_art_store.h");
const display = read("src/display/display.cpp");
const web = read("src/web/web_server.cpp");

test("album response branches into RAM before ANY filesystem preparation", () => {
  const download = cache.slice(cache.indexOf("bool ArtworkCache::download(const String&"));
  const ram = download.indexOf("prepareAlbumMemory(response.data, written, cacheKey, outPath, unavailable)");
  assert.ok(ram > 0);
  assert.ok(ram < download.indexOf("enforceCacheBudget(written +"));
  assert.match(download.slice(ram), /return ready; \/\/ No filesystem fallback/);
  const prepare = cache.slice(cache.indexOf("bool ArtworkCache::prepareAlbumMemory("), cache.indexOf("bool ArtworkCache::download(const String&"));
  assert.doesNotMatch(prepare, /LittleFS|enforceCacheBudget|drawJpgFile|drawPngFile/);
  assert.match(prepare, /frame->image = data;\s*data = nullptr;/);
  assert.match(prepare, /thumb\.drawJpg\(data, length/);
  assert.match(prepare, /thumb\.drawPng\(data, length/);
  assert.match(prepare, /max\(static_cast<float>\(LCD_THUMB_SIZE\) \/ info.width,/);
  assert.equal((prepare.match(/middle_center/g) || []).length, 2);
});

test("fixed two-slot pool cannot recycle published, preparing or leased frames", () => {
  assert.match(read("src/artwork/album_art_policy.h"), /SLOT_COUNT = 2;/);
  assert.match(header, /std::array<Preparation, AlbumArtPolicy::SLOT_COUNT> slots_/);
  assert.match(store, /AlbumArtPolicy::reusable\(static_cast<int>\(i\) == published_, slots_\[i\]\.use_count\(\)\)/);
  assert.match(store, /if \(chosen < 0\) return \{\};/);
  assert.ok(store.indexOf("next->path = String(PATH_PREFIX)") < store.indexOf("slots_[i] = next"));
  assert.match(store, /if \(slots_\[i\]\.use_count\(\) == 1\) old = std::move\(slots_\[i\]\);/);
  for (const lock of store.matchAll(/portENTER_CRITICAL\(&mux_\);([\s\S]*?)portEXIT_CRITICAL\(&mux_\);/g)) {
    assert.doesNotMatch(lock[1], /heap_caps_|\.reset\(|memcpy|delete |new |printf/);
  }
});

test("memory allocation leaves headroom and never puts LCD pixels in internal RAM", () => {
  assert.match(store, /pixelBytes \+ AlbumArtPolicy::PSRAM_HEADROOM/);
  assert.match(store, /MALLOC_CAP_INTERNAL \| MALLOC_CAP_8BIT\) < AlbumArtPolicy::INTERNAL_HEADROOM/);
  assert.match(store, /heap_caps_malloc\(pixelBytes, MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT\)/);
  assert.doesNotMatch(store, /pixels.*\bmalloc\(/);
  assert.match(cache, /if \(memoryUnavailable\) \{\s*albumArtTrace\("search stopped:/);
});

test("all album cache/readiness/cleanup paths bypass file operations", () => {
  for (const name of ["lcdThumbnailPath", "ensureLcdThumbnailPrepared", "requestLcdThumbnail", "lcdThumbnailReady", "artworkExists"]) {
    const start = cache.indexOf(`ArtworkCache::${name}(`);
    const fragment = cache.slice(start, cache.indexOf("\n}", start));
    assert.ok(fragment.indexOf("AlbumArtStore::isPath(imagePath)") > 0, name);
    if (fragment.includes("LittleFS")) assert.ok(fragment.indexOf("AlbumArtStore::isPath") < fragment.indexOf("LittleFS"), name);
  }
  assert.match(cache, /if \(url.startsWith\(ALBUM_ART_CACHE_PREFIX\)\) \{[\s\S]*?AlbumArtStore::instance\(\)\.find\(url\)[\s\S]*?return static_cast<bool>\(frame\);/);
  assert.match(cache, /void ArtworkCache::removeCachedArtworkFamily[^]*?AlbumArtStore::instance\(\)\.retire\(imagePath\);\s*return;/);
});

test("stale tracks are checked after decoding and before publishing web/LCD together", () => {
  const prepare = cache.slice(cache.indexOf("bool ArtworkCache::prepareAlbumMemory("), cache.indexOf("bool ArtworkCache::download(const String&"));
  assert.match(prepare, /current.playing &&\s*key == String\(ALBUM_ART_CACHE_PREFIX\) \+ current.artist \+ "\|" \+ current.title/);
  assert.ok(prepare.indexOf("if (!drawn || !stillCurrent())") < prepare.indexOf("AlbumArtStore::instance().publish(frame)"));
  assert.match(store, /frame->ready = true;\s*published_ =/);
});

test("async web response pins the exact immutable frame until transmission ends", () => {
  const route = web.slice(web.indexOf("server.on(AlbumArtStore::ROUTE"), web.indexOf('"/api/artwork/cache"'));
  assert.match(route, /\[frame\]\(uint8_t\* buffer, size_t maxLen, size_t index\)/);
  assert.match(route, /return frame->read\(buffer, maxLen, index\);/);
  assert.match(route, /frame->imageBytes/);
  assert.match(route, /Album image expired/);
  assert.match(route, /Cache-Control.*no-store/);
  assert.doesNotMatch(route, /LittleFS/);
  assert.match(store, /AlbumArtPolicy::readableBytes\(imageBytes, offset,/);
});

test("memory LCD rendering uses the same rounded aperture and stable render keys", () => {
  const draw = display.slice(display.indexOf("static void drawArt(const DisplayModel&"), display.indexOf("String Display::artRenderKeyFor"));
  assert.match(draw, /const auto frame = AlbumArtStore::instance\(\).acquire\(m.logoPath\);/);
  assert.match(draw, /for \(int y = 0; y < ART_SIZE; y \+= 4\)/);
  assert.match(draw, /writeArtRows\(frame->pixels \+ static_cast<size_t>\(y\) \* ART_SIZE, y, min\(4, ART_SIZE - y\)\)/);
  assert.ok(draw.indexOf("writeArtRows(frame->pixels") < draw.indexOf("LittleFS.exists"));
  assert.match(display, /return key.startsWith\("memory:"\)/);
  assert.match(display, /bool logoMissing = [^;]*ArtworkCache::instance\(\).artworkExists\(m.logoPath\)/);
  assert.match(read("src/display/display_presenter.cpp"), /if \(memoryAlbum\) \{\s*m.logoPath = memoryAlbum->path;\s*m.isAlbumArtwork = true;/);
});

test("existing web UI accepts query-based memory URLs without a data update", () => {
  const app = read("data/app.js");
  const fn = app.match(/function applyArtworkNode\([^]*?\n\}/)[0];
  const node = { dataset: {}, style: {}, textContent: "", classList: { add() {}, remove() {} } };
  vm.runInNewContext(`${fn}\napplyArtworkNode(node, '/api/artwork/album?id=12345678-00000001', 'track2');`,
    { node, stationAssetRevision: 1 });
  assert.equal(node.style.backgroundImage, 'url("/api/artwork/album?id=12345678-00000001&sr=track2")');
});
