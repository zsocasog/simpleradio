// Source-contract checks for the firmware pipeline; on-device timings/audio
// playback still need hardware testing.
// Run: node --test tools/tests/artwork_pipeline.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const cpp = read("src/artwork/artwork_cache.cpp");

function section(start, end) {
  const first = cpp.indexOf(start);
  assert.notEqual(first, -1, start);
  const last = end ? cpp.indexOf(end, first + start.length) : cpp.length;
  assert.ok(last > first, end);
  return cpp.slice(first, last);
}

const download = section("bool ArtworkCache::download(const String&", null);
const lcd = section("bool ArtworkCache::ensureLcdThumbnailPrepared(", "static void* artworkAlloc(");

test("remaining file-backed images preflight source plus LCD pixels before writing", () => {
  assert.match(download, /const bool cacheBudgetReserved = fillFrame;/);
  assert.match(download, /enforceCacheBudget\(written \+ \(cacheBudgetReserved \? LCD_THUMB_BYTES : 0\),/);
  assert.ok(download.indexOf("enforceCacheBudget(written +") < download.indexOf('LittleFS.open(tempPath, "w")'));
  assert.match(download, /ensureLcdThumbnailPrepared\(path, fillFrame, cacheBudgetReserved\)/);
});

test("only the private download path can skip the two redundant LCD checks", () => {
  const wrapper = section("bool ArtworkCache::ensureLcdThumbnail(", "bool ArtworkCache::ensureLcdThumbnailPrepared(");
  assert.match(wrapper, /ensureLcdThumbnailPrepared\(imagePath, fillFrame, false\)/);
  assert.equal((lcd.match(/enforceCacheBudget\(/g) || []).length, 2);
  assert.match(lcd, /if \(!cacheBudgetReserved\) \{\s*ArtworkPhaseTrace phase\("lcd-cache-reserve", fillFrame\);\s*enforceCacheBudget\(LCD_THUMB_BYTES, imagePath\);/);
  assert.match(lcd, /if \(!cacheBudgetReserved\) \{\s*ArtworkPhaseTrace phase\("lcd-cache-final", fillFrame\);\s*enforceCacheBudget\(0, thumbPath\);/);
  const header = read("src/artwork/artwork_cache.h");
  assert.ok(header.indexOf("private:") < header.indexOf("bool ensureLcdThumbnailPrepared("));
});

test("completed pairs retain a final cache check protecting the new image family", () => {
  const prepared = download.indexOf("const bool thumbnailReady = ensureLcdThumbnailPrepared(");
  const tail = download.slice(prepared, download.indexOf("String smallerImageUrl"));
  assert.match(tail, /ArtworkPhaseTrace phase\("cache-final", fillFrame\);\s*enforceCacheBudget\(0, outPath\);/);
  assert.ok(tail.indexOf("enforceCacheBudget(0, outPath)") < tail.indexOf('noteDownloadStatus(String("cached ")'));
  const budget = section("void ArtworkCache::enforceCacheBudget(", "String ArtworkCache::detectDownloadedExtension(");
  for (const protectedPath of ["keepPath", "current.cachedArtworkPath", "current.albumArtworkPath"]) {
    assert.ok(budget.includes(`cacheKeepProtects(entry.path, ${protectedPath})`));
  }
  assert.match(budget, /MIN_FS_FREE_BYTES/);
});

test("timings split network resolution, filesystem work and LCD preparation", () => {
  for (const name of ["CAA-resolve-total", "CAA-redirect", "CAA-metadata", "iTunes album-verification",
    "image-total", "cache-reserve", "image-write", "image-format", "image-commit", "image-compact", "cache-final",
    "lcd-total", "lcd-source-info", "lcd-allocate", "lcd-decode", "lcd-write", "lcd-commit"]) {
    assert.ok(cpp.includes(`ArtworkPhaseTrace ${name.endsWith("total") ? "totalPhase" : "phase"}("${name}"`), name);
  }
  assert.match(lcd, /timing lcd-validate: %lums/);
  const trace = section("class ArtworkPhaseTrace {", "enum class ArtworkJobKind");
  assert.match(trace, /~ArtworkPhaseTrace\(\)/);
  assert.match(trace, /millis\(\) - startedMs_/);
});

test("artwork keeps idle priority and yields between the same bounded write chunks", () => {
  assert.match(cpp, /ARTWORK_TASK_PRIORITY = 0;/);
  const write = section("bool ArtworkCache::writeBufferYielding(", "void ArtworkCache::requestEmbeddedImage(");
  assert.match(write, /CHUNK_BYTES = 4096;/);
  assert.match(write, /vTaskDelay\(1\);/);
  assert.doesNotMatch(write, /ArtworkPhaseTrace|albumArtTrace/);
  assert.match(read("src/audio/audio_player.cpp"), /AUDIO_PUMP_TASK_PRIORITY = 2;/);
});

test("decoded covers keep center-fill geometry and complete-file publication", () => {
  assert.match(lcd, /float scale = fillFrame\s*\? max\(/);
  assert.equal((lcd.match(/scale, scale, middle_center/g) || []).length, 3);
  assert.match(lcd, /writeBufferYielding\(out, pixels, pixelBytes\)/);
  assert.ok(lcd.indexOf("LittleFS.rename(tempPath, thumbPath)") < lcd.lastIndexOf("markThumbnailReady(imagePath, thumbPath)"));
  assert.match(download, /else if \(fillFrame\) \{[\s\S]*?removeCachedArtworkFamily\(path\);[\s\S]*?return false;/);
});

test("cancelled HTTP jobs cannot announce or attempt an HTTPS fallback", () => {
  const fallback = download.slice(download.indexOf("const String publicUrl"));
  assert.match(fallback, /if \(artworkCancelled\(\) \|\| \(memoryUnavailable && \*memoryUnavailable\) \|\| deadlineReached\(deadlineMs\) \|\| !allowSecureFallback\) return false;/);
  assert.ok(fallback.indexOf("if (artworkCancelled()") < fallback.indexOf("HTTP image unavailable"));
  assert.match(download, /if \(!albumSearchStillCurrent\(\)\) \{\s*noteDownloadStatus\("stale artwork cancelled"\)/);
});

test("Last.fm API errors and absent track fields are not reported as another song", () => {
  const lastfm = section("bool lastFmOk = fetchArtworkJson(", "provider == AlbumArtworkProvider::Deezer");
  assert.match(lastfm, /!doc\["track"\]\.is<JsonObject>\(\)/);
  assert.match(lastfm, /Last.fm API error: %d/);
  assert.ok(lastfm.indexOf("lastFmOk = false;") < lastfm.indexOf("Last.fm response: %s"));
  assert.match(lastfm, /else if \(!foundArtist.length\(\) \|\| !foundTitle.length\(\)\)/);
  assert.match(lastfm, /Last.fm track data incomplete: artist\/title missing/);
});

test("provider priority and artist album verification remain unchanged", () => {
  const search = section("bool ArtworkCache::resolveAndDownloadAlbumArtwork(", "String ArtworkCache::");
  assert.match(search, /MusicBrainz,\s*AlbumArtworkProvider::LastFm,\s*AlbumArtworkProvider::ITunes,\s*AlbumArtworkProvider::Deezer/);
  assert.match(cpp, /fallback images retained: single\/EP=%u, artist-collection=%u, unverified=%u, compilation=%u/);
  assert.match(cpp, /https:\/\/itunes.apple.com\/lookup\?id=/);
});
