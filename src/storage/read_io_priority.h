#pragma once
#ifndef SIMPLE_RADIO_READ_IO_PRIORITY_H
#define SIMPLE_RADIO_READ_IO_PRIORITY_H

#if defined(ARDUINO_ARCH_ESP32)
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
#include <atomic>
#endif

// A high-priority HTTP reader must not lend its priority to a flash writer
// while waiting for the filesystem mutex. Only the synchronous filesystem
// operation runs below audio; network parsing and socket handling stay intact.
// Restore BASE priority, not an inherited priority, so background workers can
// never be accidentally promoted by nested/contended reads. No heap or task.
class ReadIoPriority {
public:
  ReadIoPriority() {
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
    started_ = xTaskGetTickCount();
#endif
    TaskStatus_t status{};
    vTaskGetInfo(nullptr, &status, pdFALSE, eInvalid);
    previous_ = status.uxBasePriority;
    if (previous_ > 1) vTaskPrioritySet(nullptr, 1);
  }
  ~ReadIoPriority() {
    if (previous_ > 1) vTaskPrioritySet(nullptr, previous_);
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
    const uint32_t elapsed = (xTaskGetTickCount() - started_) * portTICK_PERIOD_MS;
    uint32_t previous = readMaximum().load();
    while (elapsed > previous && !readMaximum().compare_exchange_weak(previous, elapsed)) {}
#endif
  }
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  static std::atomic<uint32_t>& readMaximum() { static std::atomic<uint32_t> maximum{0}; return maximum; }
#endif
  ReadIoPriority(const ReadIoPriority&) = delete;
  ReadIoPriority& operator=(const ReadIoPriority&) = delete;
private:
  UBaseType_t previous_ = 0;
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  TickType_t started_ = 0;
#endif
};
#else
class ReadIoPriority {};
#endif

#define SR_READ_IO_SCOPE() ReadIoPriority srReadIoPriority
#endif
