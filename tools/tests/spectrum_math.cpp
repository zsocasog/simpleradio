// Compile-time tests of the production math. No board or audio input needed:
// xtensa-esp-elf-g++ -std=c++17 -fsyntax-only tools/tests/spectrum_math.cpp
// ESP32-audioI2S exports this macro; our public headers must coexist with it.
#define FFT_SIZE 256
#include "../../src/audio/spectrum_math.h"

using namespace SpectrumMath;

static_assert(POINT_COUNT == 512 && BAND_COUNT == 24);
static_assert(!beforeDeadline(0x90000000u, 0));
static_assert(beforeDeadline(100, 150) && !beforeDeadline(150, 150));
static_assert(beforeDeadline(0xfffffff0u, 0x10u));
static_assert(!beforeDeadline(0x20u, 0x10u));
static_assert(bandForFrequency(-1) == -1);
static_assert(bandForFrequency(0) == 0);
static_assert(bandForFrequency(100) == 0);
static_assert(bandForFrequency(126) == 1);
static_assert(bandForFrequency(160) == 3);
static_assert(bandForFrequency(1000) == 10);
static_assert(bandForFrequency(20479) == 23);
static_assert(bandForFrequency(20480) == -1);
static_assert(bandForBin(0, 44100) == -1); // DC must not become bass.
static_assert(bandForBin(256, 44100) == -1);
static_assert(bandForBin(12, 0) == -1);
static_assert(bandForBin(12, 44100) == 11);
static_assert(bandForBin(11, 48000) == 11);
static_assert(bandForBin(6, 96000) == 11);
static_assert(bandForBin(3, 192000) == 11);
static_assert(bandForBin(200, 48000) == 23);
static_assert(bandForBin(200, 96000) == -1);

constexpr bool orderedBands(uint32_t sampleRate) {
  int previous = -1;
  for (size_t bin = 1; bin < POINT_COUNT / 2; ++bin) {
    const int band = bandForBin(bin, sampleRate);
    if (band < 0) continue;
    if (band < previous || band >= static_cast<int>(BAND_COUNT)) return false;
    previous = band;
  }
  return true;
}
static_assert(orderedBands(8000) && orderedBands(22050));
static_assert(orderedBands(44100) && orderedBands(48000));
static_assert(orderedBands(96000) && orderedBands(192000));

constexpr bool thirdOctaves() {
  // The lowest bucket extends to zero to retain unresolved bass; every
  // positive boundary is a cbrt(2) multiple of the previous one.
  for (size_t band = 1; band < BAND_COUNT; ++band) {
    const float ratio = BAND_EDGES_HZ[band + 1] / BAND_EDGES_HZ[band];
    if (ratio < 1.25990f || ratio > 1.25994f) return false;
  }
  return true;
}
static_assert(thirdOctaves());
static_assert(bandUpperHz(16, 8000) == 4000); // Clip the crossing band at Nyquist.
static_assert(binsForBand(17, 8000).first > binsForBand(17, 8000).last);
static_assert(binsForBand(0, 0).first > binsForBand(0, 0).last);
static_assert(binBandWeight(0, 0, 44100) == 0); // No DC leakage into the bass bucket.
static_assert(binBandWeight(256, 23, 44100) == 0);
static_assert(binBandWeight(1, BAND_COUNT, 44100) == 0);
static_assert(binBandWeight(12, 11, 0) == 0);
static_assert(binBandWeight(16, 12, 44100) == 1); // 1.38 kHz stays in its band.
static_assert(binBandWeight(16, 11, 44100) == 0);
// At 48 kHz there is no FFT center in band 1. Weight the actual FFT cells,
// rather than leaving that whole log band permanently empty.
static_assert(binBandWeight(1, 1, 48000) > 0 && binBandWeight(1, 2, 48000) > 0);

constexpr bool validWeightsAndRanges(uint32_t sampleRate) {
  const float binWidth = static_cast<float>(sampleRate) / POINT_COUNT;
  for (size_t bin = 1; bin < POINT_COUNT / 2; ++bin) {
    float sum = 0;
    for (size_t band = 0; band < BAND_COUNT; ++band) {
      const float weight = binBandWeight(bin, band, sampleRate);
      const BinRange range = binsForBand(band, sampleRate);
      if (weight < 0 || weight > 1.00001f) return false;
      if (weight > 0 && (bin < range.first || bin > range.last)) return false;
      sum += weight;
    }
    // Integration must conserve a cell's power, except the portion beyond
    // our 20.48 kHz ceiling. Adjacent bass bars may share but never duplicate it.
    const float low = (bin - 0.5f) * binWidth;
    const float high = (bin + 0.5f) * binWidth;
    const float expected = high <= BAND_EDGES_HZ[BAND_COUNT] ? 1.0f :
        (low >= BAND_EDGES_HZ[BAND_COUNT] ? 0.0f : (BAND_EDGES_HZ[BAND_COUNT] - low) / binWidth);
    if (sum < expected - 0.0001f || sum > expected + 0.0001f) return false;
  }
  return true;
}
static_assert(validWeightsAndRanges(8000));
static_assert(validWeightsAndRanges(22050));
static_assert(validWeightsAndRanges(44100));
static_assert(validWeightsAndRanges(48000));
static_assert(validWeightsAndRanges(96000));
static_assert(validWeightsAndRanges(192000));

// Equal spectral density must NOT get taller just because a high band is wider.
static_assert(meanBandPower(4, 1) == meanBandPower(80, 20));
static_assert(meanBandPower(0.8f, 0.2f) == 4);
static_assert(meanBandPower(123, 0) == 0);
static_assert(meanBandPower(0, 20) == 0);
static_assert(levelFromDb(DB_FLOOR) == 0 && levelFromDb(DB_CEILING) == 255);
static_assert(levelFromDb(-36) > 127 && levelFromDb(-36) < 128);
static_assert(levelFromDb(-24) > levelFromDb(-42));
static_assert(levelWithGain(0, 6) == 0);
static_assert(levelWithGain(255, 6) == 255);
static_assert(levelWithGain(16, -6) == 0);
static_assert(levelWithGain(100, 6) - levelWithGain(60, 6) == 40); // Contrast survives gain.
static_assert(usableFrame(true, 450, 100)); // A brief 350ms scheduling gap is not silence.
static_assert(usableFrame(true, 100 + FRAME_HOLD_MS, 100));
static_assert(!usableFrame(true, 101 + FRAME_HOLD_MS, 100));
static_assert(!usableFrame(false, 150, 100));
static_assert(usableFrame(true, 0x20u, 0xfffffff0u)); // millis() rollover.

static_assert(smoothLevel(100, 200, 0) == 100);
static_assert(smoothLevel(0, 255, 42) > 0 && smoothLevel(0, 255, 42) < 255);
static_assert(smoothLevel(255, 0, 42) > 0 && smoothLevel(255, 0, 42) < 255);
static_assert(smoothLevel(0, 255, 42) > 255 - smoothLevel(255, 0, 42)); // Faster attack.
static_assert(smoothLevel(0, 255, 84) > smoothLevel(0, 255, 42));
static_assert(smoothLevel(0.25f, 0, 42) == 0); // Eventually settle at silence.
static_assert(smoothLevel(123, 123, 42) == 123);

// X(k)/X(N-k) for known left/right phasors, packed as L + iR.
static_assert(stereoBinPower(0, 0, 0, 0) == 0);
static_assert(stereoBinPower(1, 0, 1, 0) == 0.5f); // left only
static_assert(stereoBinPower(0, 1, 0, 1) == 0.5f); // right only
static_assert(stereoBinPower(1, 1, 1, 1) == 1); // identical L/R
static_assert(stereoBinPower(1, -1, 1, -1) == 1); // opposite phase: NOT silence
static_assert(stereoBinPower(0, 0, 2, 0) == 1); // L=1, R=i
