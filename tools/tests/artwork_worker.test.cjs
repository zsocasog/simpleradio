const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/artwork/artwork_cache.cpp'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.cpp'), 'utf8');
function body(marker) {
  const at = source.indexOf(marker); assert.ok(at >= 0, marker);
  const start = source.indexOf('{', at); let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(marker);
}
// Exercise production queue/start/lifecycle code with FreeRTOS substitutes.
// Static stack/control storage is separate from the simulated fragmented heap.
const initCode = body('bool ArtworkCache::startWorker()')
  .replace(/sizeof\(ArtworkDownloadJob\*\)/g, '4')
  .replace(/&artwork(?:Queue|Worker)Control/g, 'null')
  .replace(/ArtworkCache::downloadTask/g, 'downloadTask');
const submitCode = body('bool ArtworkCache::queueDownloadJob(').replace('&job', 'job');
const loopCode = body('void ArtworkCache::downloadTask(')
  .replace('ArtworkCache* cache = static_cast<ArtworkCache*>(param);', 'const cache = param;')
  .replace('ArtworkDownloadJob* job = nullptr;', 'let job = null;')
  .replace('const bool diskJob = job && job->kind != ArtworkJobKind::AlbumSearch && job->kind != ArtworkJobKind::PickerLogo;',
    'const diskJob = job && job.kind !== "album" && job.kind !== "picker";')
  .replace(/const (?:bool|uint32_t) /g,'const ').replace(/job->/g,'job.')
  .replace(/ArtworkJobKind::Thumbnail/g,'"thumbnail"').replace(/ArtworkJobKind::CacheStats/g,'"stats"').replace(/PlayerState::instance\(\)\.snapshot\(\)\.playing/g,'false')
  .replace(/cache->lcdDiskWrites.load\(\)/g,'0')
  .replace('xQueueReceive(artworkJobQueue, &job, portMAX_DELAY)',
    'xQueueReceive(artworkJobQueue, value => job = value, portMAX_DELAY)')
  .replaceAll('cache->', 'cache.');
function harness() {
  const c = vm.createContext({ artworkWorkerHandle: null, artworkJobQueue: null,
    artworkQueueStorage: {}, artworkWorkerStack: { bytes: 12288, internal: true },
    ARTWORK_TASK_STACK_BYTES: 12288, ARTWORK_TASK_PRIORITY: 0, ARTWORK_TASK_CORE: -1,
    portMAX_DELAY: Infinity, pdTRUE: 1, nullptr: null,
    queueCreates: 0, taskCreates: 0, pending: [], received: [], done: 0, stats: 0, traces: [],
    heap: { total: 44744, largest: 12276 },
    queueFailure: false, taskFailure: false, allocations: 0, heldResources: 0,
    xQueueCreateStatic: (count, size) => {
      ++c.queueCreates; assert.equal(count, 1); assert.equal(size, 4);
      return c.queueFailure ? null : {};
    },
    xTaskCreateStaticPinnedToCore: (_entry, _name, bytes, _param, priority, stack, _tcb, core) => {
      ++c.taskCreates; assert.equal(bytes, stack.bytes); assert.equal(stack.internal, true);
      assert.equal(priority, 0); assert.equal(core, -1);
      return c.taskFailure ? null : {};
    },
    xQueueSend: (_q, job, wait) => {
      assert.equal(wait, 0);
      if (c.pending.length) return 0;
      c.pending.push(job); return 1;
    },
    xQueueReceive: (_q, set, wait) => {
      assert.equal(wait, Infinity);
      if (!c.pending.length) throw finished;
      set(c.pending.shift()); return 1;
    },
    runDownloadJob: job => {
      ++c.heldResources; c.received.push(job);
      // Failure/cancellation have the same resource destruction boundary.
      if (job.action) job.action(c);
      --c.heldResources;
    },
    albumArtTrace: msg => c.traces.push(msg)
  });
  const finished = {};
  vm.runInContext(`function downloadTask(param) ${loopCode}
    function startWorker() ${initCode}
    function queueDownloadJob(job) ${submitCode}`, c);
  c.run = () => {
    try { c.downloadTask({ cacheStatsPending:{value:false,load(){return this.value;},store(v){this.value=v;}}, refreshCacheStats() { assert.equal(c.heldResources,0); ++c.stats; }, markDownloadFinished() {
      assert.equal(c.heldResources, 0); ++c.done;
    } }); } catch (e) { if (e !== finished) throw e; }
  };
  return c;
}

test('the reported 44744 total/12276 largest heap cannot allocate the old stack, but starts the static worker', () => {
  const c = harness();
  assert.ok(c.heap.total > 12288); assert.ok(c.heap.largest < 12288);
  assert.equal(c.startWorker(), true); assert.equal(c.taskCreates, 1);
  assert.equal(c.allocations, 0); assert.equal(c.traces.length, 1);
  assert.match(source, /alignas\(16\) static StackType_t artworkWorkerStack\[ARTWORK_TASK_STACK_BYTES \/ sizeof\(StackType_t\)\]/);
  assert.match(source, /static StaticTask_t artworkWorkerControl/);
  assert.doesNotMatch(body('bool ArtworkCache::startWorker()'), /malloc|SPIRAM|vTaskPrioritySet/);
  assert.ok(body('void ArtworkCache::begin()').includes('startWorker()'));
  assert.ok(main.indexOf('ArtworkCache::instance().begin()') < main.indexOf('wifi.begin()'));
  assert.ok(main.indexOf('ArtworkCache::instance().begin()') < main.indexOf('audioPlayer.begin()'));
});

test('repeated album, logo, picker, thumbnail and embedded jobs reuse one stack without heap churn', () => {
  const c = harness(); assert.equal(c.startWorker(), true);
  for (let i = 0; i < 200; ++i) {
    assert.equal(c.startWorker(), true);
    const job = { kind: ['album', 'logo', 'picker', 'thumbnail', 'embedded', 'browser'][i % 6], i };
    assert.equal(c.queueDownloadJob(job), true); c.run();
    assert.equal(c.received[i], job); assert.equal(c.done, i + 1);
  }
  assert.equal(c.taskCreates, 1); assert.equal(c.queueCreates, 1); assert.equal(c.allocations, 0);
  assert.equal(c.stats,c.received.filter(job=>!['album','picker','thumbnail'].includes(job.kind)).length);
  assert.doesNotMatch(source, /xTaskCreatePinnedToCore\(|vTaskDelete\(/);
});

test('absent worker, null jobs and a full queue reject without waiting or taking ownership', () => {
  const c = harness(); const first = { id: 1 }, second = { id: 2 };
  assert.equal(!!c.queueDownloadJob(first), false); assert.equal(c.pending.length, 0);
  c.startWorker(); assert.equal(!!c.queueDownloadJob(null), false);
  assert.equal(c.queueDownloadJob(first), true); assert.equal(c.queueDownloadJob(second), false);
  assert.deepEqual(c.pending, [first]); c.run();
  assert.equal(c.queueDownloadJob(second), true); c.run(); assert.equal(c.done, 2);
});

test('a failed queue/task initialization never exposes a ready worker and can safely retry', () => {
  for (const flag of ['queueFailure', 'taskFailure']) {
    const c = harness(); c[flag] = true;
    assert.equal(c.startWorker(), false); assert.equal(!!c.queueDownloadJob({}), false);
    c[flag] = false; assert.equal(c.startWorker(), true);
    assert.equal(c.queueDownloadJob({}), true); c.run(); assert.equal(c.done, 1);
  }
});

test('admission is released after job resources are destroyed, including cancellation and no-cover results', () => {
  const c = harness(); c.startWorker();
  for (const kind of ['cancelled-logo', 'no-cover', 'picker', 'invalid-image']) {
    c.queueDownloadJob({ kind, action: state => {
      assert.equal(state.heldResources, 1); assert.equal(state.done, state.received.length - 1);
    } }); c.run();
  }
  assert.equal(c.done, 4);
  assert.doesNotMatch(body('void ArtworkCache::runDownloadJob('), /markDownloadFinished|vTaskDelete/);
  assert.ok(loopCode.indexOf('runDownloadJob(job)') < loopCode.indexOf('cache.markDownloadFinished()'));
});

test('all six dispatch paths retain the single admission gate and release failed submissions', () => {
  for (const name of ['startDownloadTask', 'startAlbumArtworkTask', 'startEmbeddedDownloadTask',
    'processPendingPickerLogo', 'startThumbnailTask', 'startBrowserArtworkImportTask']) {
    const code = body(`${name === 'processPendingPickerLogo' ? 'void' : 'bool'} ArtworkCache::${name}(`);
    assert.ok(code.indexOf('markDownloadStarted(') < code.indexOf('queueDownloadJob(job)'));
    const failure = code.slice(code.indexOf('if (!queueDownloadJob(job))'));
    assert.match(failure, /delete job/); assert.match(failure, /markDownloadFinished\(\)/);
  }
});
