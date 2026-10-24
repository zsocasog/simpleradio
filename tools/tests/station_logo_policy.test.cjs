const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const root = path.resolve(__dirname, "../..");
const header = fs.readFileSync(path.join(root, "src/artwork/station_logo_policy.h"), "utf8");
const cpp = fs.readFileSync(path.join(root, "src/artwork/artwork_cache.cpp"), "utf8");
const policyBody = header.slice(header.indexOf("{", header.indexOf("smallerOfficialUrl(")) + 1,
  header.indexOf("\n}", header.indexOf("smallerOfficialUrl(")));
const policy = new Function("source", policyBody);
const original = "https://danubiusradio.hu/assets/img/front/danubius_radio_album_cover_v2.png";
function cppString(value = "") {
  return { length: () => value.length, c_str: () => value, toString: () => value };
}
const start = cpp.indexOf("  const String smallerStationLogo");
const end = cpp.indexOf("  String smallerImageUrl", start);
assert.ok(start > 0 && end > start);
const preferred = cpp.slice(start, end).replace(/const String/g, "const")
  .replace(/\*memoryUnavailable/g, "memoryUnavailable")
  .replace("resizedStationLogo != smallerStationLogo", "resizedStationLogo.c_str() !== smallerStationLogo.c_str()");
const run = new Function("cacheKey", "url", "String", "preferredStationLogoUrl", "resizedStationLogoUrl", "attemptDownload", "artworkCancelled",
  "memoryUnavailable", "deadlineReached", "deadlineMs", "albumArtTrace",
  preferred + "\nreturn attemptDownload(url);");
function attempt({ key = "", source = original, smallWorks = true, cancelled = false, expired = false, accept } = {}) {
  const urls = [];
  const result = run(cppString(key), cppString(source), cppString,
    url => cppString(policy(url.c_str()) || "https://wsrv.nl/?url=" + encodeURIComponent(url.c_str())),
    url => cppString("https://wsrv.nl/?url=" + encodeURIComponent(url.c_str())),
    url => { const value = url.c_str(); urls.push(value); return accept ? accept(value) : value === source || smallWorks; },
    () => cancelled, null, () => expired, 0, () => {});
  return { urls, result };
}
test("only verified exact station sources use the station's own resize endpoint", () => {
  assert.match(policy(original), /^https:\/\/s2\.audiostream\.hu:9443\/unsafe\/176x0\/smart\//);
  for (const url of [original + "?x=1", original.replace(".hu/", ".hu.evil/"),
    "https://other.example/logo.png", "/logos/local.png"]) assert.equal(policy(url), "");
});
test("a successful small logo ends the attempt and preserves the original cache identity", () => {
  const result = attempt();
  assert.equal(result.result, true);
  assert.deepEqual(result.urls, [policy(original)]);
  assert.match(cpp, /const String storageKey = cacheKey\.length\(\) \? cacheKey : url;/);
});
test("failed small logos fall back to the original URL through the existing pipeline", () => {
  const result = attempt({ smallWorks: false });
  assert.equal(result.result, true);
  assert.deepEqual(result.urls, [policy(original), "https://wsrv.nl/?url=" + encodeURIComponent(original), original]);
});
test("album and embedded artwork bypass the station source optimization", () => {
  for (const key of ["album:artist|title", "embedded:stream"]) {
    assert.deepEqual(attempt({ key }).urls, [original]);
  }
});
test("cancellation or an exhausted caller budget does not start another request", () => {
  for (const options of [{ cancelled: true }, { expired: true }]) {
    const result = attempt({ smallWorks: false, ...options });
    assert.equal(result.result, false);
    assert.equal(result.urls.length, 1);
  }
});

test("a future station uses the general resizer and retains original-image fallback", () => {
  const source = "https://future-radio.example/brand/logo.png";
  const result = attempt({ source, smallWorks: false });
  assert.equal(result.result, true);
  assert.deepEqual(result.urls, ["https://wsrv.nl/?url=" + encodeURIComponent(source), source]);
  const helper = cpp.slice(cpp.indexOf("static String resizedStationLogoUrl("),
    cpp.indexOf("static bool fetchArtworkJson("));
  const selector = helper.slice(helper.indexOf("static String preferredStationLogoUrl("));
  assert.ok(selector.indexOf("smallerOfficialUrl(") < selector.indexOf("imgurThumbnailFallbackUrl("));
  assert.ok(selector.indexOf("imgurThumbnailFallbackUrl(") < selector.indexOf("return resizedStationLogoUrl("));
  assert.match(helper, /encodeArtworkQuery\(url\)/);
  assert.match(helper, /w=176&h=176&fit=inside&output=jpg&q=85&we/);
  assert.match(helper, /page=-1/);
});

test("a rejected native image can use the compatible small alternative before the original", () => {
  const result = attempt({ accept: url => url.startsWith("https://wsrv.nl/") });
  assert.equal(result.result, true);
  assert.deepEqual(result.urls, [policy(original), "https://wsrv.nl/?url=" + encodeURIComponent(original)]);
});
