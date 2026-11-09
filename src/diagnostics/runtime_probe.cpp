#include "runtime_probe.h"
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
#include <Arduino.h>
#include <esp_err.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>

namespace {
DRAM_ATTR portMUX_TYPE probeMux = portMUX_INITIALIZER_UNLOCKED;
DRAM_ATTR RuntimeProbe::Snapshot probe;
DRAM_ATTR uint32_t lastSentUs = 0, lastFeedUs = 0, lastPumpUs = 0;
DRAM_ATTR uint32_t startedUs = 0, dmaBudgetUs = 0, lastInputUs = 0;
DRAM_ATTR bool feedLate = false;
}

namespace RuntimeProbe {
void outputStart(uint32_t rate, uint32_t capacityFrames) {
  const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
  const uint32_t budget = rate ? static_cast<uint32_t>(uint64_t(capacityFrames) * 1000000 / rate) : 0;
  portENTER_CRITICAL(&probeMux);
  ++probe.epoch; ++probe.starts;
  probe.sampleRate = rate; probe.dmaFrames = capacityFrames; probe.active = rate != 0;
  lastSentUs = lastFeedUs = 0; startedUs = now; dmaBudgetUs = budget;
  feedLate = false;
  portEXIT_CRITICAL(&probeMux);
}

void outputStop() {
  portENTER_CRITICAL(&probeMux);
  probe.active = false; ++probe.stops;
  lastFeedUs = lastSentUs = 0;
  portEXIT_CRITICAL(&probeMux);
}

void IRAM_ATTR outputSent(size_t frames, uint32_t now) {
  portENTER_CRITICAL_ISR(&probeMux);
  if (probe.active) {
    probe.sentFrames += frames; ++probe.sentBlocks;
    if (lastSentUs && now - lastSentUs > probe.sentGapMaxUs) probe.sentGapMaxUs = now - lastSentUs;
    lastSentUs = now;
    // A feed pause longer than the WHOLE DMA ring is evidence of starvation
    // risk, not a content-aware acoustic test. Ignore startup for two seconds.
    if (lastFeedUs && now - startedUs >= 2000000 && dmaBudgetUs) {
      const uint32_t gap = now - lastFeedUs;
      if (gap > probe.feedGapMaxUs) probe.feedGapMaxUs = gap;
      if (!feedLate && gap > dmaBudgetUs + 10000) {
        ++probe.feedDeadlineMisses; feedLate = true;
      }
    }
  }
  portEXIT_CRITICAL_ISR(&probeMux);
}

void written(size_t requested, size_t accepted, int result, uint32_t elapsedUs) {
  const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
  portENTER_CRITICAL(&probeMux);
  ++probe.writes; probe.acceptedBytes += accepted;
  if (accepted < requested) ++probe.partialWrites;
  if (result == ESP_ERR_TIMEOUT) ++probe.writeTimeouts;
  else if (result != ESP_OK) ++probe.writeErrors;
  if (elapsedUs > probe.writeMaxUs) probe.writeMaxUs = elapsedUs;
  if (accepted && probe.active) {
    if (lastFeedUs && now - startedUs >= 2000000 && now - lastFeedUs > probe.feedGapMaxUs)
      probe.feedGapMaxUs = now - lastFeedUs;
    lastFeedUs = now; feedLate = false;
  }
  portEXIT_CRITICAL(&probeMux);
}

void pump(uint32_t durationUs, uint32_t inputBytes, uint32_t capacity, bool running) {
  const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
  portENTER_CRITICAL(&probeMux);
  ++probe.pumpCalls;
  if (lastPumpUs && now - lastPumpUs > probe.pumpGapMaxUs) probe.pumpGapMaxUs = now - lastPumpUs;
  lastPumpUs = now;
  if (durationUs > probe.pumpWorkMaxUs) probe.pumpWorkMaxUs = durationUs;
  probe.inputBytes = inputBytes; probe.inputCapacity = capacity;
  if (running && now - lastInputUs >= 100000) {
    lastInputUs = now; ++probe.inputSamples;
    if (inputBytes < probe.inputMinBytes) probe.inputMinBytes = inputBytes;
    if (!inputBytes) ++probe.inputEmptySamples;
  }
  portEXIT_CRITICAL(&probeMux);
}

Snapshot snapshot() {
  const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
  portENTER_CRITICAL(&probeMux);
  Snapshot result = probe;
  result.feedAgeUs = lastFeedUs ? now - lastFeedUs : 0;
  result.sentAgeUs = lastSentUs ? now - lastSentUs : 0;
  portEXIT_CRITICAL(&probeMux);
  return result;
}
}
#endif
