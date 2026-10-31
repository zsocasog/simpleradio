const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function fixture(attributes = {}) {
  const registry = new Map();
  const clock = { now: 1000 }, timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    HTMLElement: class {},
    customElements: {
      get: (name) => registry.get(name),
      define: (name, constructor) => registry.set(name, constructor)
    },
    Date: { now: () => clock.now },
    window: { setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
      clearTimeout: id => timers.delete(id) }
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
  card.querySelectorAll = () => [];
  return { card, art, requests, clock, timers };
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

test("PSRAM album URL is served by the radio with its query id intact", () => {
  const { card, requests } = fixture({
    cachedArtworkPath: "/cache/station.sr565",
    albumArtworkPath: "/api/artwork/album?id=12345678-00000001"
  });
  card.updateArtwork();
  assert.equal(requests[0].src, "http://radio.local/api/artwork/album?id=12345678-00000001");
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

test("remote station logos first use the radio's browser-readable cached image, including station zero", () => {
  const logo = 'https://station.example/old-logo.ico';
  const { card, art, requests } = fixture({ stationId: 0, stationLogo: logo,
    cachedArtworkPath: '/cache/lcd.sr565' });
  card.updateArtwork();
  assert.equal(requests[0].src, 'http://radio.local/api/artwork/station?id=0&source='+encodeURIComponent(logo));
  requests[0].onload(); assert.equal(art.children[0], requests[0]);
  assert.equal(requests.length, 1);
});

test("the saved station supplies the cached-logo endpoint when current attributes omit its logo", () => {
  const { card, requests } = fixture({ stationId: 7 });
  card._hass.states['sensor.stations'].attributes.stations[0].logo = 'https://station.example/logo.png';
  card.updateArtwork();
  assert.match(requests[0].src, /^http:\/\/radio\.local\/api\/artwork\/station\?id=7&source=/);
});

test("an older firmware without the cached endpoint still loads the original image", () => {
  const logo = 'https://station.example/logo.png';
  const { card, requests } = fixture({ stationId: 0, stationLogo: logo });
  card.updateArtwork(); requests[0].onerror();
  assert.equal(requests[1].src, logo);
});

test("cached station fallback never displaces a current stream image or album cover", () => {
  const { card, requests } = fixture({ stationId: 0, stationLogo: 'https://station.example/logo.png',
    hasStreamImage: true, cachedArtworkPath: '/cache/embedded.png',
    albumArtworkPath: '/api/artwork/album?id=current' });
  card.updateArtwork(); assert.equal(requests[0].src, 'http://radio.local/cache/embedded.png');
  requests[0].onerror(); assert.equal(requests[1].src, 'http://radio.local/api/artwork/album?id=current');
});

function stationFixture(logo = 'https://station.example/gone.png') {
  const h = fixture();
  const badge = { dataset: {}, children: [], textContent: 'DA',
    replaceChildren(...nodes) { this.children = nodes; this.textContent = ''; } };
  const station = { id: 0, name: 'Danubius', logo };
  h.card._hass.states['sensor.stations'].attributes.stations = [station];
  const row = { dataset: { stationId: '0' }, querySelector: () => badge };
  h.card.querySelectorAll = () => [row];
  return { ...h, badge, row, station };
}

test("station-list logos keep initials while loading and reuse the radio cache", () => {
  const { card, badge, requests } = stationFixture();
  card.updateStationArtwork(); assert.equal(badge.textContent, 'DA');
  assert.match(requests[0].src, /\/api\/artwork\/station\?id=0&source=/);
  requests[0].onload(); assert.equal(badge.children[0], requests[0]);
  card.updateStationArtwork(); assert.equal(requests.length, 1);
});

test("failed list images retain initials and the list HTML never preemptively hides them", () => {
  const { card, badge, requests } = stationFixture();
  const html = card.renderStationRows(0);
  assert.match(html, /class="sr-station-logo">DA<\/span>/);
  assert.doesNotMatch(html, /background-image/);
  card.updateStationArtwork(); requests[0].onerror(); requests[1].onerror();
  assert.equal(badge.textContent, 'DA'); assert.equal(badge.children.length, 0);
});

test("a saved logo becoming ready after idle preparation retries without rebuilding list rows", () => {
  const { card, badge, row, requests, clock } = stationFixture();
  card.updateStationArtwork(); requests[0].onerror(); requests[1].onerror();
  clock.now += 4999; card.updateStationArtwork(); assert.equal(requests.length, 2);
  clock.now += 1; card.updateStationArtwork(); assert.equal(requests.length, 3);
  requests[2].onload(); assert.equal(badge.children[0], requests[2]);
  assert.equal(row.dataset.stationId, '0');
});

test("the main image also retries a failed cache after backoff while stable images are retained", () => {
  const { card, art, requests, clock } = fixture({ stationId: 0, stationLogo: 'https://station.example/gone.png' });
  card.updateArtwork(); requests[0].onerror(); requests[1].onerror();
  card.updateArtwork(); assert.equal(requests.length, 2); assert.equal(art.textContent, 'SR');
  clock.now += 5000; card.updateArtwork(); requests[2].onload();
  card.updateArtwork(); assert.equal(requests.length, 3); assert.equal(art.children[0], requests[2]);
});

test("a slow image times out and its late success cannot replace the working fallback", () => {
  const { card, badge, requests, timers } = stationFixture();
  card.updateStationArtwork(); timers.values().next().value();
  assert.equal(requests.length, 2); assert.equal(badge.textContent, 'DA');
  requests[1].onload(); requests[0].onload();
  assert.equal(badge.children[0], requests[1]); assert.equal(timers.size, 0);
});

test("late completion of a replaced station logo cannot overwrite the new logo", () => {
  const { card, badge, station, requests } = stationFixture();
  card.updateStationArtwork(); station.logo = '/logos/replacement.png'; card.updateStationArtwork();
  requests[1].onload(); requests[0].onload();
  assert.equal(badge.children[0], requests[1]); assert.equal(requests[1].src, 'http://radio.local/logos/replacement.png');
});

test("a logo-less station keeps initials and invalid IDs never request station zero by accident", () => {
  const { card, badge, requests } = stationFixture(''); card.updateStationArtwork();
  assert.equal(badge.textContent, 'DA'); assert.equal(requests.length, 0);
  for (const id of [undefined, null, '', -1, 'abc', 1.5]) {
    assert.equal(card.cachedStationImage({id, logo:'https://station.example/logo.png'}), '');
  }
});
