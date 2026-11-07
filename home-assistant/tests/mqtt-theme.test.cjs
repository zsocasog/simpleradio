const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

// Execute the firmware's publish decision with a fake broker and player.
const source = readFileSync(join(__dirname, "../../src/mqtt/mqtt_controller.cpp"), "utf8");
const start = source.indexOf("  uint32_t stateRevision = PlayerState::instance().revision();");
const end = source.indexOf("  uint32_t stationsRevision =", start);
assert.ok(start >= 0 && end > start);
const publishBlock = source.slice(start, end)
  .replace(/uint32_t stateRevision/g, "const stateRevision")
  .replace(/PlayerStateSnapshot snapshot/g, "const snapshot")
  .replace(/String stateJson/g, "const stateJson")
  .replace(/PlayerState::instance\(\)/g, "player")
  .replace(/\.c_str\(\)/g, "");

function fixture() {
  const state = { revision: 4, connected: true, publishSucceeds: true };
  const calls = [];
  const context = vm.createContext({
    config: { themeAccent: "green", themeCustomColor: "#a9f7bf" },
    lastPublishedStateRevision: 4,
    lastPublishedThemeAccent: "green",
    lastPublishedThemeCustomColor: "#a9f7bf",
    statusPublishPending: false,
    player: { revision: () => state.revision,
      snapshot: () => ({ volume: 50, balance: 0 }), toJson: () => "state" },
    mqtt: { connected: () => state.connected,
      publish: (topic) => { calls.push(topic); return state.publishSucceeds; } },
    topic: (suffix) => suffix
  });
  return { state, calls, context,
    update() { vm.runInContext(`{ ${publishBlock} }`, context); } };
}

test("theme-only edits publish even when the player revision stays unchanged", () => {
  const f = fixture();
  f.update();
  assert.deepEqual(f.calls, []);
  f.context.config.themeAccent = "amber";
  f.update();
  assert.ok(f.calls.includes("status"));
  assert.equal(f.context.lastPublishedThemeAccent, "amber");
  f.calls.length = 0;
  f.update();
  assert.deepEqual(f.calls, []);
  f.context.config.themeCustomColor = "#123456";
  f.update();
  assert.ok(f.calls.includes("status"));
});

test("a failed publish is retried and an offline theme edit is not consumed", () => {
  const f = fixture();
  f.context.config.themeAccent = "custom";
  f.state.connected = false;
  f.update();
  assert.deepEqual(f.calls, []);
  assert.equal(f.context.lastPublishedThemeAccent, "green");
  f.state.connected = true;
  f.state.publishSucceeds = false;
  f.update();
  assert.equal(f.context.lastPublishedThemeAccent, "green");
  f.state.publishSucceeds = true;
  f.update();
  assert.equal(f.context.lastPublishedThemeAccent, "custom");
});

test("pending status republishes theme after reconnect or HA restart", () => {
  const f = fixture();
  f.context.statusPublishPending = true;
  f.state.publishSucceeds = false;
  f.update();
  assert.equal(f.context.statusPublishPending, true);
  f.state.publishSucceeds = true;
  f.update();
  assert.equal(f.context.statusPublishPending, false);
  assert.equal(f.calls.filter((topic) => topic === "status").length, 2);
});
