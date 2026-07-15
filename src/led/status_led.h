#pragma once

#include <Arduino.h>

class StatusLed {
public:
  static StatusLed& instance();

  void begin();
  void loop();
  void applyConfig();
  void setDisplayBacklight(uint8_t brightness, bool standby, bool screenOff);

private:
  StatusLed() = default;

  void disableBoardLed();
  void configureFrontLed();
  void writeFrontLed(uint8_t r, uint8_t g, uint8_t b);
  void writePwmPin(int pin, uint8_t value);
  bool configured = false;
  bool lastEnabled = false;
  bool lastUseTheme = true;
  uint8_t lastBrightness = 0;
  uint8_t lastStandbyBrightness = 0;
  String lastTheme;
  String lastThemeCustomColor;
  String lastColor;
  uint8_t displayBrightness = 255;
  bool displayStandby = false;
  bool displayOff = false;
  unsigned long lastCheckMs = 0;
};
