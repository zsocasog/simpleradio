#include "../../src/audio/spectrum_output_queue.h"
#include "../../src/audio/spectrum_math.h"

using namespace SpectrumOutput;
static_assert(BLOCK_COUNT * BLOCK_FRAMES * 2 * sizeof(int32_t) == 4096);
static_assert(BLOCK_COUNT * BLOCK_FRAMES * 2 * sizeof(int32_t) ==
              SpectrumMath::POINT_COUNT * sizeof(float)); // Balanced by PSRAM Hann weights.
static_assert(sizeof(Queue) < 128);

constexpr Stamp block(uint64_t first, uint32_t at) {
  return {first, at, 0, 44100, 256};
}

constexpr bool ordinaryHandoff() {
  Queue q;
  q.reset();
  const int a = q.reserve(block(0, 100));
  const int b = q.reserve(block(256, 106));
  if (a < 0 || b < 0 || q.reserve(block(512, 111)) != -1) return false;
  if (!q.commit(b) || !q.commit(a)) return false; // Completion order cannot reorder PCM.
  uint32_t expired = 0;
  if (q.take(110, expired) != a) return false;
  if (q.slots[a].stamp.firstFrame != 0 || q.slots[a].stamp.epoch != q.epoch) return false;
  q.release(a);
  return q.take(110, expired) == b && expired == 0;
}
static_assert(ordinaryHandoff());

constexpr bool resetWhileCopyingOrReading() {
  Queue q;
  const int copying = q.reserve(block(0, 100));
  q.reset();
  const int other = q.reserve(block(256, 106));
  if (other == copying || q.commit(copying)) return false;
  if (!q.commit(other)) return false;
  uint32_t expired = 0;
  if (q.take(110, expired) != other) return false;
  q.reset();
  if (q.reserve(block(512, 112)) == other) return false;
  q.release(other);
  return q.slots[other].state == State::Free;
}
static_assert(resetWhileCopyingOrReading());

constexpr bool staleBlocksAndRollover() {
  Queue q;
  const int a = q.reserve(block(0, 0xfffffff0u));
  q.commit(a);
  uint32_t expired = 0;
  if (q.take(0x10u, expired) != a || expired) return false;
  q.release(a);
  const int b = q.reserve(block(256, 0x20u));
  q.commit(b);
  return q.take(0x20u + MAX_HANDOFF_AGE_MS + 1, expired) == -1 && expired == 1;
}
static_assert(staleBlocksAndRollover());

constexpr bool clockReadBeforeInterruptIsNotAStaleBlock() {
  Queue q;
  const int a = q.reserve(block(0, 101));
  q.commit(a);
  uint32_t expired = 0;
  if (q.take(100, expired) != -1 || expired != 0) return false;
  return q.take(101, expired) == a && expired == 0;
}
static_assert(clockReadBeforeInterruptIsNotAStaleBlock());

constexpr bool oneReaderNeverAliasesProducer() {
  Queue q;
  uint32_t expired = 0;
  auto a = q.reserve(block(0, 10)); q.commit(a);
  if (q.take(10, expired) != a) return false;
  auto b = q.reserve(block(256, 16)); q.commit(b);
  if (q.reserve(block(512, 22)) != -1 || a == b) return false;
  q.release(a);
  auto c = q.reserve(block(768, 28));
  return c == a && q.slots[b].stamp.firstFrame == 256;
}
static_assert(oneReaderNeverAliasesProducer());
