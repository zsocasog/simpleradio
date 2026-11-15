#pragma once

#include <array>
#include <cstdint>
#include <string_view>
#include "../config/hardware_config.h"

namespace FrontLedPolicy {
constexpr uint8_t MAX_PIXELS = 64;
enum class Type : uint8_t { None, Pwm, NeoPixel, Invalid };
enum class Order : uint8_t { RGB, RBG, GRB, GBR, BRG, BGR, Invalid };
constexpr Type parseType(std::string_view value) {
  return value == "none" ? Type::None : value == "pwm" ? Type::Pwm :
         value == "neopixel" ? Type::NeoPixel : Type::Invalid;
}
constexpr const char* name(Type type) {
  return type == Type::Pwm ? "pwm" : type == Type::NeoPixel ? "neopixel" : "none";
}
constexpr Order parseOrder(std::string_view value) {
  return value == "RGB" ? Order::RGB : value == "RBG" ? Order::RBG : value == "GRB" ? Order::GRB :
         value == "GBR" ? Order::GBR : value == "BRG" ? Order::BRG : value == "BGR" ? Order::BGR : Order::Invalid;
}
constexpr const char* name(Order order) {
  return order == Order::RGB ? "RGB" : order == Order::RBG ? "RBG" : order == Order::GBR ? "GBR" :
         order == Order::BRG ? "BRG" : order == Order::BGR ? "BGR" : "GRB";
}
// Exclude boot straps, flash/OPI PSRAM, USB and UART pins before considering
// the actual build's display, audio, encoder and IR wiring.
constexpr std::array<int, 22> CANDIDATE_PINS = {
  1, 2, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 38, 39, 40, 41, 42, 47, 48
};
constexpr bool primaryPin(int pin) {
  if (pin < 0) return false;
  return pin == TFT_MOSI_PIN || pin == TFT_SCLK_PIN || pin == TFT_CS_PIN || pin == TFT_DC_PIN ||
         pin == TFT_RST_PIN || pin == TFT_BL_PIN || pin == I2S_BCLK_PIN || pin == I2S_LRC_PIN || pin == I2S_DOUT_PIN ||
         (HAS_IR && pin == IR_PIN_HW) ||
         (HAS_ENCODER1 && (pin == ENC1_A_PIN || pin == ENC1_B_PIN || pin == ENC1_SW_PIN)) ||
         (HAS_ENCODER2 && (pin == ENC2_A_PIN || pin == ENC2_B_PIN || pin == ENC2_SW_PIN));
}
constexpr bool allowedPin(int pin) {
  if (primaryPin(pin) || pin < 0) return false;
  for (int candidate : CANDIDATE_PINS) if (pin == candidate) return true;
  return false;
}
struct Hardware {
  Type type = Type::None;
  int count = 1;
  int dataPin = BOARD_RGB_LED_PIN;
  int redPin = FRONT_RGB_R_PIN, greenPin = FRONT_RGB_G_PIN, bluePin = FRONT_RGB_B_PIN;
  bool inverted = FRONT_RGB_INVERTED;
  Order order = Order::GRB;
};
constexpr Hardware defaultHardware() {
  Hardware result;
  result.type = FRONT_RGB_LED_TYPE == RGB_LED_PWM ? Type::Pwm :
                FRONT_RGB_LED_TYPE == RGB_LED_NEOPIXEL ? Type::NeoPixel : Type::None;
  if (FRONT_RGB_DATA_PIN >= 0) result.dataPin = FRONT_RGB_DATA_PIN;
  return result;
}
constexpr bool valid(const Hardware& hw) {
  if (hw.type == Type::Invalid || hw.order == Order::Invalid || hw.count < 1 || hw.count > MAX_PIXELS) return false;
  for (int pin : {hw.dataPin, hw.redPin, hw.greenPin, hw.bluePin}) if (pin < -1 || pin > 48) return false;
  if (hw.type == Type::NeoPixel) return allowedPin(hw.dataPin);
  if (hw.type == Type::Pwm) return allowedPin(hw.redPin) && allowedPin(hw.greenPin) && allowedPin(hw.bluePin) &&
    hw.redPin != hw.greenPin && hw.redPin != hw.bluePin && hw.greenPin != hw.bluePin;
  return true;
}
constexpr bool same(const Hardware& a, const Hardware& b) {
  return a.type == b.type && a.count == b.count && a.dataPin == b.dataPin && a.redPin == b.redPin &&
         a.greenPin == b.greenPin && a.bluePin == b.bluePin && a.inverted == b.inverted && a.order == b.order;
}
constexpr std::array<uint8_t, 3> ordered(Order order, uint8_t r, uint8_t g, uint8_t b) {
  switch (order) {
    case Order::RGB: return {r, g, b}; case Order::RBG: return {r, b, g};
    case Order::GBR: return {g, b, r}; case Order::BRG: return {b, r, g};
    case Order::BGR: return {b, g, r}; default: return {g, r, b};
  }
}
constexpr uint8_t scaled(uint8_t color, uint8_t brightness) { return uint16_t(color) * brightness / 255; }
constexpr uint8_t pwm(uint8_t value, bool inverted) { return inverted ? 255 - value : value; }
constexpr uint16_t highTicks(bool bit) { return bit ? 8 : 4; }
constexpr uint16_t lowTicks(bool bit) { return bit ? 4 : 8; }
constexpr unsigned symbols(int count) { return count * 24 + 1; } // Last symbol is the 300us latch.
constexpr uint32_t VOLUME_HOLD_MS = 3000, VOLUME_FADE_MS = 300;
struct VolumeCue {
  bool known = false, active = false;
  uint8_t volume = 0;
  uint32_t changedMs = 0;
  constexpr void observe(uint8_t next, bool enabled, uint32_t now) {
    if (next > 100) next = 100;
    if (known && next != volume && enabled) { active = true; changedMs = now; }
    if (!enabled || (active && uint32_t(now - changedMs) >= VOLUME_HOLD_MS)) active = false;
    known = true; volume = next;
  }
  constexpr void cancel() { active = false; }
  constexpr uint8_t weight(uint32_t now) const {
    const uint32_t age = uint32_t(now - changedMs);
    if (!active || age >= VOLUME_HOLD_MS) return 0;
    return age <= VOLUME_HOLD_MS - VOLUME_FADE_MS ? 255 : (VOLUME_HOLD_MS - age) * 255 / VOLUME_FADE_MS;
  }
};
struct Frame {
  std::array<uint8_t, 3> color{};
  uint8_t volume = 0, weight = 0, startPixel = 1;
  bool reverse = false;
};
constexpr bool sameFrame(const Frame& a, const Frame& b) {
  return a.color[0] == b.color[0] && a.color[1] == b.color[1] && a.color[2] == b.color[2] && a.weight == b.weight &&
    (!a.weight || (a.volume == b.volume && a.startPixel == b.startPixel && a.reverse == b.reverse));
}
constexpr bool validStart(int start) { return start >= 1 && start <= MAX_PIXELS; }
constexpr unsigned filledPixels(unsigned count, unsigned volume) { return (count * (volume > 100 ? 100 : volume) + 99) / 100; }
constexpr unsigned logicalPixel(unsigned physical, unsigned count, unsigned start, bool reverse) {
  if (!count) return 0;
  const unsigned first = (start ? start - 1 : 0) % count;
  return reverse ? (first + count - physical % count) % count : (physical + count - first) % count;
}
constexpr std::array<uint8_t, 3> pixel(const Frame& frame, unsigned physical, unsigned count) {
  auto result = frame.color;
  if (!frame.weight) return result;
  const bool lit = logicalPixel(physical, count, frame.startPixel, frame.reverse) < filledPixels(count, frame.volume);
  for (unsigned channel = 0; channel < 3; ++channel) {
    const uint8_t cue = count <= 1 ? uint16_t(frame.color[channel]) * frame.volume / 100 : lit ? frame.color[channel] : 0;
    result[channel] = (uint32_t(cue) * frame.weight + uint32_t(frame.color[channel]) * (255 - frame.weight) + 127) / 255;
  }
  return result;
}
struct Transfer {
  bool inFlight = false;
  uint32_t startedUs = 0;
  constexpr bool ready(bool completed) const { return !inFlight || completed; }
  constexpr bool stalled(bool completed, uint32_t now) const {
    return inFlight && !completed && uint32_t(now - startedUs) >= 100000;
  }
  constexpr void started(uint32_t now) { inFlight = true; startedUs = now; }
};
} // namespace FrontLedPolicy
