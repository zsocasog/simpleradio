const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/artwork/artwork_cache.cpp'), 'utf8');

function body(signature) {
  const at = source.indexOf(signature); assert.ok(at >= 0, signature);
  const start = source.indexOf('{', at); let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(signature);
}

test('a stale stopped snapshot cannot erase a successful audio connection', () => {
  const transition = body('if (state.playing != lastArtworkPlaying)');
  const result = body('void ArtworkCache::notifyAudioConnectResult(')
    .replace(/static_cast<unsigned long>\(/g, 'Number(');
  const context = vm.createContext({ state: { playing: false }, lastArtworkPlaying: true,
    audioConnectionReady: false, audioConnectionReadyMs: 0, lastIdlePrewarmStationId: 2,
    lastAttemptMs: 90, CURRENT_ARTWORK_TLS_GRACE_MS: 5000,
    now: 1000, millis: () => context.now, Serial: { printf() {} } });
  vm.runInContext('function connected(connected) '+result+'\nfunction stoppedSnapshot() '+transition, context);
  context.connected(true); // The pump connected after main captured playing=false.
  context.stoppedSnapshot();
  assert.equal(context.audioConnectionReady, true);
  assert.equal(context.audioConnectionReadyMs, 1000);
  context.connected(false); // Only the pump's actual stop/disconnect clears it.
  assert.equal(context.audioConnectionReady, false);
  assert.equal(context.audioConnectionReadyMs, 0);
});

test('failed task starts get a short retry while completed missing-cover searches keep their backoff', () => {
  const constants = [...source.matchAll(/static constexpr unsigned long (ALBUM_ART_(?:START|MISSING)_RETRY_MS) = (\d+);/g)]
    .map(m => `const ${m[1]}=${m[2]};`).join('\n');
  const retry = source.match(/lastAlbumStartFailed\s*\? ALBUM_ART_START_RETRY_MS : ALBUM_ART_MISSING_RETRY_MS/)[0];
  const due = vm.runInNewContext(constants + '\n(failed, elapsed) => { const lastAlbumStartFailed=failed; return elapsed >= ('+retry+'); }');
  assert.equal(due(true, 2999), false);
  assert.equal(due(true, 3000), true);
  assert.equal(due(false, 3000), false);
  assert.equal(due(false, 120000), true);
});
