const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const audio = read('src/audio/audio_player.cpp');
const http = read('src/artwork/artwork_http.cpp');
function body(source, marker) {
  const at = source.indexOf(marker); assert.ok(at >= 0, marker);
  const start = source.indexOf('{', at); let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(marker);
}

test('network header polling yields to pending controls and cancels at the next poll', () => {
  const cpp = body(read('src/audio/audio_network_control.h'), 'bool serviceNetwork(')
    .replace(/const uint32_t /g, 'const ');
  const c = vm.createContext({ now: 0, ticks: 0, lastNetworkYieldMs: 0,
    networkOwner: {}, continueNetwork: () => c.now < 17,
    millis: () => c.now, vTaskDelay: () => { ++c.ticks; } });
  vm.runInContext('function serviceNetwork(forceCheck=false) ' + cpp, c);
  let cancelledAt = -1;
  for (c.now = 0; c.now < 5000; c.now++) {
    if (!c.serviceNetwork()) { cancelledAt = c.now; break; }
  }
  assert.equal(cancelledAt, 20); assert.equal(c.ticks, 2);
  c.now = 21; assert.equal(c.serviceNetwork(true), false); // A redirect must check immediately.
});

test('background requests cannot open a socket during audio reservation, and may resume afterward', () => {
  const gate = read('src/artwork/artwork_network_gate.h');
  const methods = ['reserveAudio', 'releaseAudio', 'audioReserved', 'backgroundActive', 'beginBackground', 'endBackground'];
  let js = '';
  for (const name of methods) {
    let code = body(gate, name + '(').replace(/bool expected = false;/, 'let expected = false;');
    code = code.replace(/audio_\.store\(([^)]+)\)/g, 'audio_ = $1')
      .replace(/background_\.store\(([^)]+)\)/g, 'background_ = $1')
      .replace(/audio_\.load\(\)/g, 'audio_').replace(/background_\.load\(\)/g, 'background_')
      .replace('background_.compare_exchange_strong(expected, true)', 'exchange(expected, true)');
    js += `function ${name}() ${code}\n`;
  }
  const c = vm.createContext({ audio_: false, background_: false, settingsSaveReserved: () => false });
  c.exchange = (expected, next) => { if (c.background_ !== expected) return false; c.background_ = next; return true; };
  vm.runInContext(js, c);
  assert.equal(c.beginBackground(), true);
  c.reserveAudio(); assert.equal(c.backgroundActive(), true); // Existing TLS closes itself.
  c.endBackground(); assert.equal(c.backgroundActive(), false);
  assert.equal(c.beginBackground(), false); assert.equal(c.backgroundActive(), false);
  c.releaseAudio(); assert.equal(c.beginBackground(), true);
  assert.equal(c.beginBackground(), false); // A second background caller cannot clear the first lease.
  assert.equal(c.backgroundActive(), true); c.endBackground();
});

test('slow connect cannot immediately retry or publish a connection for a cancelled station', () => {
  const connect = body(audio, 'bool AudioPlayer::connectToStream(');
  assert.ok(connect.indexOf('while (ArtworkHttp::backgroundNetworkActive())') < connect.indexOf('audio.connecttohost('));
  assert.match(connect, /~AudioConnectionScope\(\) \{ ArtworkHttp::releaseAudioConnection\(\); \}/);
  const after = connect.slice(connect.indexOf('bool ok = audio.connecttohost('));
  assert.ok(after.indexOf('lastRetryMs = millis();') < after.indexOf('if (ok)'));
  assert.ok(after.indexOf('if (!networkStillRequested())') < after.indexOf('notifyAudioConnectResult(true)'));
  assert.match(audio, /if \(!streamControlOperation && s\.playing &&/);
  const desired = body(audio, 'bool AudioPlayer::networkStillRequested(')
    .replace('const PlayerStateSnapshot desired = PlayerState::instance().snapshot();', 'const desired = snapshot();');
  const run = new Function('snapshot', 'lastStreamUrl', 'WiFi', desired);
  for (const desiredState of [{ playing: false, streamUrl: 'a' }, { playing: true, streamUrl: 'b' }]) {
    assert.equal(run(() => desiredState, 'a', { isConnected: () => true }), false);
  }
  assert.equal(run(() => ({ playing: true, streamUrl: 'a' }), 'a', { isConnected: () => true }), true);
  assert.match(body(http, 'bool service()'), /networkGate.audioReserved\(\)/);
  const get = body(http, 'static bool getAttempt(');
  assert.ok(get.indexOf('BackgroundNetworkScope network(options);') < get.indexOf('request(client,'));
});

test('station payload validation rejects HTML/JSON but keeps PNG/JPEG/BMP/ICO support', () => {
  const cpp = body(read('src/artwork/lcd_image_policy.h'), 'bool supportedPayload(')
    .replace(/const bool /g, 'const ').replace(/const unsigned /g, 'const ')
    .replace('static_cast<unsigned>(data[5])', 'data[5]')
    .replace(/'([A-Za-z])'/g, (_, c) => c.charCodeAt(0));
  const valid = new Function('data', 'size', cpp);
  const check = bytes => valid(bytes, bytes.length);
  assert.equal(check(Buffer.from('<!DOCTYPE html><html><head>error</head></html>')), false);
  assert.equal(check(Buffer.from('{"error":"image is not available"}')), false);
  for (const [head, length] of [[[0x89,80,78,71,13,10,26,10],33], [[255,216,255],16], [[66,77],54], [[0,0,1,0,1,0],22]]) {
    const bytes = Buffer.alloc(length); bytes.set(head); assert.equal(check(bytes), true);
  }
  assert.equal(valid(null, 50), false);
  const download = body(read('src/artwork/artwork_cache.cpp'), 'bool ArtworkCache::download(');
  assert.ok(download.indexOf('LcdImagePolicy::supportedPayload(') < download.indexOf('LittleFS.open(tempPath, "w")'));
  assert.match(read('src/artwork/station_logo_policy.h'), /filters:format\(png\)/);
});
