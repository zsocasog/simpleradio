const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const root = path.resolve(__dirname, "../..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const config = read("src/config/app_config.cpp");

test("local secrets example documents the firmware key without requiring fixed WiFi", () => {
  assert.match(read("secrets.example.ini"), /;\s+-D SIMPLE_RADIO_LASTFM_API_KEY=\\"YourLastFmApiKey\\"/);
  assert.match(read(".gitignore"), /^secrets\.ini$/m);
});

test("web-saved Last.fm key overrides the trimmed compiled fallback", () => {
  const getter = config.match(/String AppConfig::effectiveLastFmApiKey\(\) const \{[\s\S]*?\n\}/)[0];
  assert.match(getter, /String key = lastFmApiKey;\s*key.trim\(\);/);
  assert.match(getter, /#ifdef SIMPLE_RADIO_LASTFM_API_KEY\s*if \(!key.length\(\)\) \{\s*key = SIMPLE_RADIO_LASTFM_API_KEY;\s*key.trim\(\);/);
  assert.match(getter, /return key;/);
});

test("search and web key-status use the same effective value without returning the secret", () => {
  assert.match(read("src/artwork/artwork_cache.cpp"), /String apiKey = AppConfig::instance\(\).effectiveLastFmApiKey\(\)/);
  const json = config.match(/String AppConfig::toJson\(\) const \{[\s\S]*?\n\}/)[0];
  assert.match(json, /doc\["hasLastFmApiKey"\] = effectiveLastFmApiKey\(\).length\(\) > 0/);
  assert.doesNotMatch(json, /doc\["lastFmApiKey"\]/);
  const save = config.match(/bool AppConfig::save\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(save, /doc\["lastFmApiKey"\] = lastFmApiKey;/);
  assert.doesNotMatch(save, /effectiveLastFmApiKey/);
});
