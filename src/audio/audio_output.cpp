#include "audio_output.h"
#include "audio_spectrum.h"
#include "spectrum_output_queue.h"
#include "spectrum_log.h"
#include "../diagnostics/runtime_probe.h"

#include <esp_attr.h>
#include <esp_timer.h>
#include <cstring>

namespace {
// 4096 bytes plus a 2048-byte hand-off task stack. Neither buffer nor ISR
// context may be external RAM: callbacks can run while the flash cache is off.
DRAM_ATTR int32_t pcm[SpectrumOutput::BLOCK_COUNT][SpectrumOutput::BLOCK_FRAMES * 2];
DRAM_ATTR SpectrumOutput::Queue queue;
DRAM_ATTR portMUX_TYPE outputMux = portMUX_INITIALIZER_UNLOCKED;
DRAM_ATTR TaskHandle_t inputTask = nullptr;
DRAM_ATTR SpectrumOutput::Statistics counters;
DRAM_ATTR uint64_t outputFrames = 0;
DRAM_ATTR uint32_t outputRate = 0;
DRAM_ATTR bool attached = false;
DRAM_ATTR bool running = false;
DRAM_ATTR bool enabled = false;

bool IRAM_ATTR onSent(i2s_chan_handle_t, i2s_event_data_t* event, void*) {
  const uint64_t startedUs = esp_timer_get_time();
  // Same time base as millis(), including rollover. The pinned S3 toolchain
  // maps the division helper to ROM; verified in the linked ELF for cache-off
  // safety. FreeRTOS ticks can be one millisecond ahead of millis().
  const uint32_t endedMs = static_cast<uint32_t>(startedUs / 1000);
  const size_t frames = event->size / (2 * sizeof(int32_t));
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  RuntimeProbe::outputSent(frames, static_cast<uint32_t>(startedUs));
  RuntimeProbe::outputBlock(static_cast<const int32_t*>(event->dma_buf), frames, static_cast<uint32_t>(startedUs));
#endif
  int index = -1;
  TaskHandle_t consumer = nullptr;
  portENTER_CRITICAL_ISR(&outputMux);
  const uint64_t firstFrame = outputFrames;
  outputFrames += frames; // Includes real output silence and analyzer drops.
  if (running && enabled && inputTask) {
    ++counters.blocks;
    if (event->dma_buf && frames && frames <= SpectrumOutput::BLOCK_FRAMES &&
        event->size == frames * 2 * sizeof(int32_t)) {
      SpectrumOutput::Stamp stamp;
      stamp.firstFrame = firstFrame;
      stamp.endedMs = endedMs;
      stamp.sampleRate = outputRate;
      stamp.frames = static_cast<uint16_t>(frames);
      index = queue.reserve(stamp);
    }
    if (index < 0) ++counters.dropped;
  }
  portEXIT_CRITICAL_ISR(&outputMux);
  if (index < 0) return false;

  // The IDF calls on_sent BEFORE auto_clear_after_cb erases the sent buffer.
  // Bounded internal-to-internal read-only copy; no FFT, PSRAM, USB or waiting.
  memcpy(pcm[index], event->dma_buf, event->size);
  portENTER_CRITICAL_ISR(&outputMux);
  if (queue.commit(index)) consumer = inputTask;
  const uint32_t copyUs = static_cast<uint32_t>(esp_timer_get_time() - startedUs);
  if (copyUs > counters.copyMaxUs) counters.copyMaxUs = copyUs;
  portEXIT_CRITICAL_ISR(&outputMux);
  BaseType_t wake = pdFALSE;
  if (consumer) vTaskNotifyGiveFromISR(consumer, &wake);
  return wake == pdTRUE;
}

void inputLoop(void* context) {
  auto& spectrum = *static_cast<AudioSpectrum*>(context);
  for (;;) {
    for (;;) {
      SpectrumOutput::Stamp stamp;
      portENTER_CRITICAL(&outputMux);
      // Sample time after taking the lock: a DMA ISR may have published a
      // newer block between the previous task instructions and this lock.
      const uint32_t now = millis();
      const int index = queue.take(now, counters.expired);
      if (index >= 0) {
        stamp = queue.slots[index].stamp;
        const uint32_t age = now - stamp.endedMs;
        if (age > counters.handoffMaxMs) counters.handoffMaxMs = age;
      }
      portEXIT_CRITICAL(&outputMux);
      if (index < 0) break;
      spectrum.capture(pcm[index], stamp.frames, stamp.firstFrame, stamp.endedMs,
                       stamp.epoch, stamp.sampleRate);
      portENTER_CRITICAL(&outputMux);
      queue.release(index);
      portEXIT_CRITICAL(&outputMux);
    }
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
  }
}
}

namespace SimpleRadioAudioOutput {
bool attach(i2s_chan_handle_t handle) {
  i2s_event_callbacks_t callbacks{};
  callbacks.on_sent = onSent;
  const bool ok = i2s_channel_register_event_callback(handle, &callbacks, nullptr) == ESP_OK;
  portENTER_CRITICAL(&outputMux);
  attached = ok;
  portEXIT_CRITICAL(&outputMux);
  return ok;
}

void start(uint32_t sampleRate) {
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  // The pinned library uses 32 descriptors of 256 stereo frames.
  RuntimeProbe::outputStart(sampleRate, 32 * 256);
#endif
  portENTER_CRITICAL(&outputMux);
  queue.reset();
  outputFrames = 0;
  outputRate = sampleRate;
  running = sampleRate != 0;
  portEXIT_CRITICAL(&outputMux);
}

void stop() {
#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  RuntimeProbe::outputStop();
#endif
  portENTER_CRITICAL(&outputMux);
  running = false;
  queue.reset();
  portEXIT_CRITICAL(&outputMux);
}
}

namespace SpectrumOutput {
bool begin(AudioSpectrum& spectrum) {
  if (!attached) { SpectrumLog::printf("[spectrum] I2S output observer unavailable; playback unchanged\n"); return false; }
  if (inputTask) return true;
  // Same priority as FFT, below audio (2). Time slicing lets this tiny bridge
  // drain DMA blocks during a longer FFT without reserving a large ISR queue.
  return xTaskCreatePinnedToCore(inputLoop, "spectrum-in", 2048, &spectrum, 1,
                                &inputTask, 1) == pdPASS;
}

void setEnabled(bool value) {
  portENTER_CRITICAL(&outputMux);
  if (enabled != value) { enabled = value; queue.reset(); }
  portEXIT_CRITICAL(&outputMux);
}

bool isCurrent(uint32_t epoch) {
  portENTER_CRITICAL(&outputMux);
  const bool valid = running && enabled && epoch == queue.epoch;
  portEXIT_CRITICAL(&outputMux);
  return valid;
}

Statistics statistics() {
  portENTER_CRITICAL(&outputMux);
  const auto result = counters;
  counters = {};
  portEXIT_CRITICAL(&outputMux);
  return result;
}
}
