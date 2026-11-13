#pragma once
#include <stdint.h>
#include <stddef.h>
#include <esp_attr.h>

// Explicitly enabled only in a measurement build. No new task, log stream,
// heap allocation or flash writes on the observed audio paths. The measurement
// build also checks bounded sent DMA blocks for all-zero data, without changes.
#ifndef SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
#define SIMPLE_RADIO_RUNTIME_DIAGNOSTICS 0
#endif

namespace RuntimeProbe {
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
struct AbortTrace {
  // POD is essential: a default member initializer would clear RTC_NOINIT
  // during C++ startup, destroying the trace before begin() could recover it.
  uint32_t uptimeMs, pc;
  char task[16];
  char reason[96];
  uint32_t callers[32];
};
AbortTrace previousAbort();
struct AllocationFailure {
  uint32_t count, bytes, caps, uptimeMs;
  char task[24], function[32];
  uint32_t callers[16];
};
struct AllocationFailures { AllocationFailure core[2]; };
void begin();
AllocationFailures allocationFailures(bool previousBoot);
enum class Activity : uint8_t { LogoReceive, LogoWrite, LogoCommit, CacheScan, ThumbnailDecode, ThumbnailWrite, AlbumWork, AlbumDecode, SettingsSave, Spectrum, Count };
class ActivitySpan {
public:
  explicit ActivitySpan(Activity activity);
  ~ActivitySpan();
  ActivitySpan(const ActivitySpan&) = delete;
  ActivitySpan& operator=(const ActivitySpan&) = delete;
private: Activity activity_;
};
struct FeedEvent { uint32_t number = 0, atMs = 0, epoch = 0, gapUs = 0, activities = 0; bool completed = false; };
struct FeedEvents { FeedEvent rows[8]{}; };
FeedEvents feedEvents();
struct ZeroEvent {
  uint32_t number = 0, atMs = 0, epoch = 0, activities = 0, priority = 0, pumpStage = 0, pumpStageAgeUs = 0;
  char task[16]{};
};
struct ZeroEvents { ZeroEvent rows[8]{}; };
ZeroEvents zeroEvents();
void setPumpStage(uint32_t stage);
struct UploadTrace {
  uint32_t number = 0, bytes = 0, firstUs = 0, lastUs = 0, chunks = 0, maxRxGapUs = 0;
  uint32_t queuedUs = 0, workerUs = 0, finishedUs = 0, replyUs = 0;
  uint32_t writeUs = 0, writeChunkMaxUs = 0, flushUs = 0, commitUs = 0, cleanupUs = 0;
  bool saved = false, clientGone = false;
};
struct UploadTraces { UploadTrace rows[4]{}; };
void recordUpload(UploadTrace trace);
UploadTraces uploadTraces();
enum class Metric : uint8_t { ConfigSave, AtomicWrite, ConfigJson, SettingsWait, StationWork, ImageFill, MainLoop, Count };
struct Timing { uint32_t count = 0, lastUs = 0, maxUs = 0; uint64_t totalUs = 0; };
struct Performance { Timing timings[static_cast<size_t>(Metric::Count)]; };
void record(Metric metric, uint32_t elapsedUs);
Performance performance();
class Span {
public:
  explicit Span(Metric metric);
  ~Span();
private:
  Metric metric_;
  uint32_t started_;
};
struct Snapshot {
  uint32_t epoch = 0, sampleRate = 0, dmaFrames = 0;
  bool active = false;
  uint32_t starts = 0, stops = 0;
  uint64_t sentFrames = 0, acceptedBytes = 0;
  uint32_t sentBlocks = 0, writes = 0, partialWrites = 0, writeTimeouts = 0, writeErrors = 0;
  uint32_t sentGapMaxUs = 0, feedGapMaxUs = 0, writeMaxUs = 0;
  uint32_t feedDeadlineMisses = 0, feedAgeUs = 0, sentAgeUs = 0;
  uint32_t observedBlocks = 0, zeroBlocks = 0, zeroRunMaxFrames = 0;
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
void IRAM_ATTR outputBlock(const int32_t* data, size_t frames, uint32_t nowUs);
void written(size_t requested, size_t accepted, int result, uint32_t elapsedUs);
void pump(uint32_t durationUs, uint32_t inputBytes, uint32_t inputCapacity, bool running);
void decoder(uint32_t started, uint32_t acquired, uint32_t finished,
             uint32_t available, uint32_t needed, bool hadPending);
Snapshot snapshot();
#endif
}

#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
#define SR_PERF_SPAN(metric) RuntimeProbe::Span srPerfSpan(RuntimeProbe::Metric::metric)
#define SR_PERF_WAIT(metric, ms) RuntimeProbe::record(RuntimeProbe::Metric::metric, (ms) * 1000U)
#define SR_ACTIVITY(name) RuntimeProbe::ActivitySpan srProbeActivity##name(RuntimeProbe::Activity::name)
#else
#define SR_PERF_SPAN(metric) ((void)0)
#define SR_PERF_WAIT(metric, ms) ((void)0)
#define SR_ACTIVITY(name) ((void)0)
#endif
