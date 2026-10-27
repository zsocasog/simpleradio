const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(root, "data/app.js"), "utf8");
const functions = ["previewMeterSensitivity", "flushMeterSensitivity", "commitMeterSensitivity", "queueConfigSave"]
  .map((name) => app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]).join("\n");

function harness(fetch) {
  const input = { value: "100" }, timers = new Map();
  let nextTimer = 1, saves = 0;
  const context = vm.createContext({
    $: () => input, setRawPercentLabel() {}, setConfigSaveState() {},
    console: { warn() {} }, URLSearchParams, fetch,
    setTimeout: (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id), postConfig: () => ++saves
  });
  vm.runInContext(`let configSaveTimer, meterSensitivityTimer;
    let configSaveDeferred = false; const sliderGestures = new Map();
    let meterSensitivityEditing = false, meterSensitivityDirty = false, meterSensitivityRevision = 0;
    let meterSensitivityFlight = null, meterSensitivityPending = null;
    ${functions}`, context);
  return { input, timers, context, get saves() { return saves; },
    run: (code) => vm.runInContext(code, context) };
}

test("drag previews coalesce, never persist, and release waits for the latest value before saving once", async () => {
  const requests = [], replies = [];
  const h = harness((url, options) => new Promise((resolve) => {
    requests.push({ url, value: options.body.get("value") }); replies.push(resolve);
  }));
  for (const value of [110, 125, 150]) {
    h.input.value = String(value); h.run("previewMeterSensitivity()");
  }
  assert.equal(h.timers.size, 1);
  assert.equal(requests.length, 0);
  const preview = [...h.timers.values()][0]; h.timers.clear(); preview.fn();
  assert.deepEqual(requests, [{ url: "/api/display/sensitivity", value: "150" }]);
  assert.equal(h.saves, 0);
  h.input.value = "190"; h.run("previewMeterSensitivity()");
  const committed = h.run("commitMeterSensitivity()");
  assert.equal(requests.length, 1); // No overlapping/out-of-order previews.
  assert.equal(h.timers.size, 0);
  replies.shift()({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[1].value, "190");
  assert.equal(h.timers.size, 0); // Still no persistent write before final preview.
  replies.shift()({ ok: true }); await committed;
  assert.equal(h.timers.size, 1);
  const save = [...h.timers.values()][0]; assert.equal(save.delay, 140);
  save.fn(); assert.equal(h.saves, 1);
});

test("failed live preview still allows the final persistent save", async () => {
  const h = harness(async () => ({ ok: false, status: 503 }));
  h.input.value = "135"; h.run("previewMeterSensitivity()");
  await h.run("commitMeterSensitivity()");
  assert.equal(h.timers.size, 1);
  [...h.timers.values()][0].fn(); assert.equal(h.saves, 1);
});

test("live sensitivity route performs neither flash save nor full display reconfiguration", () => {
  const server = fs.readFileSync(path.join(root, "src/web/web_server.cpp"), "utf8");
  const route = server.slice(server.indexOf('server.on("/api/display/sensitivity"'), server.indexOf('server.on("/api/config/save"'));
  assert.match(route, /displayVuSensitivity = constrain/);
  assert.doesNotMatch(route, /\.save\(|requestDisplayConfigRefresh|setEnabled|stopSong/);
  const html = fs.readFileSync(path.join(root, "data/index.html"), "utf8");
  const slider = html.match(/<input id="displayVuSensitivity"[^>]+>/)[0];
  assert.match(slider, /oninput="previewMeterSensitivity\(\)"/);
  assert.doesNotMatch(slider, /onchange=|onblur=/);
  assert.match(app, /return commitMeterSensitivity\(\).finally\(flushReleasedSliders\)/);
});

test("resuming a drag while its previous release waits does not save in mid-drag", async () => {
  const replies = [];
  const h = harness(() => new Promise(resolve => replies.push(resolve)));
  h.input.value = "110"; h.run("previewMeterSensitivity()");
  const firstRelease = h.run("commitMeterSensitivity()");
  h.input.value = "160"; h.run("previewMeterSensitivity()");
  h.run("queueConfigSave()");
  assert.equal([...h.timers.values()].some(timer => timer.delay === 140), false);
  replies.shift()({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  replies.shift()({ ok: true });
  await firstRelease;
  assert.equal([...h.timers.values()].some(timer => timer.delay === 140), false);
  await h.run("commitMeterSensitivity()");
  assert.equal(h.timers.size, 1);
  [...h.timers.values()][0].fn();
  assert.equal(h.saves, 1);
});

test("change and blur share the same final save", async () => {
  let reply;
  const h = harness(() => new Promise(resolve => { reply = resolve; }));
  h.input.value = "125"; h.run("previewMeterSensitivity()");
  const changed = h.run("commitMeterSensitivity()");
  const blurred = h.run("commitMeterSensitivity()");
  reply({ ok: true });
  await Promise.all([changed, blurred]);
  assert.equal(h.timers.size, 1);
  [...h.timers.values()][0].fn();
  assert.equal(h.saves, 1);
});
