const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const test = require('node:test');
const P = require('../../data/ir-profiles.js');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const cpp = read('src/config/app_config.cpp');
const policy = read('src/config/ir_remote_policy.h');
const clone = x => JSON.parse(JSON.stringify(x));
function block(text, marker) {
  const at = text.indexOf(marker); assert.ok(at >= 0, marker);
  const begin = text.indexOf('{', at); let depth = 0;
  for (let i = begin; i < text.length; ++i) {
    if (text[i] === '{') ++depth;
    if (text[i] === '}' && --depth === 0) return text.slice(begin, i + 1);
  }
  throw Error(marker);
}

test('the three physical templates have the advertised keys and no assumed IR codes', () => {
  for (const [id, count] of [['rcnec21', 21], ['car21', 21], ['nav17', 17]]) {
    const l = P.get(id); assert.equal(l.buttons.length, count); assert.equal(l.columns, 3);
    assert.deepEqual(P.normalize(l), l);
    assert.equal(new Set(l.buttons.map(b => b.action)).size, count);
    for (const b of l.buttons) assert.equal('code' in b, false);
  }
  assert.deepEqual(P.get('car21').buttons.slice(0, 3).map(b => b.label), ['CH−', 'CH', 'CH+']);
  assert.deepEqual(P.get('nav17').buttons.slice(0, 3).map(b => b.label), ['1', '2', '3']);
  assert.equal(P.get('nav17').buttons.find(b => b.label === 'OK').action, 'ok');
});

test('layouts are independent copies; custom Unicode labels survive serialization unchanged', () => {
  const custom = P.get('rcnec21'); custom.name = 'Saját távirányító';
  custom.buttons[0].label = 'Ű / ▶'; custom.buttons[0].shape = 'round';
  assert.notEqual(P.get('rcnec21').name, custom.name);
  assert.deepEqual(P.get('custom', JSON.stringify(custom)), custom);
  assert.equal(P.get('unknown').name, 'IR-RCNEC-BK');
  assert.equal(P.get('custom', '{broken').name, 'IR-RCNEC-BK');
});

test('invalid grid sizes, collisions, duplicate functions and unbounded labels are rejected', () => {
  const invalid = l => assert.throws(() => P.normalize(l));
  for (const [key, value] of [['columns', 0], ['columns', 6], ['rows', 13], ['name', ''], ['name', 'á'.repeat(33)]]) {
    const l = P.get('rcnec21'); l[key] = value; invalid(l);
  }
  for (const edit of [
    b => b[1].id = b[0].id,
    b => { b[1].row = b[0].row; b[1].column = b[0].column; },
    b => b[1].action = b[0].action,
    b => b[0].label = 'ű'.repeat(17),
    b => b[0].action = 'eval', b => b[0].row = 12, b => b[0].column = -1,
    b => b[0].shape = 'script', b => b[0].tone = 'url(javascript:...)'
  ]) { const l = P.get('rcnec21'); edit(l.buttons); invalid(l); }
  const full = { schemaVersion: 1, name: 'Full', columns: 5, rows: 8,
    buttons: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, row: i / 5 | 0, column: i % 5,
      label: String(i), action: '', shape: 'round', tone: 'normal' })) };
  assert.equal(P.normalize(full).buttons.length, 40);
  full.buttons.push({ ...full.buttons[0], id: 41 }); invalid(full);
});

test('button reassignment follows the physical button code, preserving all 64 bits without Number conversion', () => {
  const l = P.get('rcnec21'), codes = { 1: '18446744073709551615', 2: '12345678901234567890' };
  l.buttons[0].action = 'back'; l.buttons = l.buttons.filter(b => b.id !== 2);
  const map = P.codeMap(l, codes);
  assert.equal(map.back, '18446744073709551615');
  assert.equal(map.volUp, undefined); assert.equal(map.power, undefined);
  assert.equal(map.hash, '0');
  for (const bad of ['18446744073709551616', '-1', '1e3', '0x123', '3.1']) {
    assert.equal(P.codeValid(bad), false); assert.throws(() => P.codeMap(l, { 1: bad }));
  }
});

test('backend and browser share all profile/action identifiers and bounded layout dimensions', () => {
  const names = part => [...part.matchAll(/"([A-Za-z0-9]+)"/g)].map(m => m[1]);
  const profiles = names(policy.match(/PROFILES = \{([^]+?)\};/)[1]);
  const actions = names(policy.match(/ACTIONS = \{([^]+?)\};/)[1]);
  assert.deepEqual(profiles, ['rcnec21', 'car21', 'nav17', 'custom']);
  assert.deepEqual(actions, P.ACTIONS.map(a => a.action));
  assert.match(cpp, /DeserializationOption::NestingLimit\(4\)/);
  assert.match(cpp, /MAX_CUSTOM_BYTES/); assert.match(cpp, /usedActions\[actionIndex\]/);
  assert.match(cpp, /MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT/);
  const server = read('src/web/web_server.cpp');
  assert.match(server, /if \(!AppConfig::instance\(\).applyJson\(job->doc\)\) \{\s*status = 400/);
});

test('production capture/restore preserves each remote through repeated switches and clears learning on switch', () => {
  const names = P.ACTIONS.map(a => a.action), banks = Array.from({ length: 4 }, () => Array(31).fill(0n));
  const state = { banks, fields: Object.fromEntries(names.map(a => [a, 0n])) };
  function translate(code) { return code.replace(/size_t /g, 'let ').replace(/IrRemotePolicy::ACTIONS.size\(\)/g, 'names.length')
    .replace(/irRemoteCodes/g, 'state.banks').replace(/this->\*irCodeMembers\[i\]/g, 'state.fields[names[i]]'); }
  const capture = new Function('state', 'names', 'profile', translate(block(cpp, 'void AppConfig::captureIrRemoteCodes(')));
  const restore = new Function('state', 'names', 'profile', translate(block(cpp, 'void AppConfig::restoreIrRemoteCodes(')));
  for (let p = 0; p < 4; ++p) {
    names.forEach((a, i) => state.fields[a] = p === 0 && i === 0 ? 18446744073709551615n : BigInt(1000 * p + i + 1));
    capture(state, names, p);
  }
  for (let n = 0; n < 1000; ++n) {
    const p = n % 4; restore(state, names, p);
    assert.equal(state.fields.prev, p === 0 ? 18446744073709551615n : BigInt(1000 * p + 1));
    capture(state, names, p);
  }
  assert.match(cpp, /nextProfile != oldProfile[^]+?restoreIrRemoteCodes[^]+?irActionLearning = ""/);
  assert.ok(cpp.indexOf('validateIrRemoteCodeMap', cpp.indexOf('bool AppConfig::applyJson')) < cpp.indexOf('captureIrRemoteCodes(oldProfile'));
});

test('configuration saves no longer zero codes for buttons absent from the chosen visual template', () => {
  const app = read('data/app.js');
  assert.doesNotMatch(app, /inactiveIrActions/);
  const collect = block(app, 'function collectConfig()');
  assert.match(collect, /irActions.forEach/);
  assert.match(collect, /currentConfig\[irKey\(item.action\)\]/);
  assert.doesNotMatch(collect, /data\[irKey\(action\)\] = "0"/);
  assert.match(cpp, /doc\["irProfiles"\]/);
  assert.match(cpp, /doc\["irRemoteCustom"\] = irRemoteCustom/);
});

test('all editor copy, position and save controls have Hungarian, English and template translations', () => {
  const used = new Set([...read('data/ir-editor.js').matchAll(/tr\("([^"]+)"/g)].map(m => 'remote.' + m[1]));
  for (const m of read('data/index.html').matchAll(/data-i18n="(remote\.[^"]+)"/g)) used.add(m[1]);
  for (const language of ['hu', 'en', 'template']) {
    const text = read(`data/i18n/${language}.js`);
    for (const key of used) assert.ok(text.includes(JSON.stringify(key) + ':'), `${language}: ${key}`);
    for (const a of P.ACTIONS) assert.ok(text.includes(JSON.stringify('ir.action.' + a.action) + ':'), a.action);
  }
});
