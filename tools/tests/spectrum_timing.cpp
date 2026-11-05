// Compile the production counters, including unsigned clock rollovers.
#include "../../src/audio/spectrum_timing.h"

using SpectrumTiming::Interval;
static_assert(sizeof(Interval) <= 128); // No new large internal RAM reservation.
static_assert(SpectrumTiming::dmaCapacityMs(8192, 44100) == 185);
static_assert(SpectrumTiming::dmaCapacityMs(8192, 48000) == 170);
static_assert(SpectrumTiming::dmaCapacityMs(8192, 0) == 0);

constexpr bool analysisStages() {
  Interval t;
  t.recordAnalysis(1000, 2000, 2300, 2800, 3000);
  t.recordAnalysis(4000, 4500, 4600, 4900, 5000);
  return t.analyses == 2 && t.workUs == 1500 && t.readyWaitMaxUs == 1000 &&
      t.prepareMaxUs == 300 && t.fftMaxUs == 500 && t.bandsMaxUs == 200 &&
      t.wallPercent(10) == 15 && t.wallPercent(0) == 0;
}
static_assert(analysisStages());

constexpr bool displayFreshness() {
  Interval t;
  t.recordRender(1000, 2000, 100, true, 90, 80, 85);
  t.recordRender(34000, 37000, 133, true, 90, 80, 85); // Reused measurement.
  t.recordRender(67000, 69000, 166, false, 10, 1, 2); // Stale: draw counted, latency ignored.
  t.recordRender(100000, 102000, 199, true, 190, 169, 175);
  return t.renders == 4 && t.newSamples == 2 && t.averageDrawUs() == 2000 &&
      t.drawMaxUs == 3000 && t.gapMaxUs == 33000 && t.averageReadyToLcdMs() == 25 &&
      t.readyToLcdMaxMs == 30 && t.resultToLcdMaxMs == 24 && t.dueLateMaxMs == 10;
}
static_assert(displayFreshness());

constexpr bool clockRollover() {
  Interval t;
  t.recordAnalysis(0xfffffff0u, 0xfffffff8u, 0x8u, 0x18u, 0x28u);
  if (t.workUs != 48 || t.readyWaitMaxUs != 8 || t.fftMaxUs != 16) return false;
  t.recordRender(0xfffffff0u, 0x10u, 0x10u, true, 0xfffffff0u, 0xffffffe0u, 0);
  t.recordRender(0x20u, 0x40u, 0x20u, true, 0, 0x10u, 0x18u);
  return t.newSamples == 2 && t.averageDrawUs() == 32 && t.gapMaxUs == 48 &&
      t.readyToLcdMaxMs == 48 && t.dueLateMaxMs == 32;
}
static_assert(clockRollover());

constexpr bool resetAndLongPause() {
  Interval t;
  if (t.averageDrawUs() || t.averageReadyToLcdMs() || t.wallPercent(100)) return false;
  t.recordRender(100, 110, 100, true, 90, 80, 85);
  t = {}; // Visibility/sample-rate changes clear prior gaps and sample keys.
  t.recordRender(100000000, 100000005, 100000, true, 90, 99980, 99985);
  return t.renders == 1 && t.newSamples == 1 && t.gapMaxUs == 0 &&
      t.averageReadyToLcdMs() == 20;
}
static_assert(resetAndLongPause());

constexpr bool reportBoundaryPreservesContinuity() {
  Interval t;
  t.recordRender(1000, 2000, 100, true, 90, 80, 85);
  t.nextInterval();
  t.recordRender(101000, 102000, 200, true, 90, 80, 85);
  if (t.newSamples != 0 || t.gapMaxUs != 100000 || t.renders != 1) return false;
  t.recordRender(134000, 136000, 233, true, 220, 210, 215);
  return t.newSamples == 1 && t.averageReadyToLcdMs() == 23;
}
static_assert(reportBoundaryPreservesContinuity());
