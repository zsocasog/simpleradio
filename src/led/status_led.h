#pragma once

#include <Arduino.h>
#include <esp32-hal-rmt.h>
#include "front_led_policy.h"

class StatusLed {
public:
  static StatusLed& instance();

  void begin();
  void loop();
  void applyConfig();
  void setDisplayBacklight(uint8_t brightness, bool standby, bool screenOff);
  const FrontLedPolicy::Hardware& hardware() const { return activeHardware; }
  bool ready() const { return errorCode == nullptr; }
  const char* error() const { return errorCode ? errorCode : ""; }

private:
  StatusLed() = default;

  void disableBoardLed();
  void configureFrontLed();
  void parkPwmPins();
  void writeFrontLed(uint8_t r, uint8_t g, uint8_t b);
  void writePwmPin(int pin, uint8_t value);
  void flush();
  void fail(const char* reason);
  FrontLedPolicy::Hardware activeHardware;
  FrontLedPolicy::Transfer transfer;
  rmt_data_t* pixelSymbols = nullptr;
  const char* errorCode = nullptr;
  bool dirty = false, sentOnce = false;
  uint8_t red = 0, green = 0, blue = 0, sentRed = 0, sentGreen = 0, sentBlue = 0;
  uint8_t failures = 0;
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
