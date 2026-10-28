const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const config = read("src/config/app_config.cpp");
const js = read("data/app.js");
function body(source, marker) {
  const start = source.indexOf("{", source.indexOf(")", source.indexOf(marker)));
  assert.ok(start >= 0, marker);
  let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === "{") ++depth;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(marker);
}
function mqttDefaults(doc, macros) {
  const start = config.indexOf('String savedMqttHost = doc["mqttHost"]');
  const end = config.indexOf("  // applyJson also", start);
  assert.ok(start > 0 && end > start);
  const code = config.slice(start, end)
    .replace(/#ifdef (\w+)\r?\n([\s\S]*?)#endif/g, (_, name, lines) =>
      name in macros ? lines.replace(new RegExp("\\b" + name + "\\b", "g"), JSON.stringify(macros[name])) : "")
    .replace('String savedMqttHost = doc["mqttHost"] | "";',
      'let savedMqttHost = String(doc["mqttHost"] || "");')
    .replace("savedMqttHost.trim();", "savedMqttHost = savedMqttHost.trim();")
    .replace("savedMqttHost.length()", "savedMqttHost.length");
  new Function("doc", code)(doc);
  return doc;
}
const defaults = { MQTT_HOST: "broker.example", MQTT_PORT: 1884, MQTT_USER: "build-user",
  MQTT_PASS: "build-pass", MQTT_ROOT_TOPIC: "radio" };
test("compiled MQTT defaults initialize an unconfigured broker without enabling MQTT", () => {
  const doc = mqttDefaults({ mqttHost: "", mqttPort: 1883, mqttUser: "", mqttPassword: "",
    mqttEnabled: false }, defaults);
  assert.equal(doc.mqttHost, defaults.MQTT_HOST);
  assert.equal(doc.mqttPort, defaults.MQTT_PORT);
  assert.equal(doc.mqttUser, defaults.MQTT_USER);
  assert.equal(doc.mqttPassword, defaults.MQTT_PASS);
  assert.equal(doc.mqttRootTopic, defaults.MQTT_ROOT_TOPIC);
  assert.equal(doc.mqttEnabled, false);
});
test("a saved broker wins, including intentional anonymous credentials", () => {
  const doc = { mqttHost: "saved.example", mqttPort: 1883, mqttUser: "", mqttPassword: "" };
  assert.deepEqual(mqttDefaults({ ...doc }, defaults), doc);
});
test("omitting build flags preserves the existing MQTT configuration", () => {
  const doc = { mqttHost: "", mqttPort: 1883, mqttUser: "", mqttPassword: "" };
  assert.deepEqual(mqttDefaults({ ...doc }, {}), doc);
});
function frontend(savedKey = true) {
  const requests = [], labels = new Map();
  const node = { disabled: false, setAttribute() {} };
  const context = { currentConfig: { hasSavedLastFmApiKey: savedKey }, configSaving: false,
    meterSensitivityEditing: false, meterSensitivityDirty: false, meterSensitivityRevision: 0,
    deferredConfigAction: {},
    configSaveDeferred: false, sliderGestures: new Map(), sliderDirty: new Map(),
    acknowledgeConfigSliders() {},
    configSavePending: false, configSaveTimer: 0, URLSearchParams, console, clearTimeout() {},
    t: (_key, fallback) => fallback,
    $: () => ({ ...node, classList: { add() {}, remove() {}, toggle() {} } }),
    collectConfig: () => ({ lastFmApiKey: "unsaved-typed-key" }),
    setConfigSaveState() {}, setText: (id, value) => labels.set(id, value),
    fetch: async (url, options) => {
      requests.push({ url, params: new URLSearchParams(options.body) });
      return { ok: true, json: async () => ({ hasLastFmApiKey: true, hasSavedLastFmApiKey: false }) };
    },
    applyConfigToUI: value => { context.currentConfig = value; }
  };
  vm.createContext(context);
  vm.runInContext([
    "async function postConfig(action = {}) " + body(js, "async function postConfig("),
    "function deleteSavedLastFmKey() " + body(js, "function deleteSavedLastFmKey(")
  ].join("\n"), context);
  return { context, requests, labels };
}
test("delete is a one-shot action that cannot accidentally save a newly typed key", async () => {
  const app = frontend();
  await app.context.deleteSavedLastFmKey();
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].params.get("clearLastFmApiKey"), "1");
  assert.equal(app.requests[0].params.has("lastFmApiKey"), false);
  assert.match(app.labels.get("lastFmApiKeyStatus"), /firmware-kulcs aktív/);
  await app.context.postConfig();
  assert.equal(app.requests[1].params.has("clearLastFmApiKey"), false);
  assert.equal(app.requests[1].params.get("lastFmApiKey"), "unsaved-typed-key");
});
test("a compiled-only key has no saved web key to delete", async () => {
  const app = frontend(false);
  await app.context.deleteSavedLastFmKey();
  assert.equal(app.requests.length, 0);
  const html = read("data/index.html");
  assert.match(html, /id="deleteLastFmApiKey"[^>]*type="button"/);
  assert.doesNotMatch(html, /id="clearLastFmApiKey"/);
  assert.match(config, /doc\["hasSavedLastFmApiKey"\] = lastFmApiKey\.length\(\) > 0/);
  const publicJson = config.slice(config.indexOf("String AppConfig::toJson()"),
    config.indexOf("bool AppConfig::applyJson("));
  assert.doesNotMatch(publicJson, /doc\["lastFmApiKey"\]/);
});

test("a deliberate key deletion waits for sensitivity editing instead of being lost", async () => {
  const app = frontend();
  app.context.meterSensitivityEditing = true;
  await app.context.deleteSavedLastFmKey();
  assert.equal(app.requests.length, 0);
  app.context.meterSensitivityEditing = false;
  await app.context.postConfig();
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].params.get("clearLastFmApiKey"), "1");
  assert.equal(app.requests[0].params.has("lastFmApiKey"), false);
});

test("an older full-config response cannot acknowledge a newer sensitivity edit", async () => {
  const app = frontend();
  let reply;
  app.context.collectConfig = () => ({ displayVuSensitivity: "100" });
  app.context.fetch = () => new Promise(resolve => { reply = resolve; });
  const oldSave = app.context.postConfig();
  app.context.meterSensitivityRevision = 1;
  app.context.meterSensitivityDirty = true;
  reply({ ok: true, json: async () => ({ displayVuSensitivity: 100 }) });
  await oldSave;
  assert.equal(app.context.meterSensitivityDirty, true);
  app.context.collectConfig = () => ({ displayVuSensitivity: "150" });
  app.context.fetch = async () => ({ ok: true, json: async () => ({ displayVuSensitivity: 150 }) });
  await app.context.postConfig();
  assert.equal(app.context.meterSensitivityDirty, false);
  assert.match(js, /if \(!meterSensitivityEditing && !meterSensitivityDirty\) setConfigValue\("displayVuSensitivity"/);
});
