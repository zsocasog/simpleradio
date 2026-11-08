const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vm = require('node:vm'), test = require('node:test');
const { Gate, createAlbumLease, source: gateSource } = require('./helpers/artwork_memory_gate.cjs');
const root = path.resolve(__dirname, '../..');
const cache = fs.readFileSync(path.join(root, 'src/artwork/artwork_cache.cpp'), 'utf8');
const policy = fs.readFileSync(path.join(root, 'src/artwork/album_art_policy.h'), 'utf8');
function block(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error('unclosed production block');
}
const functionBody = (source, name) => block(source, source.indexOf('{', source.indexOf(name + '(')));
const constants = [...policy.matchAll(/constexpr (?:size_t|uint32_t) (\w+) = ([^;]+);/g)]
  .map(m => `const ${m[1]} = ${m[2]};`).join('\n');
const functions = ['internalHeadroom', 'internalBlock', 'internalReady', 'ramRetryRemaining'].map(name => {
  const args = name === 'ramRetryRemaining' ? 'started,now,deadline' : name === 'internalReady' ? 'format,freeBytes,largestBlock' : 'format';
  const body = functionBody(policy, name).replace(/Format::/g, 'Format.')
    .replace('const uint32_t elapsed = now - started;', 'const elapsed = (now - started) >>> 0;')
    .replace('static_cast<int32_t>(deadline - now)', '((deadline - now) | 0)')
    .replace(/static_cast<uint32_t>\(budgetLeft\)/g, '(budgetLeft >>> 0)')
    .replace(/const (?:uint32_t|int32_t) /g, 'const ');
  return `function ${name}(${args}) ${body}`;
}).join('\n');
const policies = new Function('Format', constants + '\n' + functions + ';return {internalReady,ramRetryRemaining,RAM_RETRY_INTERVAL_MS};')({Jpeg:1,Png:2});
const prepare = cache.slice(cache.indexOf('bool ArtworkCache::prepareAlbumMemory('), cache.indexOf('bool ArtworkCache::download(const String&'));
const phase = prepare.indexOf('ArtworkPhaseTrace phase("RAM-reserve");');
let loop = block(prepare, prepare.lastIndexOf('{', phase))
  .replace('ArtworkPhaseTrace phase("RAM-reserve");', '')
  .replace('AlbumArtStore::instance().reserve(key, LCD_THUMB_SIZE, info.format, &reserveStatus)', 'reserve()')
  .replace(/AlbumArtStore::ReserveFailure::/g, 'Failure.').replace(/AlbumArtStore::failureName/g, 'failureName')
  .replace(/AlbumArtPolicy::/g, 'policy.')
  .replace(/static_cast<unsigned long>\(millis\(\) - retryStartedMs\)/g, '(millis() - retryStartedMs)')
  .replace(/static_cast<unsigned long>\(remainingMs\)/g, 'remainingMs')
  .replace(/static_cast<unsigned>\(length\)/g, 'length')
  .replace('static_cast<TickType_t>(1)', '1').replace(/const uint32_t /g, 'const ');

function harness({ start = 100, deadline = 0, freeAt = 200, cancelAt = Infinity, failure = 'InternalLow', format = 1,
  largest = 7668, stationUntil = null } = {}) {
  const gate = new Gate(), lease = createAlbumLease(gate), attempts = [], sleeps = [], logs = [];
  if (stationUntil !== null) gate.beginStationSave();
  const image = { bytes: Buffer.alloc(24306, 7) };
  const c = vm.createContext({ now: start, deadlineMs: deadline, frame: null, data: image, length: 24306,
    reserveAttempted: false, waitedForMemory: false, reserveStatus: { failure: null },
    memoryLease: lease, Failure: { InternalLow: 'InternalLow', SlotsBusy: 'SlotsBusy' },
    policy: policies, min: Math.min, max: Math.max, pdMS_TO_TICKS: value => value,
    millis: () => c.now, stillCurrent: () => c.now < cancelAt,
    deadlineReached: value => value !== 0 && ((c.now - value) | 0) >= 0,
    failureName: value => value,
    albumArtTrace: (...args) => logs.push(args),
    reserve: () => {
      const bytes = c.now >= freeAt ? 30000 : 22988;
      attempts.push({ now: c.now, bytes, image: c.data });
      if (failure === 'SlotsBusy' && c.now < freeAt) c.reserveStatus.failure = failure;
      else if (failure !== 'InternalLow' && failure !== 'SlotsBusy') c.reserveStatus.failure = failure;
      else if (!policies.internalReady(format, bytes, largest)) c.reserveStatus.failure = 'InternalLow';
      else return { path: '/api/artwork/album?id=same-download' };
      return null;
    },
    vTaskDelay: ms => {
      sleeps.push(ms); c.now = (c.now + ms) >>> 0;
      if (stationUntil !== null && c.now >= stationUntil) gate.endStationSave();
    }
  });
  return { c, gate, attempts, sleeps, logs, image,
    run() { try { vm.runInContext(loop, c); } finally { lease.dispose(); } } };
}

test('the Nickelback memory snapshot recovers using the already downloaded 24306 bytes', () => {
  const h = harness(); h.run(); assert.ok(h.c.frame); assert.ok(h.attempts.length > 1);
  assert.equal(h.attempts[0].bytes, 22988); assert.equal(h.c.now, 200);
  for (const attempt of h.attempts) assert.equal(attempt.image, h.image);
  assert.equal(h.c.data, h.image); assert.equal(h.logs.length, 2);
  assert.match(h.logs[0][0], /RAM wait/); assert.match(h.logs[1][0], /RAM recovered/);
});

test('steady low memory keeps the original 24 KiB guard and stops waiting after 1500 ms', () => {
  const h = harness({freeAt:Infinity}); h.run(); assert.equal(h.c.frame, null);
  assert.equal(h.c.now, 1600); assert.equal(h.sleeps.reduce((a,b)=>a+b,0),1500); assert.equal(h.logs.length,1);
  assert.equal(h.gate.beginStationSave(),true);
});

test('the image deadline wins over memory retry and does not trigger another reserve afterwards', () => {
  const h = harness({deadline:170,freeAt:Infinity}); h.run(); assert.equal(h.c.now,170); assert.equal(h.c.frame,null);
  assert.ok(h.attempts.every(a=>a.now<170)); assert.equal(h.sleeps.reduce((a,b)=>a+b,0),70);
});

test('track changes cancel the retry and release the memory gate promptly', () => {
  const h = harness({freeAt:Infinity,cancelAt:175}); h.run(); assert.equal(h.c.now,175); assert.equal(h.c.frame,null);
  assert.equal(h.gate.beginStationSave(),true);
});

test('existing web/LCD slot leases may finish while the same compressed bytes wait', () => {
  const h = harness({failure:'SlotsBusy',freeAt:225}); h.run(); assert.ok(h.c.frame); assert.equal(h.c.now,225);
  assert.equal(h.c.data,h.image);
});

test('non-transient allocation failures do not spin or mask their original reason', () => {
  for (const failure of ['FrameAllocation','PixelAllocation','PsramLow','Invalid']) {
    const h = harness({failure}); h.run(); assert.equal(h.attempts.length,1); assert.equal(h.sleeps.length,0);
    assert.equal(h.c.reserveStatus.failure,failure); assert.equal(h.logs.length,0);
  }
});

test('a downloaded image waits for station-save completion and deferred stack cleanup', () => {
  const h = harness({stationUntil:200,freeAt:225}); h.run(); assert.ok(h.c.frame);
  assert.equal(h.attempts[0].now,200); assert.equal(h.c.now,225);
  assert.equal(h.logs[0][1],'station save active');
});

test('a persistent station save is bounded and a cancelled album cannot strand the next save', () => {
  const h = harness({stationUntil:Infinity,cancelAt:150}); h.run(); assert.equal(h.attempts.length,0); assert.equal(h.c.now,150);
  h.gate.endStationSave(); assert.equal(h.gate.beginStationSave(),true);
});

test('retry timing remains bounded through millis rollover and preserves PNG/contiguous guards', () => {
  assert.equal(policies.ramRetryRemaining(0xfffffff0,0x20,0),1452);
  assert.equal(policies.ramRetryRemaining(0xfffffff0,0x20,0x30),16);
  const h = harness({start:0xffffff00,freeAt:Infinity}); h.run(); assert.equal(h.c.now,1244);
  assert.equal(h.sleeps.reduce((a,b)=>a+b,0),1500);
  assert.equal(policies.internalReady(1,22988,7668),false);
  assert.equal(policies.internalReady(1,30000,3900),false);
  assert.equal(policies.internalReady(2,30000,8000),false);
});

test('album preparation owns the gate through decode/publication and retains deadline/cancellation checks', () => {
  assert.ok(prepare.indexOf('ArtworkMemory::AlbumPreparation memoryLease')<prepare.indexOf('instance().reserve('));
  assert.ok(prepare.indexOf('if (!drawn || !stillCurrent() || deadlineReached(deadlineMs))')<prepare.indexOf('instance().publish(frame)'));
  assert.doesNotMatch(loop,/LittleFS|\.reset\(|download\(|free\(|malloc\(/);
  assert.match(gateSource,/~AlbumPreparation\(\)[^]*?endAlbumPrepare\(\)[^]*?cancelAlbumWait\(\)/);
});

test('gate prioritizes a waiting album and does not permit simultaneous station and album work', () => {
  const gate=new Gate(); assert.equal(gate.beginStationSave(),true); assert.equal(gate.beginAlbumPrepare(),false);
  assert.equal(gate.beginStationSave(),false); gate.endStationSave();
  assert.equal(gate.beginStationSave(),false); assert.equal(gate.beginAlbumPrepare(),true);
  assert.equal(gate.beginStationSave(),false); gate.endAlbumPrepare(); assert.equal(gate.beginStationSave(),true);
});
