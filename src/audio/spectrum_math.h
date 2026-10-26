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

// 26 knots evenly spaced in ERB-rate between 20 Hz and 18 kHz:
// ERB(f) = 21.4 * log10(1 + 0.00437*f). The 24 interior knots are peaks.
// Adjacent linear-Hz triangles overlap with complementary weights. This is
// an ERB-SPACED FFT approximation, not a gammatone/absolute-loudness model.
// Hz positions stay fixed across codecs/rates; only the FFT mapping changes.
constexpr std::array<float, BAND_COUNT + 2> ERB_KNOTS_HZ = {
    20, 66.629250f, 121.996439f, 187.738984f, 265.801141f, 358.491506f,
    468.551283f, 599.235357f, 754.408554f, 938.659932f, 1157.438504f,
    1417.214383f, 1725.670127f, 2091.927943f, 2526.819463f, 3043.206080f,
    3656.359306f, 4384.412408f, 5248.896678f, 6275.378197f, 7494.213916f,
    8941.449434f, 10659.884994f, 12700.341257f, 15123.162256f, 18000};

constexpr float bandCenterHz(size_t band) {
  return band < BAND_COUNT ? ERB_KNOTS_HZ[band + 1] : 0;
}

constexpr float triangleWeight(float hz, size_t band) {
  if (band >= BAND_COUNT || hz <= ERB_KNOTS_HZ[band] || hz >= ERB_KNOTS_HZ[band + 2]) return 0;
  const float center = bandCenterHz(band);
  return hz <= center ? (hz - ERB_KNOTS_HZ[band]) / (center - ERB_KNOTS_HZ[band])
                      : (ERB_KNOTS_HZ[band + 2] - hz) / (ERB_KNOTS_HZ[band + 2] - center);
}

constexpr int bandForFrequency(float hz) {
  int best = -1;
  float strongest = 0;
  for (size_t band = 0; band < BAND_COUNT; ++band) {
    const float weight = triangleWeight(hz, band);
    if (weight > strongest) { strongest = weight; best = static_cast<int>(band); }
  }
  return best;
}

constexpr int bandForBin(size_t bin, uint32_t sampleRate) {
  if (!sampleRate || !bin || bin >= POINT_COUNT / 2) return -1;
  return bandForFrequency(static_cast<float>(bin) * sampleRate / POINT_COUNT);
}

constexpr float bandUpperHz(size_t band, uint32_t sampleRate) {
  if (band >= BAND_COUNT || !sampleRate) return 0;
  const float nyquist = sampleRate * 0.5f;
  return ERB_KNOTS_HZ[band + 2] < nyquist ? ERB_KNOTS_HZ[band + 2] : nyquist;
}

struct BinRange {
  size_t first = 1;
  size_t last = 0;
};

constexpr BinRange binsForBand(size_t band, uint32_t sampleRate) {
  if (band >= BAND_COUNT || !sampleRate || bandUpperHz(band, sampleRate) <= ERB_KNOTS_HZ[band]) return {};
  const float binWidth = static_cast<float>(sampleRate) / POINT_COUNT;
  const size_t first = static_cast<size_t>(ERB_KNOTS_HZ[band] / binWidth + 0.5f);
  const size_t last = static_cast<size_t>(bandUpperHz(band, sampleRate) / binWidth + 0.5f);
  return {first > 0 ? first : 1, last < POINT_COUNT / 2 ? last : POINT_COUNT / 2 - 1};
}

// Exact triangle area inside an FFT cell, divided by cell width. Integrating
// instead of sampling the center also handles low-rate/high-rate partial bins.
// Hann leakage still limits resolution: ERB spacing cannot invent extra bass bins.
constexpr float binBandWeight(size_t bin, size_t band, uint32_t sampleRate) {
  if (!sampleRate || !bin || bin >= POINT_COUNT / 2 || band >= BAND_COUNT) return 0;
  const float binWidth = static_cast<float>(sampleRate) / POINT_COUNT;
  const float cellLow = (static_cast<float>(bin) - 0.5f) * binWidth;
  const float cellHigh = (static_cast<float>(bin) + 0.5f) * binWidth;
  const float lower = ERB_KNOTS_HZ[band];
  const float center = bandCenterHz(band);
  const float end = ERB_KNOTS_HZ[band + 2];
  const float upper = bandUpperHz(band, sampleRate);
  const float low = cellLow > lower ? cellLow : lower;
  const float high = cellHigh < upper ? cellHigh : upper;
  if (high <= low) return 0;
  float area = 0;
  const float riseEnd = high < center ? high : center;
  if (riseEnd > low) area += (riseEnd - low) * ((low - lower) + (riseEnd - lower)) / (2 * (center - lower));
  const float fallStart = low > center ? low : center;
  if (high > fallStart) area += (high - fallStart) * ((end - fallStart) + (end - high)) / (2 * (end - center));
  const float weight = area / binWidth;
  return weight < 1 ? weight : 1;
}

struct BandPlan {
  uint32_t sampleRate = 0;
  std::array<BinRange, BAND_COUNT> ranges{};
  std::array<std::array<float, POINT_COUNT / 2>, BAND_COUNT> weights{};

  void configure(uint32_t rate) {
    if (sampleRate == rate) return;
    sampleRate = rate;
    for (size_t band = 0; band < BAND_COUNT; ++band) {
      ranges[band] = binsForBand(band, rate);
      weights[band].fill(0);
      for (size_t bin = ranges[band].first; bin <= ranges[band].last; ++bin) {
        weights[band][bin] = binBandWeight(bin, band, rate);
      }
    }
  }
};

// One-sided, window-energy-corrected weighted RMS power. Complementary interior
// triangles share energy without duplicating it. The first/last slopes taper
// the 20 Hz / 18 kHz limits. No division by bin count or per-band auto gain.
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
  const float timeConstantMs = target > current ? 12.0f : 50.0f;
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

// Production fast path: the plan lives in PSRAM and is rebuilt only when the
// sample rate changes. No ERB conversion or triangle integration per FFT frame.
inline std::array<float, BAND_COUNT> cachedBandPowers(const float* transformed, const BandPlan& plan, float windowEnergy) {
  std::array<float, BAND_COUNT> powers{};
  for (size_t band = 0; band < BAND_COUNT; ++band) {
    const BinRange bins = plan.ranges[band];
    float sum = 0;
    for (size_t bin = bins.first; bin <= bins.last; ++bin) {
      const size_t mirror = POINT_COUNT - bin;
      sum += plan.weights[band][bin] * stereoBinPower(transformed[bin * 2], transformed[bin * 2 + 1],
                                                     transformed[mirror * 2], transformed[mirror * 2 + 1]);
    }
    powers[band] = rmsBandPower(sum, windowEnergy);
  }
  return powers;
}

static_assert(POINT_COUNT == 1024 && (POINT_COUNT & (POINT_COUNT - 1)) == 0, "FFT must have 1024 points");
static_assert(BAND_COUNT == 24, "Spectrum must have 24 bands");

} // namespace SpectrumMath
