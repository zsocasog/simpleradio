#pragma once

#include <cstdint>

// Passive timing counters only. No clocks, allocation, logging or playback
// control here; callers supply timestamps while holding the analyzer lock.
namespace SpectrumTiming {
struct Interval {
  uint32_t analyses = 0;
  uint64_t workUs = 0;
  uint32_t readyWaitMaxUs = 0;
  uint32_t prepareMaxUs = 0;
  uint32_t fftMaxUs = 0;
  uint32_t bandsMaxUs = 0;
  uint32_t renders = 0;
  uint64_t drawUs = 0;
  uint32_t drawMaxUs = 0;
  uint32_t gapMaxUs = 0;
  uint32_t newSamples = 0;
  uint64_t readyToLcdMs = 0;
  uint32_t readyToLcdMaxMs = 0;
  uint32_t resultToLcdMaxMs = 0;
  uint32_t dueLateMaxMs = 0;
  uint32_t lastRenderUs = 0;
  uint32_t lastSampleMs = 0;
  bool hasRender = false;
  bool hasSample = false;

  static constexpr uint32_t maximum(uint32_t a, uint32_t b) { return a > b ? a : b; }

  constexpr void recordAnalysis(uint32_t readyUs, uint32_t startedUs,
                                uint32_t preparedUs, uint32_t transformedUs,
                                uint32_t finishedUs) {
    ++analyses;
    workUs += static_cast<uint32_t>(finishedUs - startedUs);
    readyWaitMaxUs = maximum(readyWaitMaxUs, startedUs - readyUs);
    prepareMaxUs = maximum(prepareMaxUs, preparedUs - startedUs);
    fftMaxUs = maximum(fftMaxUs, transformedUs - preparedUs);
    bandsMaxUs = maximum(bandsMaxUs, finishedUs - transformedUs);
  }

  constexpr void recordRender(uint32_t startedUs, uint32_t finishedUs, uint32_t nowMs,
                              bool fresh, uint32_t sampleMs, uint32_t readyMs,
                              uint32_t analyzedMs) {
    ++renders;
    const uint32_t durationUs = finishedUs - startedUs;
    drawUs += durationUs;
    drawMaxUs = maximum(drawMaxUs, durationUs);
    if (hasRender) gapMaxUs = maximum(gapMaxUs, startedUs - lastRenderUs);
    lastRenderUs = startedUs;
    hasRender = true;
    // Repeated LCD frames must not make a single measurement look like many
    // fresh ones, nor inflate its ready/result-to-display latency.
    if (!fresh || (hasSample && sampleMs == lastSampleMs)) return;
    hasSample = true;
    lastSampleMs = sampleMs;
    ++newSamples;
    const uint32_t readyAgeMs = nowMs - readyMs;
    readyToLcdMs += readyAgeMs;
    readyToLcdMaxMs = maximum(readyToLcdMaxMs, readyAgeMs);
    resultToLcdMaxMs = maximum(resultToLcdMaxMs, nowMs - analyzedMs);
    // Lateness relative to the measured sent-DMA window midpoint. This is
    // analyzer/display latency, not a measurement of the acoustic output.
    const int32_t dueAgeMs = static_cast<int32_t>(nowMs - sampleMs);
    if (dueAgeMs > 0) dueLateMaxMs = maximum(dueLateMaxMs, dueAgeMs);
  }

  constexpr uint32_t wallPercent(uint32_t intervalMs) const {
    return intervalMs ? static_cast<uint32_t>(workUs * 100 / (static_cast<uint64_t>(intervalMs) * 1000)) : 0;
  }
  constexpr uint32_t averageDrawUs() const { return renders ? static_cast<uint32_t>(drawUs / renders) : 0; }
  constexpr uint32_t averageReadyToLcdMs() const { return newSamples ? static_cast<uint32_t>(readyToLcdMs / newSamples) : 0; }

  constexpr void nextInterval() {
    const uint32_t render = lastRenderUs, sample = lastSampleMs;
    const bool rendered = hasRender, sampled = hasSample;
    *this = {};
    // Report boundaries are not visibility changes. Retain continuity so a
    // stall across two reports is visible and a reused sample is not "new".
    lastRenderUs = render;
    lastSampleMs = sample;
    hasRender = rendered;
    hasSample = sampled;
  }
};

constexpr uint32_t dmaCapacityMs(uint32_t frames, uint32_t sampleRate) {
  return sampleRate ? static_cast<uint32_t>(static_cast<uint64_t>(frames) * 1000 / sampleRate) : 0;
}
} // namespace SpectrumTiming
