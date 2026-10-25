#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace SpectrumMath {

constexpr size_t POINT_COUNT = 1024;
constexpr size_t BAND_COUNT = 24;
constexpr uint32_t MAX_QUEUE_AGE_MS = 400;
constexpr uint32_t FRAME_HOLD_MS = 180;
constexpr float DB_FLOOR = -60.0f;
constexpr float SILENCE_DB = -120.0f;

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
// at 44.1 kHz one 1024-point FFT bin is still about 43 Hz wide.
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

// One-sided, window-energy-corrected RMS power. A log-band meter displays
// INTEGRATED band energy, not mean spectral density per FFT bin. Dividing by
// the bin count attenuated equal-level treble tones and duplicated narrow bass
// cells when their fractional weight cancelled in numerator and denominator.
constexpr float rmsBandPower(float weightedPower, float windowEnergy) {
  return weightedPower > 0 && windowEnergy > 0
      ? weightedPower * (2.0f / (POINT_COUNT * windowEnergy)) : 0;
}

constexpr bool usableFrame(bool active, uint32_t now, uint32_t capturedMs) {
  return active && now - capturedMs <= FRAME_HOLD_MS;
}

// Fractional 0..255 display envelope. Time-based attack/release avoids losing
// the smoothing state every time heights are rounded to the LCD's few pixels.
constexpr float smoothLevel(float current, float target, uint32_t elapsedMs) {
  if (!elapsedMs) return current;
  if (elapsedMs > 250) elapsedMs = 250;
  const float timeConstantMs = target > current ? 12.0f : 85.0f;
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

// Portable production path, also exercised with deterministic signal tests.
template<class Sample>
constexpr float prepareFrame(const Sample* samples, const float* window, float* work, float fullScale = 32768.0f) {
  float meanLeft = 0, meanRight = 0;
  for (size_t i = 0; i < POINT_COUNT; ++i) {
    meanLeft += static_cast<float>(samples[i * 2]) / fullScale;
    meanRight += static_cast<float>(samples[i * 2 + 1]) / fullScale;
  }
  meanLeft /= POINT_COUNT;
  meanRight /= POINT_COUNT;
  float power = 0;
  for (size_t i = 0; i < POINT_COUNT; ++i) {
    const float left = static_cast<float>(samples[i * 2]) / fullScale - meanLeft;
    const float right = static_cast<float>(samples[i * 2 + 1]) / fullScale - meanRight;
    power += left * left + right * right;
    work[i * 2] = left * window[i];
    work[i * 2 + 1] = right * window[i];
  }
  return power / (POINT_COUNT * 2);
}

constexpr std::array<float, BAND_COUNT> bandPowers(const float* transformed, uint32_t sampleRate, float windowEnergy) {
  std::array<float, BAND_COUNT> powers{};
  for (size_t band = 0; band < BAND_COUNT; ++band) {
    const BinRange bins = binsForBand(band, sampleRate);
    float sum = 0;
    for (size_t bin = bins.first; bin <= bins.last; ++bin) {
      const size_t mirror = POINT_COUNT - bin;
      sum += binBandWeight(bin, band, sampleRate) *
          stereoBinPower(transformed[bin * 2], transformed[bin * 2 + 1],
                         transformed[mirror * 2], transformed[mirror * 2 + 1]);
    }
    powers[band] = rmsBandPower(sum, windowEnergy);
  }
  return powers;
}

static_assert(POINT_COUNT == 1024 && (POINT_COUNT & (POINT_COUNT - 1)) == 0, "FFT must have 1024 points");
static_assert(BAND_COUNT == 24, "Spectrum must have 24 bands");

} // namespace SpectrumMath
