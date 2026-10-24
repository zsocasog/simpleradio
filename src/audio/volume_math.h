#pragma once

#include <cstdint>

// Match the pinned audio driver's existing volume laws. Used only to remove
// the user's common playback attenuation from post-EQ visualization samples;
// this helper does not change samples, DAC gain, EQ or balance.
namespace VolumeMath {
enum class Curve : uint8_t { Soft, Linear, Log };

constexpr float gainDb(uint8_t volume, Curve curve) {
  const float t = (volume > 100 ? 100 : volume) / 100.0f;
  if (volume == 0) return -120.0f;
  if (curve == Curve::Linear) return -60.0f + 60.0f * t;
  if (curve == Curve::Log) return -60.0f + 60.0f * t * t;
  return -112.0f * t * t * t + 172.0f * t * t - 60.0f;
}
} // namespace VolumeMath
