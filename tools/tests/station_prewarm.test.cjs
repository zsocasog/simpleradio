const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const cpp = fs.readFileSync(path.join(root, "src/artwork/artwork_cache.cpp"), "utf8");
function body(name) {
  const source = cpp.match(new RegExp(`(?:bool|void) ArtworkCache::${name}\\([^]*?\\n\\}`))[0];
  return source.slice(source.indexOf("{"));
}
const scheduler = body("processPrewarmQueue")
  .replace(/String (\w+);/g, 'let $1 = "";')
  .replace(/String (\w+) =/g, "let $1 =")
  .replace(/unsigned long now =/g, "const now =")
  .replace(/takePrewarmItem\(source\)/g, "(source = takeItem())")
  .replace(/findExistingLcdArtworkPath\(source, lcdPath\)/g, "(lcdPath = findLcd(source))")
  .replace(/findExistingCachePath\(source, existingPath\)/g, "(existingPath = findOriginal(source))")
  .replace(/\.c_str\(\)/g, "");

function schedulerHarness({ queued = [], auto = [], playing = false, active = false, originals = {}, ready = [] } = {}) {
  const jobs = [], scans = [];
  const queue = [...queued], candidates = [...auto];
  const context = vm.createContext({
    state: { playing }, nowMs: 10000, active, lastPrewarmWorkMs: 0, PREWARM_IDLE_SPACING_MS: 3000,
    millis: () => context.nowMs, isDownloadActive: () => context.active,
    takeItem: () => queue.shift() || "",
    queueNextStationPrewarmCandidate: () => { scans.push(context.nowMs); const p = candidates.shift(); if (p) queue.push(p); return !!p; },
    prewarmFailureBlocked: () => false,
    isRemoteArtworkSource: p => p.startsWith("https://") || p.startsWith("http://"),
    findLcd: p => ready.includes(p) ? "/cache/ready.sr565" : "",
    findOriginal: p => originals[p] || "",
    requestPrewarm: p => { queue.unshift(p); context.lastPrewarmWorkMs = 0; return true; },
    queuePrewarmItem: p => { queue.unshift(p); return true; },
    preferredLocalArtworkPath: p => p, supportedArtworkFile: p => p.endsWith(".png"),
    LittleFS: { exists: () => true }, Serial: { printf() {} }, artworkTraceSerial: { printf() {} },
    startDownloadTask: (p, idle) => { jobs.push({ kind: "download", p, idle }); context.active = true; return true; },
    requestLcdThumbnail: (p, idle) => { jobs.push({ kind: "thumbnail", p, idle }); context.active = true; return true; }
  });
  vm.runInContext(`function run(state) ${scheduler}`, context);
  return { context, jobs, scans, run: () => vm.runInContext("run(state)", context) };
}

test("stopped radio automatically preloads saved logos serially with a gap between jobs", () => {
  const h = schedulerHarness({ auto: ["https://one.example/logo.png", "https://two.example/logo.png"] });
  h.run(); assert.equal(h.jobs.length, 1); assert.equal(h.jobs[0].idle, true);
  h.context.nowMs = 15000; h.run(); assert.equal(h.jobs.length, 1); // Active job is never duplicated.
  h.context.active = false; h.run(); assert.equal(h.jobs.length, 2);
  assert.equal(h.jobs[1].p, "https://two.example/logo.png");
});

test("playback suppresses idle scanning, and explicit selected-station work stays ahead of the scan", () => {
  const h = schedulerHarness({ playing: true, queued: ["https://selected.example/logo.png"], auto: ["https://other.example/logo.png"] });
  h.run(); assert.equal(h.jobs.length, 0); assert.equal(h.scans.length, 0);
  h.context.state.playing = false; h.run();
  assert.equal(h.jobs[0].p, "https://selected.example/logo.png"); assert.equal(h.scans.length, 0);
});

test("all-ready/empty scans are throttled instead of walking the filesystem every Arduino loop", () => {
  const h = schedulerHarness();
  h.run(); h.context.nowMs = 10001; h.run(); h.context.nowMs = 12999; h.run();
  assert.equal(h.scans.length, 1);
  h.context.nowMs = 13000; h.run(); assert.equal(h.scans.length, 2);
});

test("existing originals prepare locally and ready LCD caches cause no download", () => {
  const h = schedulerHarness({ queued: ["https://one.example/logo.png"], originals: { "https://one.example/logo.png": "/cache/local.png" } });
  h.run(); assert.equal(h.jobs.length, 0); h.run();
  assert.equal(h.jobs[0].kind, "thumbnail"); assert.equal(h.jobs[0].p, "/cache/local.png");
  const cached = schedulerHarness({ queued: ["https://one.example/logo.png"], ready: ["https://one.example/logo.png"] });
  cached.run(); assert.equal(cached.jobs.length, 0);
});

test("cache-hit station selection uses the existing thumbnail before deferring playback or networking", () => {
  const js = body("prepareStationForPlayback").replace(/\(void\)budgetMs;/g, "")
    .replace(/stationArtworkReady\(stationId, &outPath\)/g, "(outPath = readyPath(stationId))");
  let deferred = 0;
  const context = vm.createContext({ readyPath: id => id === 5 ? "/cache/station.sr565" : "",
    deferStationPlayback: () => ++deferred });
  const result = vm.runInContext(`function select(stationId) { let outPath = ''; const ready = (function() ${js})(); return { ready, outPath }; } select(5);`, context);
  assert.equal(result.ready, true); assert.equal(result.outPath, "/cache/station.sr565"); assert.equal(deferred, 0);
});

test("saved-station scanning is incremental and selected stations can cancel a different idle download", () => {
  assert.match(body("queueNextStationPrewarmCandidate"), /scanLimit = stationCount < 8 \? stationCount : 8/);
  assert.match(body("queueNextStationPrewarmCandidate"), /prewarmFailureBlocked\(logo\)/);
  assert.match(body("deferStationPlayback"), /activeLogo != logo\) cancelIdlePrewarm\(\)/);
  const loop = body("loop");
  assert.ok(loop.indexOf("processPrewarmQueue(PlayerState::instance().snapshot())") < loop.indexOf("ARTWORK_STARTUP_GRACE_MS"));
});
