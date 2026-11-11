#include "runtime_probe.h"
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
#include <Arduino.h>
#include <esp_err.h>
#include <esp_timer.h>
#include <esp_heap_caps.h>
#include <esp_debug_helpers.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <string.h>

namespace {
DRAM_ATTR portMUX_TYPE probeMux = portMUX_INITIALIZER_UNLOCKED;
DRAM_ATTR RuntimeProbe::Snapshot probe;
DRAM_ATTR uint32_t lastSentUs = 0, lastFeedUs = 0, lastPumpUs = 0;
DRAM_ATTR uint32_t startedUs = 0, dmaBudgetUs = 0, lastInputUs = 0;
DRAM_ATTR bool feedLate = false;
DRAM_ATTR uint32_t lastDecoderUs = 0;
portMUX_TYPE performanceMux = portMUX_INITIALIZER_UNLOCKED;
RuntimeProbe::Performance performanceCounters{};
// Retained only in diagnostic firmware. A panic otherwise loses the brief
// allocation failure between HTTP samples. No logging, allocation or flash I/O
// in this hook; each CPU has its own bounded record.
struct RetainedFailures { uint32_t magic; RuntimeProbe::AllocationFailures failures; };
RTC_NOINIT_ATTR RetainedFailures retainedFailures;
RuntimeProbe::AllocationFailures previousFailures{};
portMUX_TYPE allocationMux = portMUX_INITIALIZER_UNLOCKED;
constexpr uint32_t allocationMagic = 0x53524631;

void allocationFailed(size_t bytes, uint32_t caps, const char* function) {
  portENTER_CRITICAL(&allocationMux);
  auto& row = retainedFailures.failures.core[xPortGetCoreID()];
  ++row.count; row.bytes = bytes; row.caps = caps;
  row.uptimeMs = static_cast<uint32_t>(esp_timer_get_time() / 1000);
  const char* task = pcTaskGetName(nullptr);
  size_t i = 0;
  for (; task && task[i] && i + 1 < sizeof(row.task); ++i) row.task[i] = task[i];
  row.task[i] = 0;
  i = 0;
  for (; function && function[i] && i + 1 < sizeof(row.function); ++i) row.function[i] = function[i];
  row.function[i] = 0;
  esp_backtrace_frame_t frame{};
  esp_backtrace_get_start(&frame.pc, &frame.sp, &frame.next_pc);
  memset(row.callers, 0, sizeof(row.callers));
  for (i = 0; i < 16; ++i) {
    row.callers[i] = frame.pc;
    if (!frame.next_pc || !esp_backtrace_get_next_frame(&frame)) break;
  }
  portEXIT_CRITICAL(&allocationMux);
}
}

namespace RuntimeProbe {
void begin() {
  const auto reason = esp_reset_reason();
  if (retainedFailures.magic == allocationMagic &&
      (reason == ESP_RST_PANIC || reason == ESP_RST_SW || reason == ESP_RST_TASK_WDT))
    previousFailures = retainedFailures.failures;
  memset(&retainedFailures.failures, 0, sizeof(retainedFailures.failures));
  retainedFailures.magic = allocationMagic;
  heap_caps_register_failed_alloc_callback(allocationFailed);
}
AllocationFailures allocationFailures(bool previousBoot) {
  portENTER_CRITICAL(&allocationMux);
  const auto result = previousBoot ? previousFailures : retainedFailures.failures;
  portEXIT_CRITICAL(&allocationMux);
  return result;
}
void record(Metric metric, uint32_t elapsedUs) {
  portENTER_CRITICAL(&performanceMux);
  auto& timing = performanceCounters.timings[static_cast<size_t>(metric)];
  ++timing.count; timing.lastUs = elapsedUs; timing.totalUs += elapsedUs;
  if (elapsedUs > timing.maxUs) timing.maxUs = elapsedUs;
  portEXIT_CRITICAL(&performanceMux);
}
Performance performance() {
  portENTER_CRITICAL(&performanceMux);
  const auto result = performanceCounters;
  portEXIT_CRITICAL(&performanceMux);
  return result;
}
Span::Span(Metric metric) : metric_(metric), started_(static_cast<uint32_t>(esp_timer_get_time())) {}
Span::~Span() { record(metric_, static_cast<uint32_t>(esp_timer_get_time()) - started_); }

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

void decoder(uint32_t started, uint32_t acquired, uint32_t finished,
             uint32_t available, uint32_t needed, bool hadPending) {
  portENTER_CRITICAL(&probeMux);
  ++probe.decoderCalls;
  const uint32_t gap = lastDecoderUs ? started - lastDecoderUs : 0;
  const uint32_t work = finished - acquired;
  const uint32_t lock = acquired - started;
  if (gap > probe.decoderGapMaxUs) probe.decoderGapMaxUs = gap;
  if (work > probe.decoderWorkMaxUs) probe.decoderWorkMaxUs = work;
  if (lock > probe.decoderLockMaxUs) probe.decoderLockMaxUs = lock;
  if (dmaBudgetUs && gap > dmaBudgetUs + 10000) ++probe.decoderLongGaps;
  if (dmaBudgetUs && work > dmaBudgetUs + 10000) ++probe.decoderSlowCalls;
  if (!hadPending) {
    probe.decoderInputAvailable = available; probe.decoderInputNeeded = needed;
    if (available < needed) ++probe.decoderShortInputs;
  }
  lastDecoderUs = started;
  portEXIT_CRITICAL(&probeMux);
}
}
#endif
