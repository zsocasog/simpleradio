const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = file => readFileSync(path.join(__dirname, '../..', file), 'utf8');
const state = read('src/state/player_state.cpp');
const header = read('src/state/player_state.h');
function body(source, marker) {
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, marker);
  const start = source.indexOf('{', at);
  let depth = 1, i = start + 1;
  for (; i < source.length && depth; i++) depth += (source[i] === '{') - (source[i] === '}');
  assert.equal(depth, 0);
  return source.slice(start, i);
}
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

test('busy or allocation failure preserves real playback and HTTP status until a control can be read', () => {
  const c = vm.createContext({ playing: true, streamUrl: 'first', station: 'station A', volume: 13,
    eqLow: -2, eqMid: 0, eqHigh: 3, balance: -15, streamConnectionState: 'connected', streamConnectFailures: 0,
    busy: false, oom: false, allocations: 0 });
  c.take = ticks => { assert.equal(ticks, 0); return { ok: () => !c.busy }; };
  c.reserve = () => { c.allocations++; return !c.oom; };
  const update = body(state, 'static bool updateText(').replace('target == source', 'obj[key] === source')
    .replace('target.reserve(source.length())', 'reserve()').replace('target = source;', 'obj[key] = source;');
  vm.runInContext('function updateText(obj, key, source)' + update, c);
  for (const [name, marker] of [['controls', 'void PlayerState::refreshPlaybackControls('],
                                ['status', 'bool PlayerState::tryReadStatus(']]) {
    const cpp = body(state, marker).replace('PlayerStateLock lock(0);', 'const lock = take(0);')
      .replace(/updateText\(lastKnown\.(\w+),/g, "updateText(lastKnown, '$1',");
    vm.runInContext('function ' + name + '(lastKnown)' + cpp, c);
  }
  const controls = {}, status = {};
  c.controls(controls); assert.equal(c.status(status), true);
  const knownControls = { ...controls }, knownStatus = { ...status };
  assert.equal(controls.streamUrl, 'first'); assert.equal(status.volume, 13);
  const firstAllocations = c.allocations;
  for (let i = 0; i < 2000; i++) { c.controls(controls); c.status(status); }
  assert.equal(c.allocations, firstAllocations);
  Object.assign(c, { busy: true, streamUrl: 'second', station: 'station B', volume: 27 });
  for (let i = 0; i < 2000; i++) { c.controls(controls); assert.equal(c.status(status), false); }
  assert.deepEqual(controls, knownControls); assert.deepEqual(status, knownStatus);
  c.busy = false; c.oom = true;
  c.controls(controls); assert.equal(c.status(status), false);
  assert.deepEqual(controls, knownControls); assert.deepEqual(status, knownStatus);
  c.playing = false; c.controls(controls); assert.equal(controls.playing, false);
  c.playing = true; c.oom = false;
  c.controls(controls); assert.equal(c.status(status), true);
  assert.equal(controls.streamUrl, 'second'); assert.equal(status.station, 'station B');
  assert.equal(controls.volume, 27); assert.equal(status.volume, 27);
});

test('a busy status endpoint preserves its response shape after the first valid reading', () => {
  const web = read('src/web/web_server.cpp');
  const fn = body(web, 'static String systemStatusJson(');
  const take = fn.slice(fn.indexOf('const bool fresh'), fn.indexOf('JsonObject wifi'))
    .replace('const bool fresh = PlayerState::instance().tryReadStatus(player);', 'const fresh = sample();')
    .replace('return {};', 'return null;')
    .replace('JsonObject status = doc["status"].to<JsonObject>();', 'const status = {};')
    .replace('streamConnectionStateName(player.streamConnectionState)', 'player.streamConnectionState')
    .replace('ws.count()', '1');
  const c = vm.createContext({ havePlayer:false, sample:() => false, player:{} });
  vm.runInContext('function status() {' + take + 'return status;}', c);
  assert.equal(c.status(), null);
  c.sample = () => { Object.assign(c.player, { playing:true, station:'A', volume:12,
    streamConnectionState:'connected', streamConnectFailures:0 }); return true; };
  const valid = c.status(); c.sample = () => false;
  assert.deepEqual({...c.status()}, {...valid, playerStateFresh:false});
  assert.match(web, /if \(json\.isEmpty\(\)\) request->send\(503,/);
});

test('deferred encoder turns use the latest volume and preserve both end stops and mute order', () => {
  const c = vm.createContext({ constrain: clamp, busy: true, volume: 13, saves: 0 });
  c.take = wait => { if (!wait) assert.equal(wait, 0); return { ok: () => !c.busy }; };
  c.markPlayerStateDirty = () => { c.saves++; };
  vm.runInContext('function add(step)' + body(header, 'void add(int step)'), c);
  vm.runInContext('function apply(value)' + body(header, 'int apply(int value)'), c);
  const adjust = body(state, 'bool PlayerState::applyLocalVolume(')
    .replace('PlayerStateLock lock(muteRestore ? pdMS_TO_TICKS(1000) : 0);', 'const lock = take(muteRestore ? 1000 : 0);')
    .replace('int next', 'let next').replace('turns.apply(volume)', 'apply(volume)')
    .replaceAll('*muteRestore', 'muteRestore.value').replace(/\bchanged\b/g, 'result.changed');
  vm.runInContext('function commit(result, muteRestore)' + adjust, c);
  const clear = () => Object.assign(c, { offset: 0, minimum: 0, maximum: 100 });
  for (const sequence of [[6,-10], [-12,6], [90,40,-80,200,-3], [-30,20,-100,200,-100,17]]) {
    clear(); sequence.forEach(step => c.add(step));
    for (let v = 0; v <= 100; v++) {
      assert.equal(c.apply(v), sequence.reduce((n, step) => clamp(n + step, 0, 100), v));
    }
  }
  clear(); c.add(6); c.add(-10);
  const result = {};
  assert.equal(c.commit(result), false); assert.equal(c.saves, 0); assert.equal(c.volume, 13);
  c.volume = 99; c.busy = false;  // A newer web control is the real starting value.
  const mute = { value: -1 };
  assert.equal(c.commit(result, mute), true); assert.equal(mute.value, 90); assert.equal(c.volume, 0);
  clear(); assert.equal(c.commit(result, mute), true); assert.equal(c.volume, 90);
  assert.equal(c.saves, 2);
  const flush = body(read('src/input/input_controller.cpp'), 'static void flushVolumeTurns(');
  assert.ok(flush.indexOf('applyLocalVolume(') < flush.indexOf('pendingVolumeTurns = {};'));
});
