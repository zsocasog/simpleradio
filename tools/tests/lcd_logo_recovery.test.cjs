const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const cpp = fs.readFileSync(path.resolve(__dirname, "../../src/artwork/artwork_cache.cpp"), "utf8");
function block(marker) {
  const index = cpp.indexOf(marker); assert.ok(index >= 0, marker);
  const start = cpp.indexOf("{", index);
  let depth = 0;
  for (let i = start; i < cpp.length; ++i) {
    if (cpp[i] === "{") ++depth;
    if (cpp[i] === "}" && --depth === 0) return cpp.slice(start, i + 1);
  }
  throw new Error(marker);
}
const validation = block('if (!fillFrame && (lower.endsWith(".jpg")')
  .replace("File source =", "const source =")
  .replace(/struct FileInput \{[\s\S]*?\} input\{source\};/, "")
  .replace(/LcdImagePolicy::inspect\(input\)/g, "policy.inspect(source)")
  .replace(/LcdImagePolicy::Jpeg::Unsupported/g, "policy.Unsupported")
  .replace(/LcdImagePolicy::needsConversion/g, "policy.needsConversion")
  .replace(/const (auto|bool) /g, "const ")
  .replace(/imagePath\.c_str\(\)/g, "imagePath");
function validate(kind, sourcePath) {
  const removed = [];
  const context = vm.createContext({
    policy: { Unsupported: 1, inspect: () => kind, needsConversion: value => value > 0 },
    LittleFS: { open: () => ({ close() {} }), remove: p => { removed.push(p); return true; } },
    unlock() {}, artworkTraceSerial: { printf() {} }
  });
  vm.runInContext("function run(imagePath) { const lower = imagePath.toLowerCase(); " + validation + ' return "KEEP"; }', context);
  return { result: context.run(sourcePath), removed };
}
test("only a proven unsupported generated JPEG is retired for replacement", () => {
  assert.deepEqual(validate(1, "/cache/art_12345678.jpg"), {
    result: false, removed: ["/cache/art_12345678.jpg"]
  });
  assert.deepEqual(validate(1, "/logos/user.jpg"), { result: false, removed: [] });
  assert.deepEqual(validate(1, "/cache/art_nested/user.jpg"), { result: false, removed: [] });
});
test("a baseline source or inconclusive file read is never deleted", () => {
  assert.deepEqual(validate(0, "/cache/art_12345678.jpg"), { result: "KEEP", removed: [] });
  assert.deepEqual(validate(2, "/cache/art_12345678.jpg"), { result: false, removed: [] });
});
test("ready LCD pixels win before cached-source checks and album jobs bypass station validation", () => {
  const prepare = block("bool ArtworkCache::ensureLcdThumbnailPrepared(");
  assert.ok(prepare.indexOf("validLcdThumbnailFile(thumbPath)") < prepare.indexOf('if (!fillFrame && (lower.endsWith(".jpg")'));
  const download = block("bool ArtworkCache::download(");
  assert.match(download, /if \(!cacheKey\.length\(\) &&\s*LcdImagePolicy::needsConversion/);
  assert.ok(download.indexOf("LcdImagePolicy::inspect(response.data, written)") <
    download.indexOf("enforceCacheBudget(written"));
});
function cppString(text) { return { length: () => text.length, c_str: () => text }; }
const probe = block("if (state.cachedArtworkPath.length())")
  .replace(/const uint32_t /g, "const ")
  .replace(/PlayerState::instance\(\)\./g, "player.");
function probeHarness(exists) {
  let stored = "/cache/art_old.jpg", calls = 0;
  const ids = new Map();
  const context = vm.createContext({
    state: { cachedArtworkPath: cppString(stored) }, now: 1000,
    millis: () => context.now,
    fnv1a: value => { const path = value.c_str(); if (!ids.has(path)) ids.set(path, ids.size + 1); return ids.get(path); },
    lastCachedArtworkProbeMs: 0, lastCachedArtworkProbeHash: 0,
    lastUrl: "https://station.example/logo.jpg", lastAttemptMs: 900, lastIdlePrewarmStationId: 5,
    artworkExists: () => { ++calls; return exists; },
    artworkTraceSerial: { printf() {} },
    player: { setCachedArtworkPath: value => { stored = value; },
      snapshot: () => ({ cachedArtworkPath: cppString(stored) }) }
  });
  vm.runInContext("function run() { if (state.cachedArtworkPath.length()) " + probe + " }", context);
  return { context, get calls() { return calls; }, run: () => context.run() };
}
test("retired source references cannot pin playback to a missing cache path", () => {
  const h = probeHarness(false); h.run();
  assert.equal(h.context.state.cachedArtworkPath.length(), 0);
  assert.equal(h.context.lastUrl, "");
  assert.equal(h.context.lastAttemptMs, 0);
  assert.equal(h.context.lastIdlePrewarmStationId, -1);
  h.run(); assert.equal(h.calls, 1);
});
test("cache-reference validation is throttled rather than adding flash reads every loop", () => {
  const h = probeHarness(true); h.run();
  h.context.now = 1001; h.run(); h.context.now = 1499; h.run();
  assert.equal(h.calls, 1);
  h.context.now = 1500; h.run(); assert.equal(h.calls, 2);
  h.context.state.cachedArtworkPath = cppString("/cache/art_new.jpg");
  h.run(); assert.equal(h.calls, 3);
});

test("idle selection is handled once, prioritizes its missing logo and cancels unrelated idle networking", () => {
  const selection = block("if (state.stationId != lastIdlePrewarmStationId)")
    .replace("Station selected;", "const selected = {};")
    .replace(/StationManager::instance\(\)\./g, "manager.")
    .replace("String logo = selected.logo;", "const logo = string(selected.logo);")
    .replace("const String activeLogo =", "const activeLogo =")
    .replace("activeLogo != logo", "activeLogo.c_str() !== logo.c_str()");
  let queries = 0, cancellations = 0;
  const queued = [];
  const context = vm.createContext({
    state: { stationId: -1 }, lastIdlePrewarmStationId: 5,
    manager: { getStation: (_id, station) => { ++queries; station.logo = "https://chosen.example/logo.png"; return true; } },
    string: value => ({ length: () => value.length, trim() {}, c_str: () => value }),
    prewarmFailureBlocked: () => false, artworkSourceReady: () => false,
    activeDownloadLabel: () => cppString("https://other.example/logo.png"),
    isRemoteArtworkSource: value => value.c_str().startsWith("https://"),
    cancelIdlePrewarm: () => ++cancellations,
    requestPrewarm: (logo, priority) => queued.push({ url: logo.c_str(), priority })
  });
  vm.runInContext("function run() { if (state.stationId !== lastIdlePrewarmStationId) " + selection + " }", context);
  context.run(); context.run(); assert.equal(queries, 0);
  context.state.stationId = 7; context.run(); context.run();
  assert.equal(queries, 1); assert.equal(cancellations, 1);
  assert.deepEqual(queued, [{ url: "https://chosen.example/logo.png", priority: true }]);
});
