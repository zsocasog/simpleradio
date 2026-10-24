#include "audio_meter.h"
#include "audio_spectrum.h"

#include <freertos/FreeRTOS.h>
#include <freertos/portmacro.h>

static portMUX_TYPE meterMux = portMUX_INITIALIZER_UNLOCKED;

AudioMeter& AudioMeter::instance() {
  static AudioMeter meter;
  return meter;
}

void AudioMeter::setEnabled(bool value) {
  enabled = value;
  if (!value) {
    update(0, false);
  }
}

bool AudioMeter::isEnabled() const {
  return enabled;
}

void AudioMeter::update(uint16_t vuLevel, bool isActive) {
  unsigned long now = millis();

  portENTER_CRITICAL(&meterMux);
  active = isActive;
  left = isActive ? static_cast<uint8_t>(vuLevel & 0xFF) : 0;
  right = isActive ? static_cast<uint8_t>((vuLevel >> 8) & 0xFF) : 0;
  updatedMs = now;
  portEXIT_CRITICAL(&meterMux);
}

void AudioMeter::updateFromSamples(int32_t* samples, int16_t validSamples) {
  if (!enabled || !samples || validSamples <= 0) return;

  static unsigned long lastSampleUpdateMs = 0;
  unsigned long now = millis();
  if (now - lastSampleUpdateMs < 18) return;
  lastSampleUpdateMs = now;

  int step = validSamples / 96;
  if (step < 1) step = 1;

  uint8_t peakLeft = 0;
  uint8_t peakRight = 0;
  uint32_t sumLeft = 0;
  uint32_t sumRight = 0;
  uint16_t count = 0;
  for (int i = 0; i < validSamples; i += step) {
    int32_t leftSample = samples[i * 2];
    int32_t rightSample = samples[i * 2 + 1];
    uint32_t absLeft = leftSample < 0 ? static_cast<uint32_t>(-leftSample) : static_cast<uint32_t>(leftSample);
    uint32_t absRight = rightSample < 0 ? static_cast<uint32_t>(-rightSample) : static_cast<uint32_t>(rightSample);
    sumLeft += absLeft >> 8;
    sumRight += absRight >> 8;
    ++count;
    uint8_t leftLevel = static_cast<uint8_t>(min<uint32_t>(127, absLeft >> 23));
    uint8_t rightLevel = static_cast<uint8_t>(min<uint32_t>(127, absRight >> 23));
    if (leftLevel > peakLeft) peakLeft = leftLevel;
    if (rightLevel > peakRight) peakRight = rightLevel;
  }

  if (count == 0) return;
  uint8_t avgLeft = static_cast<uint8_t>(min<uint32_t>(127, (sumLeft / count) >> 15));
  uint8_t avgRight = static_cast<uint8_t>(min<uint32_t>(127, (sumRight / count) >> 15));
  uint8_t leftLevel = static_cast<uint8_t>(min<uint16_t>(127, (static_cast<uint16_t>(avgLeft) * 3 + peakLeft) / 4));
  uint8_t rightLevel = static_cast<uint8_t>(min<uint16_t>(127, (static_cast<uint16_t>(avgRight) * 3 + peakRight) / 4));

  update(static_cast<uint16_t>(leftLevel) | (static_cast<uint16_t>(rightLevel) << 8), true);
}

AudioMeterSnapshot AudioMeter::snapshot() const {
  AudioMeterSnapshot out;

  portENTER_CRITICAL(&meterMux);
  out.left = left;
  out.right = right;
  out.active = active;
  out.updatedMs = updatedMs;
  portEXIT_CRITICAL(&meterMux);
  return out;
}

void audio_process_raw_samples(int32_t* outBuff, int16_t validSamples) {
  AudioMeter::instance().updateFromSamples(outBuff, validSamples);
}

void audio_process_i2s(int32_t* outBuff, int16_t validSamples, bool* continueI2S) {
  // Read-only post-EQ tap. Never modify the output or stop the I2S transfer.
  (void)continueI2S;
  AudioSpectrum::instance().capture(outBuff, validSamples);
}
