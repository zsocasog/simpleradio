const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const source = fs.readFileSync(path.join(root, "src/storage/buffered_writer.h"), "utf8");
function body(signature) {
  const start = source.indexOf("{", source.indexOf(signature));
  let depth = 0;
  for (let i = start; i < source.length; ++i) {
    if (source[i] === "{") ++depth;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("unclosed function");
}
function translate(code) {
  return code.replace(/sizeof\(buffer_\)/g, "512")
    .replace(/memcpy\(buffer_ \+ used_, data \+ accepted, count\);/g,
      "buffer_.set(data.subarray(accepted, accepted + count), used_);")
    .replace(/const size_t /g, "const ").replace(/size_t /g, "let ")
    .replace(/\b(buffer_|used_|failed_|sink_)\b/g, "this.$1")
    .replace(/!flush\(\)/g, "!this.flush()");
}
const Writer = vm.runInNewContext(`(class {
  constructor(sink) { this.sink_ = sink; this.buffer_ = new Uint8Array(512); this.used_ = 0; this.failed_ = false; }
  write(data, size = data.length) ${translate(body("size_t write(const uint8_t*"))}
  flush() ${translate(body("bool flush()"))}
})`);

test("production writer batches byte-sized and large writes without changing JSON bytes", () => {
  for (const size of [0, 1, 511, 512, 513, 8193]) {
    for (const step of [1, 73, 2048]) {
      const data = Uint8Array.from({ length: size }, (_, i) => i % 251);
      const chunks = [];
      const writer = new Writer({ write: (bytes, count) => { chunks.push(Buffer.from(bytes.slice(0, count))); return count; } });
      for (let i = 0; i < size; i += step) {
        const part = data.subarray(i, i + step); assert.equal(writer.write(part), part.length);
      }
      assert.equal(writer.flush(), true); assert.equal(writer.flush(), true);
      assert.deepEqual(Buffer.concat(chunks), Buffer.from(data));
      assert.equal(chunks.length, Math.ceil(size / 512));
    }
  }
});

test("short writes latch failure and cannot publish an incomplete settings file", () => {
  let calls = 0;
  const writer = new Writer({ write: (_data, size) => { ++calls; return size - 1; } });
  assert.equal(writer.write(new Uint8Array(513)), 0);
  assert.equal(writer.flush(), false);
  assert.equal(writer.write(new Uint8Array(3)), 0);
  assert.equal(calls, 1);
  const atomic = fs.readFileSync(path.join(root, "src/storage/atomic_file.cpp"), "utf8");
  assert.ok(atomic.indexOf("file.flush()") < atomic.indexOf("file.size() == written"));
  assert.ok(atomic.indexOf("if (!complete)") < atomic.indexOf("LittleFS.rename(target, backup)"));
});
