const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function language(lang) {
  const context = { window: {}, document: { readyState: 'loading', addEventListener() {} } };
  vm.createContext(context);
  vm.runInContext(read('data/i18n-catalog.js'), context);
  vm.runInContext(read(`data/i18n/${lang}.js`), context);
  return context;
}

test('Hungarian, English and the translation template cover the same complete UI', () => {
  const bundles = ['hu', 'en', 'template'].map(language);
  const keys = Object.keys(bundles[0].window.SR_I18N.dict).sort();
  for (const bundle of bundles.slice(1)) assert.deepEqual(Object.keys(bundle.window.SR_I18N.dict).sort(), keys);
  for (const key of Object.values(bundles[0].window.SR_TEXT_KEYS)) assert.ok(keys.includes(key), key);
  const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const key of keys) {
    const expected = placeholders(bundles[0].window.SR_I18N.dict[key]);
    for (const bundle of bundles.slice(1)) assert.deepEqual(placeholders(bundle.window.SR_I18N.dict[key]), expected, key);
  }
  // Include keys passed through view-definition tables as well as direct calls.
  for (const match of read('data/ui.js').matchAll(/"(ui\.[\w]+)"/g)) assert.ok(keys.includes(match[1]), match[1]);
});

test('Hungarian uses localized ordinary controls and English retains its own terms', () => {
  const hu = language('hu').window, en = language('en').window;
  for (const [source, expected] of [['Reset','Alaphelyzet'],['Bass','Mély'],['Treble','Magas'],['Host','Kiszolgáló címe'],['Root topic','Alaptéma'],['Last.fm API key','Last.fm API-kulcs']]) {
    assert.equal(hu.srT(hu.SR_TEXT_KEYS[source]), expected);
    assert.notEqual(en.srT(en.SR_TEXT_KEYS[source]), expected);
  }
  assert.equal(hu.srT('player.play'), 'Lejátszás');
  assert.equal(en.srT('ui.preview'), 'Layout preview');
  assert.equal(hu.srT('ui.mappingCount', '', { count: 3, total: 21 }), 'Összes hozzárendelés (3/21)');
});

test('static translation preserves controls and never translates a user station or track', () => {
  const context = language('en');
  const textNode = (value, user = false) => ({ nodeValue: value, parentElement: { closest: () => user } });
  const nodes = [textNode('  Hang  '), textNode('Hang', true), textNode('Reset')];
  const input = { value: 'my station', attributes: { placeholder: 'Mentett állomás...' },
    hasAttribute(k) { return k in this.attributes; }, getAttribute(k) { return this.attributes[k]; },
    setAttribute(k, v) { this.attributes[k] = v; } };
  let cursor = -1;
  context.NodeFilter = { SHOW_TEXT: 4 };
  context.document.createTreeWalker = () => ({ nextNode() { return ++cursor < nodes.length; }, get currentNode() { return nodes[cursor]; } });
  context.document.documentElement = {};
  context.document.querySelectorAll = selector => selector === '[data-i18n]' ? [] : [input];
  context.window.srApplyI18n();
  assert.equal(nodes[0].nodeValue, '  Sound  ');
  assert.equal(nodes[1].nodeValue, 'Hang');
  assert.equal(nodes[2].nodeValue, 'Reset');
  assert.equal(input.value, 'my station');
  assert.equal(input.attributes.placeholder, 'Search saved stations');
});

function ui() {
  const context = { window: {}, document: { readyState: 'loading', addEventListener() {} },
    currentConfig: { mqttEnabled: true, mqttHost: 'saved.example', mqttPort: 1883,
      mqttUser: '', mqttPassword: '', mqttRootTopic: 'radio' }, configSaving: false,
    sliderGestures: new Map(), meterSensitivityEditing: false, setTimeout, Date,
    postConfig: async () => true, refreshSystemStatus: async () => {} };
  vm.createContext(context); vm.runInContext(read('data/ui.js'), context);
  context.document.getElementById = () => ({ textContent: '', classList: { remove() {}, add() {} } });
  const U = context.window.SRUI;
  U.ready = true; U.mqttFields = ['mqttEnabled','mqttHost','mqttPort','mqttUser','mqttPassword','mqttRootTopic'];
  return { context, U };
}
test('icon assets inherit the generated WebUI cache key without a copied version', () => {
  const context = { window: {}, document: { readyState: 'loading', addEventListener() {},
    currentScript: { getAttribute() { return 'ui.js?v=5.6.7&ui=abc123'; } } } };
  vm.createContext(context); vm.runInContext(read('data/ui.js'), context);
  assert.match(context.window.SRUI.icon('wifi'), /href="icons\.svg\?v=5\.6\.7&amp;ui=abc123#wifi"/);
});

test('unrelated autosaves cannot persist uncommitted connection or API key drafts', () => {
  const { U } = ui();
  U.connectionKind = 'mqtt'; U.draft = { mqttHost: 'unsaved.example' };
  const request = U.configData({ themeAccent: 'blue', mqttHost: 'unsaved.example', mqttEnabled: '0', lastFmApiKey: 'unsaved-key' });
  assert.equal(request.themeAccent, 'blue');
  assert.equal(request.mqttHost, 'saved.example');
  assert.equal(request.mqttEnabled, '1');
  assert.equal(request.mqttUser, ''); // Intentional anonymous login must stay anonymous.
  assert.equal(request.mqttPassword, '');
  assert.ok(!('lastFmApiKey' in request));
  assert.equal(U.protectsConfig('mqttHost'), true);
  assert.equal(U.protectsConfig('brightness'), false);
});
test('each explicit connection save includes only its own draft', () => {
  const { U } = ui(); U.committing = 'mqtt';
  let request = U.configData({ mqttHost: 'new.example', mqttEnabled: '1', lastFmApiKey: 'not-yet-saved' });
  assert.equal(request.mqttHost, 'new.example'); assert.ok(!('lastFmApiKey' in request));
  U.committing = 'lastfm';
  request = U.configData({ mqttHost: 'unsaved.example', lastFmApiKey: 'new-key' });
  assert.equal(request.mqttHost, 'saved.example'); assert.equal(request.lastFmApiKey, 'new-key');
});
test('failed connection saves retain the draft; a successful retry closes the editor', async () => {
  const { context, U } = ui(); let closed = 0, request;
  U.connectionKind = 'mqtt'; U.draft = { mqttHost: 'new.example' };
  U.connectionSave = { mqtt: { disabled: false } };
  U.connectionDialog = { close() { closed++; } };
  context.postConfig = async () => { request = U.configData({ mqttHost: U.draft.mqttHost }); return false; };
  await U.saveConnection('mqtt');
  assert.equal(closed, 0); assert.equal(U.draft.mqttHost, 'new.example');
  assert.equal(U.committing, ''); assert.equal(U.connectionSave.mqtt.disabled, false);
  context.postConfig = async () => { request = U.configData({ mqttHost: U.draft.mqttHost }); return true; };
  await U.saveConnection('mqtt');
  assert.equal(request.mqttHost, 'new.example'); assert.equal(closed, 1);
  assert.equal(U.connectionKind, ''); assert.equal(Object.keys(U.draft).length, 0);
});
test('file selection is deferred; only the explicit upload action starts an update', () => {
  const { context, U } = ui(); const uploads = [];
  U.file = { name: 'firmware.bin' };
  context.document.getElementById = () => ({ value: 'firmware' });
  context.uploadOtaFile = (...args) => uploads.push(args);
  assert.equal(uploads.length, 0); U.upload(); assert.equal(uploads.length, 1);
  assert.equal(uploads[0][0], 'firmware');
  U.otaBusy = true; U.upload(); assert.equal(uploads.length, 1);
});

function volumeUi() {
  const { context, U } = ui();
  const nodes = { volume: { value: '35', setAttribute(k, v) { this[k] = v; } }, volValue: { textContent: '' } };
  context.document.getElementById = name => nodes[name];
  context.numberValue = (name, fallback) => Number(nodes[name]?.value ?? fallback);
  context.document.querySelector = () => ({ classList: { toggle() {} } });
  const stored = {};
  context.localStorage = { setItem(k, v) { stored[k] = v; } };
  U.muteButton = { setAttribute(k, v) { this[k] = v; } };
  U.volumePills = Array.from({ length: 24 }, () => ({ style: { setProperty() {} } }));
  U.restoreVolume = 15;
  return { context, U, nodes, stored };
}

test('mute restores the last audible volume and sends one ordinary control per click', () => {
  const { context, U, nodes } = volumeUi(); const sent = [];
  context.setVolume = value => { sent.push(value); nodes.volume.value = String(value); U.volume(value); };
  U.volume(35); U.toggleMute();
  assert.deepEqual(sent, [0]);
  assert.equal(U.muteButton['aria-pressed'], 'true');
  assert.match(U.muteButton.innerHTML, /#volume-off/);
  U.toggleMute();
  assert.deepEqual(sent, [0, 35]);
  assert.equal(U.muteButton['aria-pressed'], 'false');
});

test('repeated muted status frames retain the muted caption without resending volume', () => {
  const { context, U, nodes, stored } = volumeUi();
  context.setVolume = () => assert.fail('Rendering must never send a player command');
  U.volume(57); U.volume(0);
  nodes.volValue.textContent = '0%'; // app.js writes the numeric label before calling the view renderer.
  U.volume(0);
  assert.equal(nodes.volValue.textContent, 'Némítva');
  assert.equal(nodes.volume['aria-valuetext'], 'Némítva');
  assert.equal(stored['simpleradio.lastAudibleVolume'], '57');
});

test('repeated playback status frames preserve mounted transport icons', () => {
  const { context, U } = ui(); const writes = { playButton: 0, playButtonSmall: 0 };
  const nodes = Object.fromEntries(Object.keys(writes).map(name => [name, {
    set innerHTML(value) { writes[name]++; this.content = value; }
  }]));
  context.document.getElementById = name => nodes[name];
  context.document.querySelectorAll = () => [];
  context.playing = true;
  U.transport(); U.transport(); U.transport();
  assert.deepEqual(writes, { playButton: 1, playButtonSmall: 1 });
  assert.match(nodes.playButton.content, /#player-pause/);
  context.playing = false; U.transport();
  assert.deepEqual(writes, { playButton: 2, playButtonSmall: 2 });
  assert.match(nodes.playButton.content, /#player-play/);
});
