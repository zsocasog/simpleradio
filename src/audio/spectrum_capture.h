#pragma once

#include <cstddef>
#include <cstdint>
#include "spectrum_math.h"

namespace SpectrumCapture {
constexpr uint32_t INTERVAL_MS = 25;
// One LCD frame only: preserve a brief measured peak between two refreshes,
// without replaying a packet's old peaks after a display stall.
constexpr uint32_t PEAK_MERGE_MS = 33;
// PCM windows/results live in PSRAM. Kept bounded so a stalled analyzer never
// applies backpressure to output. Incoming blocks are actual sent DMA samples.
constexpr size_t BUFFER_COUNT = 16;

constexpr uint32_t windowHop(uint32_t sampleRate) {
  const uint32_t timed = sampleRate * INTERVAL_MS / 1000;
  return timed < SpectrumMath::POINT_COUNT ? SpectrumMath::POINT_COUNT : timed;
}

// Clock anchored to actual DMA completion, never the first decoder packet.
// Frame positions include zeros/underruns and blocks the analyzer had to skip.
struct Clock {
  bool ready = false;
  uint32_t anchorMs = 0;
  uint64_t frames = 0;
  uint32_t epoch = 0;

  constexpr uint32_t timeAt(uint64_t frame, uint32_t rate) const {
    return anchorMs + static_cast<uint32_t>(frame * 1000 / rate);
  }
  constexpr bool discontinuity(uint64_t firstFrame, uint32_t outputEpoch) const {
    return ready && (frames != firstFrame || epoch != outputEpoch);
  }
  constexpr void observe(uint64_t firstFrame, size_t count, uint32_t endedMs,
                         uint32_t rate, uint32_t outputEpoch) {
    ready = true;
    frames = firstFrame + count;
    epoch = outputEpoch;
    anchorMs = endedMs - static_cast<uint32_t>(frames * 1000 / rate);
  }
};
} // namespace SpectrumCapture
