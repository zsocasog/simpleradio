const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function fixture(attributes = {}, options = {}) {
  const registry = new Map();
  const context = vm.createContext({
    HTMLElement: class {}, window: {},
    customElements: {
      get: (name) => registry.get(name),
      define: (name, constructor) => registry.set(name, constructor)
    }
  });
  vm.runInContext(readFileSync(join(__dirname, "../simple-radio-card.js"), "utf8"), context);
  const card = new (registry.get("simple-radio-card"))();
  const config = { station_entity: "sensor.station", playback_entity: "switch.playback",
    volume_entity: "number.volume", ...options };
  card.setConfig(config);
  const properties = new Map();
  const element = { style: {
    setProperty: (name, value) => properties.set(name, value),
    removeProperty: (name) => properties.delete(name)
  } };
  card.querySelector = (selector) => selector === "ha-card" ? element : null;
  card.querySelectorAll = () => [];
  card.ownerDocument = { activeElement: null };
  card._hass = { states: { "sensor.station": { state: "Radio", attributes } } };
  return { card, config, properties };
}

test("sync is opt-in and leaves the inherited HA palette intact by default", () => {
  const { card, properties } = fixture({ themeAccent: "amber" });
  card.updateTheme();
  assert.equal(properties.size, 0);
});

for (const [theme, expected] of Object.entries({
  green: "#69e58d", amber: "#dca84f", blue: "#5d8df0",
  cyan: "#42c8d8", red: "#f20202", ruby: "#f20202"
})) {
  test(`LCD ${theme} theme sets only this card's accent`, () => {
    const { card, properties } = fixture({ themeAccent: theme }, { sync_theme: true });
    card.updateTheme();
    assert.equal(properties.get("--primary-color"), expected);
    assert.equal(properties.size, 2);
  });
}

test("custom colors update on HA events without recreating the card", () => {
  const { card, properties } = fixture({ themeAccent: "custom", themeCustomColor: "#123456" },
    { sync_theme: true });
  card._rendered = true;
  card.render = () => assert.fail("theme updates must preserve the card DOM");
  card.updateArtwork = () => {};
  card.hass = card._hass;
  assert.equal(properties.get("--primary-color"), "#123456");
  assert.equal(properties.get("--text-primary-color"), "#ffffff");
  card._hass.states["sensor.station"].attributes.themeCustomColor = "#FEdCBA";
  card.hass = card._hass;
  assert.equal(properties.get("--primary-color"), "#FEdCBA");
  assert.equal(properties.get("--text-primary-color"), "#000000");
});

test("disabling sync or losing firmware theme attributes restores HA colors", () => {
  const { card, config, properties } = fixture({ themeAccent: "amber" }, { sync_theme: true });
  card.updateTheme();
  card.setConfig({ ...config, sync_theme: false });
  card.updateTheme();
  assert.equal(properties.size, 0);
  card.setConfig({ ...config, sync_theme: true });
  card.updateTheme();
  assert.equal(properties.get("--primary-color"), "#dca84f");
  card._hass.states["sensor.station"].attributes = {};
  card.updateTheme();
  assert.equal(properties.size, 0);
});

test("malformed colors and unknown presets cannot inject CSS", () => {
  const { card, properties } = fixture({}, { sync_theme: true });
  for (const value of ["red", "#fff", "#123456; color:red", "url(https://example.com)", "#xyzxyz", ""]) {
    card._hass.states["sensor.station"].attributes = { themeAccent: "custom", themeCustomColor: value };
    card.updateTheme();
    assert.equal(properties.size, 0);
  }
  for (const themeAccent of ["unknown", "toString", "__proto__"]) {
    card._hass.states["sensor.station"].attributes = { themeAccent };
    card.updateTheme();
    assert.equal(properties.size, 0);
  }
});
