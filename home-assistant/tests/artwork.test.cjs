const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function fixture(attributes = {}) {
  const registry = new Map();
  const context = vm.createContext({
    HTMLElement: class {},
    customElements: {
      get: (name) => registry.get(name),
      define: (name, constructor) => registry.set(name, constructor)
    },
    window: {}
  });
  vm.runInContext(readFileSync(join(__dirname, "../simple-radio-card.js"), "utf8"), context);
  const card = new (registry.get("simple-radio-card"))();
  card.setConfig({
    station_entity: "sensor.station",
    stations_entity: "sensor.stations",
    playback_entity: "switch.playback",
    volume_entity: "number.volume",
    radio_url: "http://radio.local/"
  });
  card._hass = { states: {
    "sensor.station": { state: "Test Radio", attributes },
    "sensor.stations": { attributes: { stations: [{ id: 7, logo: "/logos/saved.png" }] } }
  } };
  const art = {
    dataset: {},
    textContent: "SR",
    children: [],
    replaceChildren(...children) { this.children = children; this.textContent = ""; }
  };
  const requests = [];
  card.ownerDocument = {
    activeElement: null,
    createElement(tag) {
      assert.equal(tag, "img");
      const image = {};
      requests.push(image);
      return image;
    }
  };
  card.querySelector = (selector) => selector === ".sr-art" ? art : null;
  return { card, art, requests };
}

test("LCD-only cache falls back to the browser album cover", () => {
  const { card, art, requests } = fixture({
    cachedArtworkPath: "/cache/logo.sr565", albumArtworkPath: "/cache/album.jpg",
    stationLogo: "/logos/station.png"
  });
  card.updateArtwork();
  assert.equal(requests[0].src, "http://radio.local/cache/album.jpg");
  assert.equal(art.textContent, "SR");
  requests[0].onload();
  assert.equal(art.children[0], requests[0]);
});

test("failed album and cache requests fall back to the station logo", () => {
  const { card, art, requests } = fixture({
    albumArtworkPath: "/cache/missing.jpg", cachedArtworkPath: "/cache/missing.png",
    stationLogo: "/logos/station.png"
  });
  card.updateArtwork();
  requests[0].onerror();
  requests[1].onerror();
  assert.equal(requests[2].src, "http://radio.local/logos/station.png");
  requests[2].onload();
  assert.equal(art.children[0], requests[2]);
});

test("stream artwork has priority and unchanged HA updates do not reload it", () => {
  const { card, requests } = fixture({ hasStreamImage: true,
    cachedArtworkPath: "/cache/embedded.png", albumArtworkPath: "/cache/album.jpg" });
  card.updateArtwork();
  card.updateArtwork();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].src, "http://radio.local/cache/embedded.png");
});

test("late loads from an earlier track cannot replace the new artwork", () => {
  const { card, art, requests } = fixture({ albumArtworkPath: "/cache/old.jpg" });
  card.updateArtwork();
  card._hass.states["sensor.station"].attributes.albumArtworkPath = "/cache/new.jpg";
  card.updateArtwork();
  requests[1].onload();
  requests[0].onload();
  assert.equal(art.children[0], requests[1]);
});

test("saved station logo is used when current metadata has no usable image", () => {
  const { card, requests } = fixture({ stationId: 7, cachedArtworkPath: "/cache/lcd.sr565?v=2" });
  card.updateArtwork();
  assert.equal(requests[0].src, "http://radio.local/logos/saved.png");
});

test("relative paths never resolve against the HA host without radio_url", () => {
  const { card, art, requests } = fixture({ albumArtworkPath: "/cache/album.jpg",
    stationLogo: "https://images.example/logo.png" });
  delete card.config.radio_url;
  card.updateArtwork();
  assert.equal(requests[0].src, "https://images.example/logo.png");
  requests[0].onerror();
  assert.equal(art.textContent, "SR");
});

test("periodic metadata updates preserve the picker and its rows", () => {
  const { card } = fixture({ albumArtworkPath: "/cache/album.jpg", stationId: 7 });
  card._rendered = true;
  card._stationOpen = true;
  card._stationsSignature = card.stationsSignature();
  card._listedStationId = 7;
  card.render = () => assert.fail("must not replace the card DOM");
  card.updateStationList = () => assert.fail("must not replace unchanged station rows");
  card.hass = card._hass;
});
