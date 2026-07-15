#include "status_led.h"

#include <Arduino.h>
#include "../config/app_config.h"
#include "../config/hardware_config.h"

struct LedRgb {
  uint8_t r;
  uint8_t g;
  uint8_t b;
};

static LedRgb themeRgb(const String& theme) {
  if (theme == "amber") return {220, 168, 79};
  if (theme == "blue") return {93, 141, 240};
  if (theme == "cyan") return {66, 200, 216};
  if (theme == "red" || theme == "ruby") return {242, 2, 2};
  return {105, 229, 141};
}

static uint8_t hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return 0;
}

static uint8_t hexByte(const String& text, uint8_t offset) {
  return (hexNibble(text[offset]) << 4) | hexNibble(text[offset + 1]);
}

static LedRgb parseHexColor(const String& value) {
  String color = value;
  color.trim();
  if (color.length() == 7 && color[0] == '#') {
    return {hexByte(color, 1), hexByte(color, 3), hexByte(color, 5)};
  }
  return themeRgb("green");
}

static LedRgb configThemeRgb(const AppConfig& config) {
  if (config.themeAccent == "custom") return parseHexColor(config.themeCustomColor);
  return themeRgb(config.themeAccent);
}

static uint8_t scaleChannel(uint8_t value, uint8_t brightness) {
  return static_cast<uint16_t>(value) * brightness / 255;
}

StatusLed& StatusLed::instance() {
  static StatusLed led;
  return led;
}

void StatusLed::begin() {
  disableBoardLed();
  configureFrontLed();
  applyConfig();
}

void StatusLed::disableBoardLed() {
#if DISABLE_BOARD_RGB_LED && BOARD_RGB_LED_PIN >= 0
  rgbLedWrite(BOARD_RGB_LED_PIN, 0, 0, 0);
  pinMode(BOARD_RGB_LED_PIN, OUTPUT);
  digitalWrite(BOARD_RGB_LED_PIN, LOW);
#endif
}

void StatusLed::configureFrontLed() {
#if FRONT_RGB_LED_TYPE == RGB_LED_PWM
  if (FRONT_RGB_R_PIN >= 0) ledcAttach(FRONT_RGB_R_PIN, 5000, 8);
  if (FRONT_RGB_G_PIN >= 0) ledcAttach(FRONT_RGB_G_PIN, 5000, 8);
  if (FRONT_RGB_B_PIN >= 0) ledcAttach(FRONT_RGB_B_PIN, 5000, 8);
  configured = FRONT_RGB_R_PIN >= 0 ||
               FRONT_RGB_G_PIN >= 0 ||
               FRONT_RGB_B_PIN >= 0;
#elif FRONT_RGB_LED_TYPE == RGB_LED_NEOPIXEL
  configured = FRONT_RGB_DATA_PIN >= 0;
#else
  configured = false;
#endif
}

void StatusLed::writePwmPin(int pin, uint8_t value) {
  if (pin < 0) return;
#if FRONT_RGB_INVERTED
  value = 255 - value;
#endif
  ledcWrite(pin, value);
}

void StatusLed::writeFrontLed(uint8_t r, uint8_t g, uint8_t b) {
  if (!configured) return;

#if FRONT_RGB_LED_TYPE == RGB_LED_PWM
  writePwmPin(FRONT_RGB_R_PIN, r);
  writePwmPin(FRONT_RGB_G_PIN, g);
  writePwmPin(FRONT_RGB_B_PIN, b);
#elif FRONT_RGB_LED_TYPE == RGB_LED_NEOPIXEL
  rgbLedWrite(FRONT_RGB_DATA_PIN, r, g, b);
#else
  (void)r;
  (void)g;
  (void)b;
#endif
}

void StatusLed::applyConfig() {
  if (!configured) return;

  AppConfig& config = AppConfig::instance();
  LedRgb rgb = config.frontLedUseTheme ? configThemeRgb(config) : parseHexColor(config.frontLedColor);
  uint8_t brightness = 0;
  if (config.frontLedEnabled) {
    brightness = displayOff ? 0 : (displayStandby ? config.frontLedStandbyBrightness : config.frontLedBrightness);
  }

  writeFrontLed(
    scaleChannel(rgb.r, brightness),
    scaleChannel(rgb.g, brightness),
    scaleChannel(rgb.b, brightness)
  );

  lastEnabled = config.frontLedEnabled;
  lastUseTheme = config.frontLedUseTheme;
  lastBrightness = config.frontLedBrightness;
  lastStandbyBrightness = config.frontLedStandbyBrightness;
  lastTheme = config.themeAccent;
  lastThemeCustomColor = config.themeCustomColor;
  lastColor = config.frontLedColor;
}

void StatusLed::setDisplayBacklight(uint8_t brightness, bool standby, bool screenOff) {
  if (displayBrightness == brightness &&
      displayStandby == standby &&
      displayOff == screenOff) {
    return;
  }

  displayBrightness = brightness;
  displayStandby = standby;
  displayOff = screenOff;
  applyConfig();
}

void StatusLed::loop() {
  if (!configured || millis() - lastCheckMs < 250) return;
  lastCheckMs = millis();

  AppConfig& config = AppConfig::instance();
  if (config.frontLedEnabled != lastEnabled ||
      config.frontLedUseTheme != lastUseTheme ||
      config.frontLedBrightness != lastBrightness ||
      config.frontLedStandbyBrightness != lastStandbyBrightness ||
      config.themeAccent != lastTheme ||
      config.themeCustomColor != lastThemeCustomColor ||
      config.frontLedColor != lastColor) {
    applyConfig();
  }
}
