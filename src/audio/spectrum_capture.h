#pragma once

#include <cstddef>
#include <cstdint>
#include "spectrum_math.h"

namespace SpectrumCapture {
constexpr uint32_t INTERVAL_MS = 25;
// One LCD frame only: preserve a brief measured peak between two refreshes,
// without replaying a packet's old peaks after a display stall.
constexpr uint32_t PEAK_MERGE_MS = 33;
// Enough for the pinned driver's 8192-frame DMA lead plus a 4608-frame packet.
// PCM lives in PSRAM; queued windows are never replayed late after a stall.
constexpr size_t BUFFER_COUNT = 16;

constexpr uint32_t windowHop(uint32_t sampleRate) {
  const uint32_t timed = sampleRate * INTERVAL_MS / 1000;
  return timed < SpectrumMath::POINT_COUNT ? SpectrumMath::POINT_COUNT : timed;
}

// Decoder callbacks contain packets, not uniformly timed audio. Keep a sample
// clock so several windows from one FLAC packet can be presented in sequence.
struct Clock {
  bool ready = false;
  uint32_t anchorMs = 0;
  uint64_t frames = 0;

  constexpr uint32_t timeAt(uint64_t frame, uint32_t rate) const {
    return anchorMs + static_cast<uint32_t>(frame * 1000 / rate);
  }
  constexpr bool discontinuity(uint32_t now, uint32_t rate) const {
    if (!ready || !rate) return false;
    const int32_t skew = static_cast<int32_t>(now - timeAt(frames, rate));
    const uint32_t bufferedMs = 8192u * 1000 / rate + 50;
    const int32_t tolerance = bufferedMs > 250 ? bufferedMs : 250;
    return skew > tolerance || skew < -tolerance;
  }
  constexpr void start(uint32_t now) { ready = true; anchorMs = now; frames = 0; }
  constexpr uint64_t append(size_t count) {
    const uint64_t start = frames;
    frames += count;
    return start;
  }
};
} // namespace SpectrumCapture
