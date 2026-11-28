const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = name => fs.readFileSync(path.join(__dirname, '../..', name), 'utf8');
function body(name, signature) {
  const file = source(name);
  const start = file.indexOf(signature);
  assert.notEqual(start, -1, signature);
  return file.slice(file.indexOf('{', start), file.indexOf('\n}', start) + 2);
}

// Exercise the firmware expressions directly, with UTC broken down as for gmtime_r.
const solar = body('src/display/solar_brightness.h', 'inline bool isDay(')
  .replace(/(?:constexpr|const) (?:double|int|bool) /g, 'const ')
  .replaceAll('std::', 'Math.');
const daylight = vm.runInNewContext('(function(utc, latitudeE2, longitudeE2)' + solar + ')');
function isDay(iso, lat = 4750, lon = 1904) {
  const d = new Date(iso + 'Z');
  const y = d.getUTCFullYear();
  const utc = {tm_year:y - 1900, tm_yday:Math.floor((d - Date.UTC(y, 0, 1)) / 86400000),
    tm_hour:d.getUTCHours(), tm_min:d.getUTCMinutes()};
  return daylight(utc, lat, lon);
}

test('Budapest switches at the summer and winter horizon crossings', () => {
  for (const [date, times] of [
    ['2026-06-21', ['02:35', '02:55', '18:35', '18:55']],
    ['2026-12-21', ['06:20', '06:40', '14:45', '15:05']]
  ]) {
    assert.deepEqual(times.map(t => isDay(date + 'T' + t)), [false, true, true, false]);
  }
});

test('solar brightness follows longitude, leap day, polar day and polar night', () => {
  assert.equal(isDay('2024-02-29T00:00', 0, 17900), true);
  assert.equal(isDay('2024-02-29T00:00', 0, 0), false);
  assert.equal(isDay('2026-03-20T06:00', 0, 9000), true);
  assert.equal(isDay('2026-03-20T06:00', 0, -9000), false);
  for (const time of ['00:00', '06:00', '12:00', '18:00']) {
    assert.equal(isDay('2026-06-21T' + time, 9000, 0), true);
    assert.equal(isDay('2026-06-21T' + time, -9000, 0), false);
    assert.equal(isDay('2026-12-21T' + time, 9000, 0), false);
  }
});

test('mono centres the mix and switching back restores the latest stereo balance', () => {
  const calls = [];
  const ctx = {lastMonoOutput:false, lastBalance:127, map:n => n,
    audio:{forceMono:m => calls.push(['mono', m]), setBalance:b => calls.push(['balance', b])}};
  const apply = vm.runInNewContext('(function(mono, balance)' +
    body('src/audio/audio_player.cpp', 'void AudioPlayer::applyChannels(').replace('const int8_t ', 'const ') + ')', ctx);
  apply(false, 70); apply(true, 70); apply(true, -90); apply(false, -90); apply(false, -90);
  assert.deepEqual(calls, [['balance', 70], ['mono', true], ['balance', 0], ['mono', false], ['balance', -90]]);
});
