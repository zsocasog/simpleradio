#pragma once
#include <stdint.h>
#include <stddef.h>
#include <esp_attr.h>

// Explicitly enabled only in a measurement build. No new task, log stream,
// PCM scan, heap allocation or flash writes on the observed audio paths.
#ifndef SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
#define SIMPLE_RADIO_RUNTIME_DIAGNOSTICS 0
#endif

namespace RuntimeProbe {
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
struct Snapshot {
  uint32_t epoch = 0, sampleRate = 0, dmaFrames = 0;
  bool active = false;
  uint32_t starts = 0, stops = 0;
  uint64_t sentFrames = 0, acceptedBytes = 0;
  uint32_t sentBlocks = 0, writes = 0, partialWrites = 0, writeTimeouts = 0, writeErrors = 0;
  uint32_t sentGapMaxUs = 0, feedGapMaxUs = 0, writeMaxUs = 0;
  uint32_t feedDeadlineMisses = 0, feedAgeUs = 0, sentAgeUs = 0;
  uint32_t pumpCalls = 0, pumpGapMaxUs = 0, pumpWorkMaxUs = 0;
  uint32_t inputBytes = 0, inputCapacity = 0, inputMinBytes = UINT32_MAX;
  uint32_t inputSamples = 0, inputEmptySamples = 0;
  uint32_t decoderCalls = 0, decoderGapMaxUs = 0, decoderWorkMaxUs = 0, decoderLockMaxUs = 0;
  uint32_t decoderLongGaps = 0, decoderSlowCalls = 0, decoderShortInputs = 0;
  uint32_t decoderInputAvailable = 0, decoderInputNeeded = 0;
};
void outputStart(uint32_t rate, uint32_t capacityFrames);
void outputStop();
void IRAM_ATTR outputSent(size_t frames, uint32_t nowUs);
void written(size_t requested, size_t accepted, int result, uint32_t elapsedUs);
void pump(uint32_t durationUs, uint32_t inputBytes, uint32_t inputCapacity, bool running);
void decoder(uint32_t started, uint32_t acquired, uint32_t finished,
             uint32_t available, uint32_t needed, bool hadPending);
Snapshot snapshot();
#endif
}
