#pragma once

#include <cstddef>
#include <cstdint>

// Only the small DMA hand-off lives in internal RAM. FFT windows/results keep
// using PSRAM. The ISR never touches PSRAM (I2S_ISR_IRAM_SAFE is enabled).
namespace SpectrumOutput {
constexpr size_t BLOCK_FRAMES = 256;
constexpr size_t BLOCK_COUNT = 2;
constexpr uint32_t MAX_HANDOFF_AGE_MS = 60;

struct Stamp {
  uint64_t firstFrame = 0;
  uint32_t endedMs = 0;
  uint32_t epoch = 0;
  uint32_t sampleRate = 0;
  uint16_t frames = 0;
};

enum class State : uint8_t { Free, Writing, Ready, Reading };
struct Slot { Stamp stamp; State state = State::Free; };

// Caller supplies the short ISR/task critical section. No allocation, clocks,
// waits or samples in this policy. Always inline the ISR-facing operations.
struct Queue {
  Slot slots[BLOCK_COUNT]{};
  uint32_t epoch = 0;

  __attribute__((always_inline)) constexpr void reset() {
    ++epoch;
    for (auto& slot : slots) {
      // An in-flight memcpy/reader owns its buffer until it finishes.
      if (slot.state != State::Reading && slot.state != State::Writing) slot.state = State::Free;
    }
  }
  __attribute__((always_inline)) constexpr int reserve(Stamp stamp) {
    for (size_t i = 0; i < BLOCK_COUNT; ++i) {
      if (slots[i].state != State::Free) continue;
      stamp.epoch = epoch;
      slots[i].stamp = stamp;
      slots[i].state = State::Writing;
      return static_cast<int>(i);
    }
    return -1; // Drop visualization input, never wait for the consumer.
  }
  __attribute__((always_inline)) constexpr bool commit(size_t index) {
    auto& slot = slots[index];
    if (slot.stamp.epoch != epoch) { slot.state = State::Free; return false; }
    slot.state = State::Ready;
    return true;
  }
  constexpr int take(uint32_t nowMs, uint32_t& expired) {
    int oldest = -1;
    for (size_t i = 0; i < BLOCK_COUNT; ++i) {
      auto& slot = slots[i];
      if (slot.state != State::Ready) continue;
      const int32_t ageMs = static_cast<int32_t>(nowMs - slot.stamp.endedMs);
      if (slot.stamp.epoch != epoch || ageMs > static_cast<int32_t>(MAX_HANDOFF_AGE_MS)) {
        slot.state = State::Free; ++expired; continue;
      }
      if (ageMs < 0) continue; // An older clock snapshot is not an expired block.
      if (oldest < 0 || slot.stamp.firstFrame < slots[oldest].stamp.firstFrame) oldest = static_cast<int>(i);
    }
    if (oldest >= 0) slots[oldest].state = State::Reading;
    return oldest;
  }
  constexpr void release(size_t index) { slots[index].state = State::Free; }
};
} // namespace SpectrumOutput
