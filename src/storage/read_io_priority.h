#pragma once
#ifndef SIMPLE_RADIO_READ_IO_PRIORITY_H
#define SIMPLE_RADIO_READ_IO_PRIORITY_H

#if defined(ARDUINO_ARCH_ESP32)
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

// A high-priority HTTP reader must not lend its priority to a flash writer
// while waiting for the filesystem mutex. Only the synchronous filesystem
// operation runs below audio; network parsing and socket handling stay intact.
// Restore BASE priority, not an inherited priority, so background workers can
// never be accidentally promoted by nested/contended reads. No heap or task.
class ReadIoPriority {
public:
  ReadIoPriority() {
    TaskStatus_t status{};
    vTaskGetInfo(nullptr, &status, pdFALSE, eInvalid);
    previous_ = status.uxBasePriority;
    if (previous_ > 1) vTaskPrioritySet(nullptr, 1);
  }
  ~ReadIoPriority() { if (previous_ > 1) vTaskPrioritySet(nullptr, previous_); }
  ReadIoPriority(const ReadIoPriority&) = delete;
  ReadIoPriority& operator=(const ReadIoPriority&) = delete;
private:
  UBaseType_t previous_ = 0;
};
#else
class ReadIoPriority {};
#endif

#define SR_READ_IO_SCOPE() ReadIoPriority srReadIoPriority
#endif
