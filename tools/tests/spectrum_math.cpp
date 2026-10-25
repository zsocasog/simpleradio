// Compile-time tests of the production math. No board or audio input needed:
// xtensa-esp-elf-g++ -std=c++17 -fsyntax-only tools/tests/spectrum_math.cpp
// ESP32-audioI2S exports this macro; our public headers must coexist with it.
#define FFT_SIZE 256
#include "../../src/audio/spectrum_math.h"
#include "../../src/audio/spectrum_dynamics.h"
#include "../../src/audio/spectrum_capture.h"
#include "../../src/audio/volume_math.h"

using namespace SpectrumMath;

static_assert(POINT_COUNT == 1024 && BAND_COUNT == 24);
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
static_assert(bandForBin(POINT_COUNT / 2, 44100) == -1);
static_assert(bandForBin(12, 0) == -1);
static_assert(bandForBin(24, 44100) == 11);
static_assert(bandForBin(22, 48000) == 11);
static_assert(bandForBin(12, 96000) == 11);
static_assert(bandForBin(6, 192000) == 11);
static_assert(bandForBin(400, 48000) == 23);
static_assert(bandForBin(400, 96000) == -1);

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
static_assert(binBandWeight(POINT_COUNT / 2, 23, 44100) == 0);
static_assert(binBandWeight(1, BAND_COUNT, 44100) == 0);
static_assert(binBandWeight(12, 11, 0) == 0);
static_assert(binBandWeight(32, 12, 44100) == 1); // 1.38 kHz stays in its band.
static_assert(binBandWeight(32, 11, 44100) == 0);
// At 48 kHz there is no FFT center in band 1. Weight the actual FFT cells,
// rather than leaving that whole log band permanently empty.
static_assert(binBandWeight(3, 1, 48000) > 0 && binBandWeight(3, 2, 48000) > 0);

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

// Band energy is additive, including fractional bass-cell ownership.
static_assert(rmsBandPower(80, 192) == rmsBandPower(4, 192) * 20);
static_assert(rmsBandPower(123, 0) == 0);
static_assert(rmsBandPower(0, 192) == 0);
static_assert(SpectrumDynamics::displayLevel(-120, 200) == 0);
static_assert(SpectrumDynamics::displayLevel(-66, 200) == 0);
static_assert(SpectrumDynamics::displayLevel(-12, 100) > 210);
static_assert(SpectrumDynamics::displayLevel(-30, 100) > 80);
static_assert(SpectrumDynamics::displayLevel(-24, 100) > SpectrumDynamics::displayLevel(-36, 100));
static_assert(SpectrumDynamics::displayLevel(-24, 50) == SpectrumDynamics::displayLevel(-24, 100) * 0.5f);
static_assert(SpectrumDynamics::displayLevel(-24, 200) == SpectrumDynamics::displayLevel(-24, 100) * 2);
static_assert(VolumeMath::gainDb(50, VolumeMath::Curve::Soft) == -31);
static_assert(VolumeMath::gainDb(50, VolumeMath::Curve::Linear) == -30);
static_assert(VolumeMath::gainDb(50, VolumeMath::Curve::Log) == -45);
static_assert(VolumeMath::gainDb(0, VolumeMath::Curve::Soft) == -120);
static_assert(VolumeMath::gainDb(100, VolumeMath::Curve::Soft) == 0);
static_assert(usableFrame(true, 250, 100)); // Brief scheduling gaps retain the envelope.
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

constexpr bool releaseIsNatural(float level) {
  bool intermediate = false;
  for (int frame = 0; frame < 24; ++frame) { // At most ~1 second, no PCM/FFT needed.
    const float next = smoothLevel(level, 0, 42);
    if (next > level || next < 0) return false;
    if (next > 0 && next < level) intermediate = true;
    level = next;
  }
  return intermediate && level == 0;
}
static_assert(releaseIsNatural(255) && releaseIsNatural(100) && releaseIsNatural(10));
static_assert(smoothLevel(0, 0, 42) == 0); // Silence cannot grow an organ-pipe shape.

// X(k)/X(N-k) for known left/right phasors, packed as L + iR.
static_assert(stereoBinPower(0, 0, 0, 0) == 0);
static_assert(stereoBinPower(1, 0, 1, 0) == 0.5f); // left only
static_assert(stereoBinPower(0, 1, 0, 1) == 0.5f); // right only
static_assert(stereoBinPower(1, 1, 1, 1) == 1); // identical L/R
static_assert(stereoBinPower(1, -1, 1, -1) == 1); // opposite phase: NOT silence
static_assert(stereoBinPower(0, 0, 2, 0) == 1); // L=1, R=i

// Exact DFT of a periodic Hann-windowed, bin-centered cosine. The production
// integration must give the same RMS for equal-level bass/mid/treble, rather
// than divide a treble tone by all the unused cells in its wider band.
constexpr float absValue(float value) { return value < 0 ? -value : value; }
constexpr auto hannTone(size_t bin, float amplitude, float rightSign = 1) {
  std::array<float, POINT_COUNT * 2> fft{};
  for (size_t k = bin - 1; k <= bin + 1; ++k) {
    const float value = amplitude * POINT_COUNT * (k == bin ? 0.25f : -0.125f);
    fft[k * 2] = fft[(POINT_COUNT - k) * 2] = value;
    fft[k * 2 + 1] = fft[(POINT_COUNT - k) * 2 + 1] = value * rightSign;
  }
  return fft;
}
constexpr float hannEnergy = POINT_COUNT * 3.0f / 8;
constexpr auto bassFft = hannTone(12, 0.5f);
constexpr auto midFft = hannTone(72, 0.5f);
constexpr auto trebleFft = hannTone(146, 0.5f);
constexpr auto antiphaseFft = hannTone(146, 0.5f, -1);
constexpr auto bass = bandPowers(bassFft.data(), 48000, hannEnergy);
constexpr auto mid = bandPowers(midFft.data(), 48000, hannEnergy);
constexpr auto treble = bandPowers(trebleFft.data(), 48000, hannEnergy);
constexpr auto antiphase = bandPowers(antiphaseFft.data(), 48000, hannEnergy);
constexpr float sumPower(const std::array<float, BAND_COUNT>& powers) {
  float total = 0;
  for (float power : powers) total += power;
  return total;
}
static_assert(absValue(sumPower(bass) - 0.125f) < 0.00001f);
static_assert(absValue(sumPower(mid) - 0.125f) < 0.00001f);
static_assert(absValue(sumPower(treble) - 0.125f) < 0.00001f);
static_assert(absValue(treble[19] - mid[16]) < 0.00001f);
static_assert(bass[8] < mid[16]); // Shared low-resolution bins do not get amplified.
static_assert(bass[8] > mid[16] * 0.70f); // Finite-window leakage, not a huge tilt.
static_assert(absValue(antiphase[19] - treble[19]) < 0.00001f);

constexpr bool dcAndSilenceAreEmpty() {
  std::array<int16_t, POINT_COUNT * 2> samples{};
  std::array<float, POINT_COUNT> window{};
  std::array<float, POINT_COUNT * 2> work{};
  for (size_t i = 0; i < POINT_COUNT; ++i) {
    samples[i * 2] = 12000;
    samples[i * 2 + 1] = -6000;
    window[i] = static_cast<float>(i) / POINT_COUNT;
  }
  prepareFrame(samples.data(), window.data(), work.data());
  for (float value : work) if (value != 0) return false;
  const auto powers = bandPowers(work.data(), 44100, hannEnergy);
  for (float value : powers) if (value != 0) return false;
  return true;
}
static_assert(dcAndSilenceAreEmpty());

static_assert(SpectrumCapture::windowHop(44100) == 1102);
static_assert(SpectrumCapture::windowHop(48000) == 1200);
static_assert(SpectrumCapture::windowHop(8000) == POINT_COUNT);
constexpr bool clockTracksPackets() {
  SpectrumCapture::Clock clock;
  clock.start(0xfffffff0u);
  if (clock.append(4096) != 0 || clock.append(1152) != 4096) return false;
  if (clock.timeAt(4800, 48000) != 84) return false; // millis rollover.
  return !clock.discontinuity(84, 48000) && clock.discontinuity(1000, 48000);
}
static_assert(clockTracksPackets());
