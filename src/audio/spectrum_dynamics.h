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

// Visual-only taper along the ERB axis, reaching zero at bar 8 (~754 Hz).
// V3 keeps the first three corrections near -8/-6/-4 dB, then eases out
// quadratically instead of jumping 4 dB from bar 3 to bar 4. No temporal
// filtering or inter-band averaging: each bar still follows its own energy.
constexpr float visualCorrectionDb(std::size_t band) {
  if (band >= 7) return 0;
  const float remaining = 1.0f - static_cast<float>(band) / 7.0f;
  return -8.0f * remaining * remaining;
}

constexpr float bandDisplayLevel(float measuredDb, std::size_t band, uint16_t sensitivity) {
  return displayLevel(measuredDb + visualCorrectionDb(band), sensitivity);
}

// Display-only rhythm contrast, identical for all ERB bands. A constant level
// retains 72% of its former height, leaving space for a bounded onset accent.
// Sensitivity is applied AFTER detection so dragging it cannot invent a beat.
constexpr float steadyLevel(float level) { return level * 0.72f; }

constexpr float accentDecayFactor(uint32_t elapsedMs) {
  if (elapsedMs > 250) elapsedMs = 250;
  const float x = elapsedMs / (35.0f * 16.0f);
  float decay = 1.0f - x * (1.0f - x * (0.5f - x * (1.0f / 6.0f - x / 24.0f)));
  for (int i = 0; i < 4; ++i) decay *= decay;
  return decay;
}

constexpr float smallMotionDecayFactor(uint32_t elapsedMs) {
  if (elapsedMs > 250) elapsedMs = 250;
  const float x = elapsedMs / (40.0f * 16.0f);
  float decay = 1.0f - x * (1.0f - x * (0.5f - x * (1.0f / 6.0f - x / 24.0f)));
  for (int i = 0; i < 4; ++i) decay *= decay;
  return decay;
}

// Condition tiny changes BEFORE they can create a rhythm accent. At up to
// 4/255 the time constant is 40ms; through 4..8/255 the lag continuously
// disappears. Changes of at least 8/255 pass immediately in either direction.
// There is no dead zone: a sustained small change still reaches its target.
constexpr float dampSmallMotion(float current, float target, float decay) {
  const float delta = target - current;
  const float magnitude = delta < 0 ? -delta : delta;
  const float pass = clamp((magnitude - 4.0f) / 4.0f, 0, 1);
  return target - clamp(delta, -4, 4) * decay * (1.0f - pass);
}

struct RhythmBand {
  float previousLevel = 0;
  float accent = 0;

  constexpr void update(float level, bool newMeasurement, bool initialize, float decay, float motionDecay) {
    level = level > 0 ? clamp(level, 0, 255) : 0;
    accent *= decay;
    if (accent < 0.05f) accent = 0;
    if (initialize) {
      previousLevel = level;
      accent = 0; // Opening a screen/starting a new generation is not a beat.
      return;
    }
    if (!newMeasurement) return; // A repeated LCD frame only releases the accent.
    level = dampSmallMotion(previousLevel, level, motionDecay);
    // Ignore sub-pixel fluctuations in the detector, never gate the steady
    // signal itself. Even a rise below this allowance remains in steadyLevel.
    const float rise = level - previousLevel - 2.0f;
    const float limit = clamp(level * 0.8f, 0, 64);
    const float excitation = clamp(rise * 2.5f, 0, limit);
    // Add rather than replace: a smaller hit can still affect an earlier tail.
    accent = clamp(accent + excitation, 0, 64);
    previousLevel = level;
  }
};

constexpr float rhythmicDisplayLevel(float steady, float accent, uint16_t sensitivity) {
  return clamp((steady + accent) * clamp(sensitivity, 50, 200) / 100.0f, 0, 255);
}

// One envelope for the ENTIRE visible bar, after the steady/accent sum.
// Every change is smoothed, including large accents. There is no amplitude
// bypass and no queued frame. The 25ms attack rounds spikes; the 95ms release
// prevents the entire height from collapsing between adjacent LCD frames.
// This deliberately trades some very fast/quiet peak contrast for calm motion.
constexpr float smoothRhythmLevel(float current, float target, uint32_t elapsedMs) {
  current = current > 0 ? clamp(current, 0, 255) : 0;
  target = target > 0 ? clamp(target, 0, 255) : 0;
  if (elapsedMs > 100) elapsedMs = 100;
  const float timeConstant = target > current ? 25.0f : 95.0f;
  const float x = elapsedMs / (timeConstant * 16.0f);
  float decay = 1.0f - x * (1.0f - x * (0.5f - x * (1.0f / 6.0f - x / 24.0f)));
  for (int i = 0; i < 4; ++i) decay *= decay;
  const float next = target + (current - target) * decay;
  return next < 0.05f ? 0 : next;
}

} // namespace SpectrumDynamics
