#pragma once

#include <Arduino.h>

struct AudioMeterSnapshot {
  uint8_t left = 0;
  uint8_t right = 0;
  bool active = false;
  unsigned long updatedMs = 0;
};

class AudioMeter {
public:
  static AudioMeter& instance();

  void setEnabled(bool value);
  bool isEnabled() const;
  void update(uint16_t vuLevel, bool active);
  void updateFromSamples(int32_t* samples, int16_t validSamples);
  AudioMeterSnapshot snapshot() const;

private:
  AudioMeter() = default;

  volatile bool enabled = false;
  uint8_t left = 0;
  uint8_t right = 0;
  bool active = false;
  unsigned long updatedMs = 0;
};
