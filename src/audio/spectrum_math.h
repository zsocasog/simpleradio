#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace SpectrumMath {

constexpr size_t POINT_COUNT = 512;
constexpr size_t BAND_COUNT = 24;
constexpr uint32_t MAX_QUEUE_AGE_MS = 400;
constexpr uint32_t FRAME_HOLD_MS = 600;
constexpr float DB_FLOOR = -60.0f;
constexpr float DB_CEILING = -12.0f;

constexpr bool beforeDeadline(uint32_t now, uint32_t deadline) {
  return deadline != 0 && static_cast<int32_t>(now - deadline) < 0;
}
// Third-octave (cbrt(2) ratio) boundaries in Hz, up to 20.48 kHz. The first
// bucket also collects the unresolved lower bass; DC is always excluded.
// Keep this frequency axis stable and recalculate its FFT-bin mapping for the
// actual sample rate. Bands above Nyquist are empty, the crossing band is clipped.
constexpr std::array<float, BAND_COUNT + 1> BAND_EDGES_HZ = {
    0, 100.793684f, 126.992084f, 160, 201.587368f, 253.984168f, 320,
    403.174736f, 507.968337f, 640, 806.349472f, 1015.936673f, 1280,
    1612.698944f, 2031.873347f, 2560, 3225.397888f, 4063.746693f, 5120,
    6450.795776f, 8127.493386f, 10240, 12901.59155f, 16254.98677f, 20480};

constexpr int bandForFrequency(float hz) {
  if (hz < 0 || hz >= BAND_EDGES_HZ[BAND_COUNT]) return -1;
  for (size_t band = 0; band < BAND_COUNT; ++band) {
    if (hz < BAND_EDGES_HZ[band + 1]) return static_cast<int>(band);
  }
  return -1;
}

constexpr int bandForBin(size_t bin, uint32_t sampleRate) {
  if (!sampleRate || !bin || bin >= POINT_COUNT / 2) return -1;
  return bandForFrequency(static_cast<float>(bin) * sampleRate / POINT_COUNT);
}

constexpr float bandUpperHz(size_t band, uint32_t sampleRate) {
  if (band >= BAND_COUNT || !sampleRate) return 0;
  const float nyquist = sampleRate * 0.5f;
  return BAND_EDGES_HZ[band + 1] < nyquist ? BAND_EDGES_HZ[band + 1] : nyquist;
}

struct BinRange {
  size_t first = 1;
  size_t last = 0;
};

constexpr BinRange binsForBand(size_t band, uint32_t sampleRate) {
  if (band >= BAND_COUNT || !sampleRate || bandUpperHz(band, sampleRate) <= BAND_EDGES_HZ[band]) return {};
  const float binWidth = static_cast<float>(sampleRate) / POINT_COUNT;
  const size_t first = static_cast<size_t>(BAND_EDGES_HZ[band] / binWidth + 0.5f);
  const size_t last = static_cast<size_t>(bandUpperHz(band, sampleRate) / binWidth + 0.5f);
  return {first > 0 ? first : 1, last < POINT_COUNT / 2 ? last : POINT_COUNT / 2 - 1};
}

// Integrate each FFT cell's overlap with the log band instead of assigning
// only its center. This avoids artificial empty bass bars when a narrow band
// falls between FFT centers. It does NOT invent extra low-frequency resolution:
// at 44.1 kHz one 512-point FFT bin is still about 86 Hz wide.
constexpr float binBandWeight(size_t bin, size_t band, uint32_t sampleRate) {
  if (!sampleRate || !bin || bin >= POINT_COUNT / 2 || band >= BAND_COUNT) return 0;
  const float binWidth = static_cast<float>(sampleRate) / POINT_COUNT;
  const float cellLow = (static_cast<float>(bin) - 0.5f) * binWidth;
  const float cellHigh = (static_cast<float>(bin) + 0.5f) * binWidth;
  const float low = cellLow > BAND_EDGES_HZ[band] ? cellLow : BAND_EDGES_HZ[band];
  const float upper = bandUpperHz(band, sampleRate);
  const float high = cellHigh < upper ? cellHigh : upper;
  return high > low ? (high - low) / binWidth : 0;
}

// Average spectral power per FFT cell. Using the SUM instead would boost wide
// high-frequency bands just because they contain more bins, flattening music.
constexpr float meanBandPower(float weightedPower, float weightSum) {
  return weightSum > 0 && weightedPower > 0 ? weightedPower / weightSum : 0;
}

constexpr float levelFromDb(float db) {
  if (db <= DB_FLOOR) return 0;
  if (db >= DB_CEILING) return 255;
  return (db - DB_FLOOR) * 255.0f / (DB_CEILING - DB_FLOOR);
}

// Sensitivity is an amplitude gain in dB, NOT a multiplier of already-logarithmic
// heights. The latter clipped most bars together at 150-200% sensitivity.
constexpr float levelWithGain(float level, float gainDb) {
  if (level <= 0) return 0; // Never turn digital silence into a visible baseline.
  const float adjusted = level + gainDb * 255.0f / (DB_CEILING - DB_FLOOR);
  return adjusted <= 0 ? 0 : (adjusted >= 255 ? 255 : adjusted);
}

constexpr bool usableFrame(bool active, uint32_t now, uint32_t capturedMs) {
  return active && now - capturedMs <= FRAME_HOLD_MS;
}

// Fractional 0..255 display envelope. Time-based attack/release avoids losing
// the smoothing state every time heights are rounded to the LCD's few pixels.
constexpr float smoothLevel(float current, float target, uint32_t elapsedMs) {
  if (!elapsedMs) return current;
  if (elapsedMs > 250) elapsedMs = 250;
  const float timeConstantMs = target > current ? 35.0f : 170.0f;
  const float blend = elapsedMs / (timeConstantMs + elapsedMs);
  const float next = current + (target - current) * blend;
  return target == 0 && next < 0.5f ? 0 : next;
}

// Pack L into the real input and R into the imaginary input of ONE FFT.
// Recover both real spectra from X(k) and conjugate X(N-k), then average their
// powers. Unlike (L+R)/2 this preserves opposite-phase stereo material.
constexpr float stereoBinPower(float real, float imag, float mirrorReal, float mirrorImag) {
  const float leftReal = (real + mirrorReal) * 0.5f;
  const float leftImag = (imag - mirrorImag) * 0.5f;
  const float rightReal = (imag + mirrorImag) * 0.5f;
  const float rightImag = (mirrorReal - real) * 0.5f;
  return (leftReal * leftReal + leftImag * leftImag +
          rightReal * rightReal + rightImag * rightImag) * 0.5f;
}

static_assert(POINT_COUNT == 512 && (POINT_COUNT & (POINT_COUNT - 1)) == 0, "FFT must have 512 points");
static_assert(BAND_COUNT == 24, "Spectrum must have 24 bands");

} // namespace SpectrumMath
