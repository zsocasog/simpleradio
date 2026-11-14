#include "status_led.h"

#include <Arduino.h>
#include <esp_heap_caps.h>
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
  activeHardware = AppConfig::instance().frontLedHardware();
  disableBoardLed();
  configureFrontLed();
  applyConfig();
}

void StatusLed::disableBoardLed() {
#if DISABLE_BOARD_RGB_LED && BOARD_RGB_LED_PIN >= 0
  if (FrontLedPolicy::primaryPin(BOARD_RGB_LED_PIN)) return;
  rgbLedWrite(BOARD_RGB_LED_PIN, 0, 0, 0);
  pinMode(BOARD_RGB_LED_PIN, OUTPUT);
  digitalWrite(BOARD_RGB_LED_PIN, LOW);
#endif
}

void StatusLed::fail(const char* reason) {
  configured = false; errorCode = reason;
  Serial.printf("[led] disabled: %s; radio continues without LED output\n", reason);
}

void StatusLed::parkPwmPins() {
  // Reset leaves some pins as inputs/JTAG. A connected RGB LED must not
  // depend on their floating level, including when its saved type is "none".
  for (int pin : {activeHardware.redPin, activeHardware.greenPin, activeHardware.bluePin}) {
    if (!FrontLedPolicy::allowedPin(pin)) continue;
    pinMode(pin, OUTPUT);
    digitalWrite(pin, activeHardware.inverted ? HIGH : LOW);
  }
}

void StatusLed::configureFrontLed() {
  using namespace FrontLedPolicy;
  if (!valid(activeHardware)) { fail("invalid-hardware"); return; }
  if (activeHardware.type == Type::None) { parkPwmPins(); return; }
  if (activeHardware.type == Type::Pwm) {
    const int pins[] = {activeHardware.redPin, activeHardware.greenPin, activeHardware.bluePin};
    int attached = 0;
    for (int pin : pins) {
      // Set the inactive level before attaching PWM, including common-anode LEDs.
      pinMode(pin, OUTPUT); digitalWrite(pin, activeHardware.inverted ? HIGH : LOW);
      if (!ledcAttach(pin, 5000, 8)) {
        for (int i = 0; i < attached; ++i) { ledcDetach(pins[i]); pinMode(pins[i], OUTPUT); digitalWrite(pins[i], activeHardware.inverted ? HIGH : LOW); }
        fail("pwm-unavailable"); return;
      }
      ledcWrite(pin, pwm(0, activeHardware.inverted)); ++attached;
    }
    configured = true; return;
  }
  const size_t bytes = symbols(activeHardware.count) * sizeof(rmt_data_t);
  // RMT's interrupt encoder must never read PSRAM while the flash cache is off.
  // Allocate once at boot, before audio starts; no LED task or per-frame heap.
  pixelSymbols = static_cast<rmt_data_t*>(heap_caps_calloc(1, bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  if (!pixelSymbols) { fail("memory"); return; }
  pinMode(activeHardware.dataPin, OUTPUT); digitalWrite(activeHardware.dataPin, LOW);
  if (!rmtInit(activeHardware.dataPin, RMT_TX_MODE, RMT_MEM_NUM_BLOCKS_1, 10000000)) {
    free(pixelSymbols); pixelSymbols = nullptr; fail("rmt-unavailable"); return;
  }
  rmtSetEOT(activeHardware.dataPin, LOW);
  configured = true;
}

void StatusLed::writePwmPin(int pin, uint8_t value) {
  ledcWrite(pin, FrontLedPolicy::pwm(value, activeHardware.inverted));
}

void StatusLed::writeFrontLed(uint8_t r, uint8_t g, uint8_t b) {
  if (!configured) return;
  red = r; green = g; blue = b;
  dirty = !sentOnce || red != sentRed || green != sentGreen || blue != sentBlue;
}

void StatusLed::flush() {
  using namespace FrontLedPolicy;
  if (!configured) return;
  if (activeHardware.type == Type::NeoPixel && transfer.inFlight) {
    const bool completed = rmtTransmitCompleted(activeHardware.dataPin);
    if (transfer.stalled(completed, micros())) { fail("rmt-timeout"); return; }
    if (!transfer.ready(completed)) return; // The encoder still owns pixelSymbols.
    transfer.inFlight = false;
  }
  if (!dirty) return;
  if (activeHardware.type == Type::Pwm) {
    writePwmPin(activeHardware.redPin, red); writePwmPin(activeHardware.greenPin, green); writePwmPin(activeHardware.bluePin, blue);
  } else {
    const auto colors = ordered(activeHardware.order, red, green, blue);
    unsigned index = 0;
    for (int pixel = 0; pixel < activeHardware.count; ++pixel) for (uint8_t color : colors) for (int bit = 7; bit >= 0; --bit) {
      const bool one = color & (1U << bit);
      auto& symbol = pixelSymbols[index++];
      symbol.level0 = 1; symbol.duration0 = highTicks(one);
      symbol.level1 = 0; symbol.duration1 = lowTicks(one);
    }
    auto& latch = pixelSymbols[index++];
    latch.level0 = 0; latch.duration0 = 3000; latch.level1 = 0; latch.duration1 = 1;
    if (!rmtWriteAsync(activeHardware.dataPin, pixelSymbols, index)) {
      if (++failures >= 3) fail("rmt-write");
      return;
    }
    transfer.started(micros());
  }
  failures = 0; sentOnce = true; dirty = false;
  sentRed = red; sentGreen = green; sentBlue = blue;
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
  flush();
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
