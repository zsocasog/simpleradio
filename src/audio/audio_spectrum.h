#pragma once

#include <Arduino.h>
#include <array>
#include <freertos/FreeRTOS.h>
#include <freertos/portmacro.h>
#include <freertos/task.h>
#include "spectrum_math.h"
#include "spectrum_capture.h"

struct AudioSpectrumSnapshot {
  std::array<float, SpectrumMath::BAND_COUNT> bandDb{};
  bool active = false;
  uint32_t updatedMs = 0;
  uint32_t generation = 0;
  float peakDb = SpectrumMath::SILENCE_DB;
  float rmsDb = SpectrumMath::SILENCE_DB;
  float outputRmsDb = SpectrumMath::SILENCE_DB;
};

class AudioSpectrum {
public:
  static AudioSpectrum& instance();
  void setEnabled(bool enabled, uint32_t sampleRate, float playbackGainDb = 0);
  void setDisplayVisible(bool visible);
  void capture(const int32_t* samples, int16_t frames);
  AudioSpectrumSnapshot snapshot();

private:
  enum class BufferState : uint8_t { Free, Writing, Ready, Processing };
  struct Frame {
    // Preserve post-volume Q31 precision: shifting to int16 before compensating
    // volume would manufacture bass/quantization noise at quiet volume settings.
    int32_t* samples = nullptr;
    BufferState state = BufferState::Free;
    uint32_t sampleRate = 0;
    uint32_t generation = 0;
    uint32_t capturedMs = 0;
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
  alignas(16) std::array<float, SpectrumMath::POINT_COUNT> window_{};
  alignas(16) std::array<float, SpectrumMath::POINT_COUNT> coefficients_{};
  alignas(16) std::array<float, SpectrumMath::POINT_COUNT * 2> work_{};
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
  int8_t writeBuffer_ = -1;
  size_t writePosition_ = 0;
};
