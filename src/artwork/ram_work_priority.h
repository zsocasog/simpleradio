#pragma once

#if defined(ARDUINO_ARCH_ESP32)
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

// Share CPU with FFT/LCD while doing network or RAM-only artwork work. Idle
// priority can receive almost no time during FLAC playback. Audio stays at 2.
// Never use this scope around filesystem writes/maintenance: a reader waiting
// on their mutex could otherwise promote the writer above the audio task.
class ArtworkRamWorkPriority {
public:
  ArtworkRamWorkPriority() {
    TaskStatus_t status{};
    vTaskGetInfo(nullptr, &status, pdFALSE, eInvalid);
    previous_ = status.uxBasePriority;
    if (previous_ == tskIDLE_PRIORITY) vTaskPrioritySet(nullptr, tskIDLE_PRIORITY + 1);
  }
  ~ArtworkRamWorkPriority() {
    if (previous_ == tskIDLE_PRIORITY) vTaskPrioritySet(nullptr, previous_);
  }
  ArtworkRamWorkPriority(const ArtworkRamWorkPriority&) = delete;
  ArtworkRamWorkPriority& operator=(const ArtworkRamWorkPriority&) = delete;
private:
  UBaseType_t previous_ = 0;
};
#else
class ArtworkRamWorkPriority {};
#endif
