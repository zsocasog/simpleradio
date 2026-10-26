#include "spectrum_log.h"

#include <Arduino.h>
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstring>

namespace SpectrumLog {
namespace {
QueueHandle_t mailbox = nullptr;
StaticQueue_t mailboxControl;
alignas(4) uint8_t mailboxStorage[sizeof(Message)];
TaskHandle_t writerTask = nullptr;
portMUX_TYPE statsMux = portMUX_INITIALIZER_UNLOCKED;
uint32_t writeMaxUs = 0;
uint32_t skipped = 0;

void noteSkip() {
  portENTER_CRITICAL(&statsMux);
  ++skipped;
  portEXIT_CRITICAL(&statsMux);
}

void writeMessage(const Message& message) {
  // USB can remain "connected" after the monitor closes. Both this check and
  // availableForWrite are advisory: a later write can STILL block inside the
  // core driver. That is why only this independent idle-priority task does IO.
  if (!Serial) { noteSkip(); return; }
  const size_t length = strnlen(message.text, sizeof(message.text));
  for (size_t offset = 0; offset < length;) {
    const size_t chunk = std::min<size_t>(64, length - offset);
    if (!Serial || Serial.availableForWrite() < static_cast<int>(chunk)) {
      noteSkip();
      return; // No waiting/retrying for USB space; next report is fresh.
    }
    const uint32_t startedUs = micros();
    const size_t written = Serial.write(reinterpret_cast<const uint8_t*>(message.text) + offset, chunk);
    const uint32_t elapsedUs = micros() - startedUs;
    portENTER_CRITICAL(&statsMux);
    writeMaxUs = std::max(writeMaxUs, elapsedUs);
    portEXIT_CRITICAL(&statsMux);
    if (written != chunk) { noteSkip(); return; }
    offset += written;
    // Give USB interrupts/other logging a turn, without keeping the analyzer
    // or the audio task waiting for this report to finish.
    if (offset < length) vTaskDelay(1);
  }
}

void writerEntry(void*) {
  Message message;
  for (;;) {
    if (xQueueReceive(mailbox, &message, portMAX_DELAY) == pdTRUE) writeMessage(message);
  }
}
} // namespace

bool begin() {
  if (writerTask) return true;
  // Logging is optional. Leave room for the FFT worker and playback/system
  // locks instead of letting its small task stack consume the last heap.
  if (heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) < 16 * 1024) return false;
  mailbox = xQueueCreateStatic(1, sizeof(Message), mailboxStorage, &mailboxControl);
  if (!mailbox) return false;
  if (xTaskCreatePinnedToCore(writerEntry, "spectrum-log", 3072, nullptr,
                              tskIDLE_PRIORITY, &writerTask, 1) != pdPASS) {
    mailbox = nullptr;
    writerTask = nullptr;
    return false; // No synchronous Serial fallback if logging cannot start.
  }
  return true;
}

bool post(const Message& message) {
  // A one-element overwrite mailbox has no timeout or backpressure. If USB is
  // stalled, old pending reports are replaced instead of accumulating.
  return mailbox && xQueueOverwrite(mailbox, &message) == pdPASS;
}

void printf(const char* format, ...) {
  if (!mailbox) return;
  Message message;
  va_list args;
  va_start(args, format);
  vsnprintf(message.text, sizeof(message.text), format, args);
  va_end(args);
  post(message);
}

uint32_t maxWriteUs() {
  portENTER_CRITICAL(&statsMux);
  const uint32_t result = writeMaxUs;
  portEXIT_CRITICAL(&statsMux);
  return result;
}

uint32_t skippedWrites() {
  portENTER_CRITICAL(&statsMux);
  const uint32_t result = skipped;
  portEXIT_CRITICAL(&statsMux);
  return result;
}
} // namespace SpectrumLog
