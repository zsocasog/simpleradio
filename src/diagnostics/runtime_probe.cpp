#include "runtime_probe.h"
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
#include <Arduino.h>
#include <esp_err.h>
#include <esp_timer.h>
#include <esp_heap_caps.h>
#include <esp_debug_helpers.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <string.h>

namespace {
DRAM_ATTR portMUX_TYPE probeMux = portMUX_INITIALIZER_UNLOCKED;
DRAM_ATTR RuntimeProbe::Snapshot probe;
DRAM_ATTR uint32_t lastSentUs = 0, lastFeedUs = 0, lastPumpUs = 0;
DRAM_ATTR uint32_t startedUs = 0, dmaBudgetUs = 0, lastInputUs = 0;
DRAM_ATTR bool feedLate = false;
DRAM_ATTR uint32_t zeroRunFrames = 0;
DRAM_ATTR uint32_t lastDecoderUs = 0;
DRAM_ATTR uint16_t activityCounts[static_cast<size_t>(RuntimeProbe::Activity::Count)]{};
DRAM_ATTR uint32_t activityMask = 0, feedEventNumber = 0;
DRAM_ATTR RuntimeProbe::FeedEvents feedEventRows{};
DRAM_ATTR RuntimeProbe::ZeroEvents zeroEventRows{};
DRAM_ATTR uint32_t zeroEventNumber = 0, pumpStageValue = 0, pumpStageAtUs = 0;
RuntimeProbe::UploadTraces uploadRows{};
uint32_t uploadNumber = 0;
portMUX_TYPE performanceMux = portMUX_INITIALIZER_UNLOCKED;
RuntimeProbe::Performance performanceCounters{};
// Retained only in diagnostic firmware. A panic otherwise loses the brief
// allocation failure between HTTP samples. No logging, allocation or flash I/O
// in this hook; each CPU has its own bounded record.
struct RetainedFailures { uint32_t magic; RuntimeProbe::AllocationFailures failures; };
RTC_NOINIT_ATTR RetainedFailures retainedFailures;
struct RetainedAbort { uint32_t magic; RuntimeProbe::AbortTrace trace; };
RTC_NOINIT_ATTR RetainedAbort retainedAbort;
RuntimeProbe::AbortTrace previousAbortRecord{};
constexpr uint32_t abortMagic = 0x53524131;
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
// Diagnostic only: use Arduino's existing panic callback and supplied bounded
// backtrace. Do not allocate, take heap/FS locks, or print from a panic handler.
void retainPanic(arduino_panic_info_t* info, void*) {
  auto& row = retainedAbort.trace;
  row = RuntimeProbe::AbortTrace{};
  row.uptimeMs = static_cast<uint32_t>(esp_timer_get_time() / 1000);
  row.pc = reinterpret_cast<uint32_t>(info->pc);
  const char* task = pcTaskGetName(nullptr);
  for (size_t i = 0; task && task[i] && i + 1 < sizeof(row.task); ++i) row.task[i] = task[i];
  for (size_t i = 0; info->reason && info->reason[i] && i + 1 < sizeof(row.reason); ++i) row.reason[i] = info->reason[i];
  for (size_t i = 0; i < 32 && i < info->backtrace_len; ++i) row.callers[i] = info->backtrace[i];
  retainedAbort.magic = abortMagic;
}
}

namespace RuntimeProbe {
AbortTrace previousAbort() {
  return previousAbortRecord;
}
ActivitySpan::ActivitySpan(Activity activity) : activity_(activity) {
  portENTER_CRITICAL(&probeMux);
  const size_t index = static_cast<size_t>(activity_);
  ++activityCounts[index]; activityMask |= uint32_t(1) << index;
  portEXIT_CRITICAL(&probeMux);
}
ActivitySpan::~ActivitySpan() {
  portENTER_CRITICAL(&probeMux);
  const size_t index = static_cast<size_t>(activity_);
  if (activityCounts[index] && --activityCounts[index] == 0) activityMask &= ~(uint32_t(1) << index);
  portEXIT_CRITICAL(&probeMux);
}
FeedEvents feedEvents() {
  portENTER_CRITICAL(&probeMux); const auto result = feedEventRows; portEXIT_CRITICAL(&probeMux); return result;
}
ZeroEvents zeroEvents() {
  portENTER_CRITICAL(&probeMux); const auto result = zeroEventRows; portEXIT_CRITICAL(&probeMux); return result;
}
void setPumpStage(uint32_t stage) {
  portENTER_CRITICAL(&probeMux);
  pumpStageValue = stage; pumpStageAtUs = static_cast<uint32_t>(esp_timer_get_time());
  portEXIT_CRITICAL(&probeMux);
}
static void IRAM_ATTR recordZeroEvent(uint32_t now) {
  const uint32_t number = ++zeroEventNumber;
  auto& row = zeroEventRows.rows[(number - 1) % 8];
  row.number = number; row.atMs = xTaskGetTickCountFromISR() * portTICK_PERIOD_MS;
  row.epoch = probe.epoch; row.activities = activityMask;
  row.priority = uxTaskPriorityGetFromISR(nullptr);
  row.pumpStage = pumpStageValue; row.pumpStageAgeUs = now - pumpStageAtUs;
  const char* name = pcTaskGetName(nullptr);
  size_t i = 0;
  for (; name && name[i] && i + 1 < sizeof(row.task); ++i) row.task[i] = name[i];
  row.task[i] = 0;
}
void recordUpload(UploadTrace trace) {
  portENTER_CRITICAL(&performanceMux);
  trace.number = ++uploadNumber; uploadRows.rows[(trace.number - 1) % 4] = trace;
  portEXIT_CRITICAL(&performanceMux);
}
UploadTraces uploadTraces() {
  portENTER_CRITICAL(&performanceMux); const auto result = uploadRows; portEXIT_CRITICAL(&performanceMux); return result;
}
void begin() {
  const auto reason = esp_reset_reason();
  if (retainedAbort.magic == abortMagic && reason == ESP_RST_PANIC) previousAbortRecord = retainedAbort.trace;
  retainedAbort.magic = 0;
  set_arduino_panic_handler(retainPanic, nullptr);
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
  feedLate = false; zeroRunFrames = 0;
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
        const uint32_t number = ++feedEventNumber;
        auto& event = feedEventRows.rows[(number - 1) % 8];
        event.number = number; event.atMs = xTaskGetTickCountFromISR() * portTICK_PERIOD_MS; event.epoch = probe.epoch;
        event.gapUs = gap; event.activities = activityMask; event.completed = false;
      }
    }
  }
  portEXIT_CRITICAL_ISR(&probeMux);
}

void IRAM_ATTR outputBlock(const int32_t* data, size_t frames, uint32_t now) {
  // The pinned DMA descriptor has at most 256 stereo Q31 frames. Inspect the
  // internal DMA memory before the driver clears it; no PSRAM or allocation.
  if (!data || !frames || frames > 256) return;
  uint32_t bits = 0;
  for (size_t i = 0; i < frames * 2; ++i) bits |= data[i];
  portENTER_CRITICAL_ISR(&probeMux);
  if (probe.active && now - startedUs >= 2000000) {
    ++probe.observedBlocks;
    if (!bits) {
      if (!zeroRunFrames) recordZeroEvent(now);
      ++probe.zeroBlocks; zeroRunFrames += frames;
      if (zeroRunFrames > probe.zeroRunMaxFrames) probe.zeroRunMaxFrames = zeroRunFrames;
    } else zeroRunFrames = 0;
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
    if (feedLate) {
      auto& event = feedEventRows.rows[(feedEventNumber - 1) % 8];
      event.gapUs = now - lastFeedUs; event.completed = true;
    }
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
