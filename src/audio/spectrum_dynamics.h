#pragma once

#include <array>
#include <cstdint>

namespace SpectrumDynamics {
constexpr float SILENCE_DB = -66.0f;

constexpr float clamp(float value, float low, float high) {
  return value < low ? low : value > high ? high : value;
}

// sqrt(RMS amplitude), tabulated at 6 dB intervals for a cheap, monotonic
// musical display curve. Unlike a 60dB-to-25px straight line, quiet signals do
// not immediately occupy most of the screen. There is NO frequency weighting.
constexpr std::array<float, 14> HEIGHT = {
    5.7087f, 8.0638f, 11.3904f, 16.0894f, 22.727f, 32.1026f, 45.3461f,
    64.0531f, 90.4774f, 127.8027f, 180.5262f, 255.0f, 360.1971f, 508.7919f};

constexpr float displayLevel(float measuredDb, float commonGainDb, uint16_t sensitivity) {
  if (!(measuredDb > SILENCE_DB)) return 0; // Includes NaN and true silence.
  const float gate = clamp((measuredDb - SILENCE_DB) / 6.0f, 0, 1);
  const float position = clamp((measuredDb + commonGainDb + 66.0f) / 6.0f, 0, 13);
  const unsigned index = static_cast<unsigned>(position);
  const float height = index >= HEIGHT.size() - 1 ? HEIGHT.back() :
      HEIGHT[index] + (HEIGHT[index + 1] - HEIGHT[index]) * (position - index);
  // This is VISUAL sensitivity: 50% really halves the height. Clip only last.
  return clamp(height * gate * clamp(sensitivity, 50, 200) / 100.0f, 0, 255);
}

struct LevelTracker {
  float gainDb = 0;
  uint32_t frameMs = 0;
  uint32_t generation = 0;
  bool ready = false;

  void reset() { *this = {}; }

  void update(float peakDb, float rmsDb, uint32_t capturedMs, uint32_t frameGeneration) {
    if (ready && generation == frameGeneration && frameMs == capturedMs) return;
    uint32_t elapsed = ready && generation == frameGeneration ? capturedMs - frameMs : 50;
    if (!ready || generation != frameGeneration) gainDb = 0;
    generation = frameGeneration;
    frameMs = capturedMs;
    ready = true;
    if (elapsed > 250) elapsed = 250;
    // Silence/quiet passages must not turn into noise or slowly growing bars.
    if (!(rmsDb > -50.0f) || !(peakDb > SILENCE_DB)) return;
    const float target = clamp(-12.0f - peakDb, -12.0f, 6.0f);
    // ONE shared gain preserves bass/mid/treble ratios. Reduce rapidly for
    // headroom; any extra sensitivity grows very slowly (15s), never per band.
    const float timeMs = target < gainDb ? 180.0f : 15000.0f;
    gainDb += (target - gainDb) * elapsed / (timeMs + elapsed);
  }
};
} // namespace SpectrumDynamics
