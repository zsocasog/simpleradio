// Execute the production gate methods; only std::atomic is replaced by a
// deterministic atomic-word adapter so task interleavings can be controlled.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../src/artwork/artwork_memory_gate.h'), 'utf8');
function method(name) {
  const start = source.indexOf('{', source.indexOf(name + '(')); let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === '{') ++depth;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(name);
}
class AtomicWord {
  constructor() { this.value = 0; }
  compare_exchange_strong(expected, desired) {
    if (this.value !== expected) return false; this.value = desired >>> 0; return true;
  }
  fetch_or(bits) { const old = this.value; this.value = (old | bits) >>> 0; return old; }
  fetch_and(bits) { const old = this.value; this.value = (old & bits) >>> 0; return old; }
}
const constants = [...source.matchAll(/static constexpr uint32_t (\w+) = ([^;]+);/g)]
  .map(m => `const ${m[1]} = ${m[2]};`).join('\n');
const methods = ['beginStationSave', 'endStationSave', 'beginAlbumPrepare', 'endAlbumPrepare', 'cancelAlbumWait']
  .map(name => `${name}() ${method(name).replace(/uint32_t /g, 'let ').replace(/\bstate_\b/g, 'this.state_')}`).join('\n');
const Gate = vm.runInNewContext(`(() => { ${constants} return class {
  constructor() { this.state_ = new AtomicWord(); }
  ${methods}
}; })()`, { AtomicWord });
const leaseBody = name => method(name).replace(/\b(held_|requested_)\b/g, 'this.$1');
const Lease = new Function('gate', `return class {
  constructor() { this.held_ = false; this.requested_ = false; }
  tryAcquire() ${leaseBody('tryAcquire')}
  dispose() ${leaseBody('~AlbumPreparation')}
};`);
module.exports = { Gate, source, createAlbumLease: gate => new (Lease(() => gate))() };
