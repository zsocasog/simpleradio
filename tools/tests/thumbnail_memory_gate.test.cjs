const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), test = require('node:test');
const { Gate, createAlbumLease } = require('./helpers/artwork_memory_gate.cjs');
const cache = fs.readFileSync(path.resolve(__dirname, '../../src/artwork/artwork_cache.cpp'), 'utf8');
const start = cache.indexOf('ArtworkMemory::AlbumPreparation thumbnailMemoryLease;');
assert.ok(start > 0);
const allocation = cache.slice(start, cache.indexOf('  bool locked = false;', start))
  .replace('ArtworkMemory::AlbumPreparation thumbnailMemoryLease;', 'const thumbnailMemoryLease = lease;')
  .replace('const uint32_t ', 'const ').replace(/3000U/g, '3000')
  .replace('millis() - thumbnailMemoryWaitStarted', '((millis() - thumbnailMemoryWaitStarted) >>> 0)');
function harness({caller=1, cancelled=false, releaseAt=Infinity, now=0}={}) {
  const gate=new Gate(), lease=createAlbumLease(gate);
  let waits=0;
  const c=vm.createContext({lease, artworkWorkerHandle:1, now,
    millis:()=>c.now>>>0, xTaskGetCurrentTaskHandle:()=>caller,
    idlePrewarmCancellationRequested:()=>cancelled,
    vTaskDelay:()=>{++waits;c.now+=10;if(waits>=releaseAt)gate.endStationSave();}
  });
  vm.runInContext('function acquire() {'+allocation+'return true;}',c);
  return {gate,lease,c,waits:()=>waits,run(){try{return c.acquire();}finally{lease.dispose();}}};
}
test('uncached thumbnail waits for an active save before acquiring decoder scratch, then releases the gate',()=>{
  const h=harness({releaseAt:3});assert.equal(h.gate.beginStationSave(),true);
  assert.equal(h.run(),true);assert.equal(h.waits(),3);assert.equal(h.gate.beginStationSave(),true);
});
test('thumbnail waiting is bounded and cancellation does not leave the album-pending bit set',()=>{
  for(const cancelled of [false,true]) {
    const h=harness({cancelled});h.gate.beginStationSave();
    assert.equal(h.run(),false);assert.equal(h.waits(),cancelled?0:300);
    h.gate.endStationSave();assert.equal(h.gate.beginStationSave(),true);
  }
});
test('the UI caller never waits behind station-save work',()=>{
  const h=harness({caller:2});h.gate.beginStationSave();
  assert.equal(h.run(),false);assert.equal(h.waits(),0);
  h.gate.endStationSave();assert.equal(h.gate.beginStationSave(),true);
});
test('an immediately available lease does not yield; wait deadline handles millis wrap',()=>{
  const available=harness();assert.equal(available.run(),true);assert.equal(available.waits(),0);
  const wrapped=harness({now:0xfffffff0});wrapped.gate.beginStationSave();
  assert.equal(wrapped.run(),false);assert.equal(wrapped.waits(),300);
});
test('ready thumbnails bypass the lease and waiting takes place before thumbnailMutex',()=>{
  const method=cache.slice(cache.indexOf('bool ArtworkCache::ensureLcdThumbnailPrepared('),start);
  assert.match(method,/AlbumArtStore::isPath/);assert.match(method,/thumbnailKnownReady/);
  assert.match(method,/validLcdThumbnailFile\(thumbPath\)/);
  assert.ok(start < cache.indexOf('xSemaphoreTake(thumbnailMutex',start));
  assert.match(cache.slice(start),/out\.setBufferSize\(512\);\s*const uint8_t header/);
});
