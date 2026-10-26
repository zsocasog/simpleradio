#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace SpectrumDynamics {
constexpr float SILENCE_DB = -66.0f;

constexpr float clamp(float value, float low, float high) {
  return value < low ? low : value > high ? high : value;
}

// Fixed musical display scale, at 6 dB intervals from -66 dBFS. Around -12 dBFS
// a band uses 84% of the height instead of the former 50%. Quiet details stay
// small; one scale for every band preserves spectral contrast. No AGC or EQ.
constexpr std::array<float, 14> HEIGHT = {
    0, 0, 6, 15, 30, 52, 82, 119, 164, 213, 255, 300, 345, 390};

constexpr float displayLevel(float measuredDb, uint16_t sensitivity) {
  if (!(measuredDb > SILENCE_DB)) return 0; // Includes NaN and true silence.
  const float gate = clamp((measuredDb - SILENCE_DB) / 6.0f, 0, 1);
  const float position = clamp((measuredDb + 66.0f) / 6.0f, 0, 13);
  const unsigned index = static_cast<unsigned>(position);
  const float height = index >= HEIGHT.size() - 1 ? HEIGHT.back() :
      HEIGHT[index] + (HEIGHT[index + 1] - HEIGHT[index]) * (position - index);
  // This is VISUAL sensitivity: 50% really halves the height. Clip only last.
  return clamp(height * gate * clamp(sensitivity, 50, 200) / 100.0f, 0, 255);
}

// Visual-only bass taper for the first ERB centers (~67, 122, 188 Hz).
// Raw measured dB, playback EQ, PCM and the remaining bands are untouched.
constexpr float visualCorrectionDb(std::size_t band) {
  return band == 0 ? -6.0f : band == 1 ? -4.0f : band == 2 ? -2.0f : 0.0f;
}

constexpr float bandDisplayLevel(float measuredDb, std::size_t band, uint16_t sensitivity) {
  return displayLevel(measuredDb + visualCorrectionDb(band), sensitivity);
}

} // namespace SpectrumDynamics
