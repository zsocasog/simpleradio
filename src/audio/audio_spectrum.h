#pragma once

#include <Arduino.h>
#include <array>
#include <freertos/FreeRTOS.h>
#include <freertos/portmacro.h>
#include <freertos/task.h>
#include "spectrum_math.h"
#include "spectrum_capture.h"
#include "spectrum_timing.h"
#include "../diagnostics/runtime_probe.h"

struct AudioSpectrumSnapshot {
  std::array<float, SpectrumMath::BAND_COUNT> bandDb{};
  bool active = false;
  uint32_t updatedMs = 0;
  uint32_t generation = 0;
  uint32_t readyMs = 0;
  uint32_t analyzedMs = 0;
  float peakDb = SpectrumMath::SILENCE_DB;
  float rmsDb = SpectrumMath::SILENCE_DB;
  float outputRmsDb = SpectrumMath::SILENCE_DB;
};

class AudioSpectrum {
public:
  static AudioSpectrum& instance();
  void setEnabled(bool enabled, uint32_t sampleRate, float playbackGainDb = 0,
                  uint32_t dmaBufferFrames = 0);
  void setDisplayVisible(bool visible);
  void capture(const int32_t* samples, int16_t frames, uint64_t firstFrame,
               uint32_t endedMs, uint32_t outputEpoch, uint32_t outputRate);
  AudioSpectrumSnapshot snapshot();
  void noteDisplayFrame(const AudioSpectrumSnapshot& sample, uint32_t startedUs, uint32_t finishedUs);
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  struct RuntimeStatus {
    uint32_t analyzed = 0, draws = 0, lastAnalyzedMs = 0, lastDrawMs = 0, sampleRate = 0;
    bool enabled = false, visible = false, initialized = false;
  };
  RuntimeStatus runtimeStatus();
#endif

private:
  enum class BufferState : uint8_t { Free, Writing, Ready, Processing, Analyzed };
  struct Frame {
    // Preserve post-volume Q31 precision: shifting to int16 before compensating
    // volume would manufacture bass/quantization noise at quiet volume settings.
    int32_t* samples = nullptr;
    BufferState state = BufferState::Free;
    uint32_t sampleRate = 0;
    uint32_t generation = 0;
    uint32_t capturedMs = 0;
    uint32_t readyUs = 0;
    uint32_t readyMs = 0;
    float playbackGainDb = 0;
  };

  bool begin();
  int transform();
  bool fftSelfTest();
  void resetLocked();
  bool takeFrame(uint8_t& index);
  void processFrame(uint8_t index);
  static void taskEntry(void* parameter);
  void taskLoop();
  void reportDiagnostics();

  struct Diagnostics {
    uint32_t callbacks = 0;
    uint32_t captured = 0;
    uint32_t processed = 0;
    uint32_t presented = 0;
    uint32_t merged = 0;
    uint32_t busyDrops = 0;
    uint32_t staleDrops = 0;
    uint32_t resets = 0;
    uint32_t maxQueueMs = 0;
    uint32_t maxProcessingUs = 0;
    uint32_t maxCaptureUs = 0;
    uint32_t nearClipSamples = 0;
    uint32_t pcmFrames = 0;
  };

  portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
  std::array<Frame, SpectrumCapture::BUFFER_COUNT> frames_{};
  int32_t* sampleStorage_ = nullptr;
  AudioSpectrumSnapshot* resultStorage_ = nullptr;
  SpectrumMath::BandPlan* bandPlan_ = nullptr;
  // Task-only tables and the aligned FFT work buffer live in PSRAM. The
  // separate DMA observer/hand-off remains internal and never touches these.
  float* window_ = nullptr;
  float* coefficients_ = nullptr;
  float* work_ = nullptr;
  float windowEnergy_ = 0;
  AudioSpectrumSnapshot published_;
  TaskHandle_t task_ = nullptr;
  bool initialized_ = false;
  bool optimizedFft_ = false;
  bool enabled_ = false;
  bool visible_ = false;
  bool firstFrame_ = true;
  uint32_t sampleRate_ = 0;
  float playbackGainDb_ = 0;
  uint32_t generation_ = 0;
  SpectrumCapture::Clock captureClock_;
  uint64_t nextWindowFrame_ = 0;
  uint32_t lastInitAttemptMs_ = 0;
  uint32_t lastErrorMs_ = 0;
  uint32_t lastPcmMs_ = 0;
  uint32_t lastDiagnosticsMs_ = 0;
  float lastMinDb_ = SpectrumMath::DB_FLOOR;
  float lastMaxDb_ = SpectrumMath::DB_FLOOR;
  Diagnostics diagnostics_;
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  RuntimeStatus runtimeStatus_;
#endif
  SpectrumTiming::Interval timing_;
  uint32_t timingStartedMs_ = 0;
  uint32_t dmaBufferFrames_ = 0;
  int8_t writeBuffer_ = -1;
  size_t writePosition_ = 0;
};
