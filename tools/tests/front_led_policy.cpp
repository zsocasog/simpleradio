#include "../../src/led/front_led_policy.h"
using namespace FrontLedPolicy;
static_assert(parseType("neopixel") == Type::NeoPixel);
static_assert(parseType("rgbw") == Type::Invalid);
static_assert(parseOrder("GRB") == Order::GRB && parseOrder("grb") == Order::Invalid);
static_assert(!allowedPin(TFT_BL_PIN) && !allowedPin(I2S_DOUT_PIN) && !allowedPin(IR_PIN_HW));
static_assert(!allowedPin(0) && !allowedPin(3) && !allowedPin(19) && !allowedPin(20) && !allowedPin(35) && !allowedPin(46));
static_assert(allowedPin(38) && allowedPin(39) && allowedPin(40) && allowedPin(48));
constexpr bool validation() {
  Hardware h = defaultHardware();
  if (!valid(h) || h.type != Type::None) return false;
  h.type = Type::NeoPixel; h.count = 64; h.dataPin = 48;
  if (!valid(h)) return false;
  h.count = 65; if (valid(h)) return false;
  h.count = 0; if (valid(h)) return false;
  h.count = 16; h.dataPin = TFT_BL_PIN; if (valid(h)) return false;
  h.type = Type::Pwm; h.redPin = 40; h.greenPin = 39; h.bluePin = 38;
  if (!valid(h)) return false;
  h.bluePin = 39; if (valid(h)) return false;
  h.bluePin = I2S_DOUT_PIN; if (valid(h)) return false;
  return true;
}
static_assert(validation());
constexpr bool ordering() {
  for (Order order : {Order::RGB, Order::RBG, Order::GRB, Order::GBR, Order::BRG, Order::BGR}) {
    auto a = ordered(order, 0x11, 0x22, 0x33);
    if (a[0] == a[1] || a[0] == a[2] || a[1] == a[2]) return false;
  }
  return ordered(Order::GRB, 1, 2, 3)[0] == 2 && ordered(Order::GRB, 1, 2, 3)[1] == 1 &&
    ordered(Order::BGR, 1, 2, 3)[0] == 3 && ordered(Order::RGB, 1, 2, 3)[0] == 1;
}
static_assert(ordering());
static_assert(scaled(255, 0) == 0 && scaled(255, 255) == 255 && scaled(128, 128) == 64);
static_assert(pwm(0, true) == 255 && pwm(255, true) == 0 && pwm(128, false) == 128);
static_assert(symbols(1) == 25 && symbols(64) == 1537);
static_assert(highTicks(true) == 8 && lowTicks(true) == 4 && highTicks(false) == 4 && lowTicks(false) == 8);
constexpr bool timing() {
  Transfer t;
  if (!t.ready(false)) return false;
  t.started(0xfffffff0U);
  return !t.ready(false) && t.ready(true) && !t.stalled(false, 10) &&
    t.stalled(false, 100000) && !t.stalled(true, 100000);
}
static_assert(timing());
constexpr bool volumeTiming() {
  VolumeCue cue;
  cue.observe(60, true, 0);
  if (cue.active || cue.weight(0)) return false; // No cue at startup.
  cue.observe(70, true, 100);
  if (cue.weight(100) != 255 || cue.weight(2800) != 255 || cue.weight(2950) != 127 || cue.weight(3100)) return false;
  cue.observe(80, true, 3000); // Continuous adjustments restart the hold.
  if (cue.weight(3100) != 255) return false;
  cue.observe(80, true, 6000);
  if (cue.active) return false;
  cue.observe(0, true, 6100);
  if (!cue.active) return false;
  cue.observe(0, false, 6101);
  if (cue.active || cue.weight(6101)) return false;
  cue.observe(0, true, 6200);
  if (cue.active) return false;
  cue.observe(10, true, 0xfffffff0U);
  return cue.weight(84) == 255 && cue.weight(0x00000ba8U) == 0;
}
static_assert(volumeTiming());
static_assert(validStart(1) && validStart(64) && !validStart(0) && !validStart(65));
constexpr bool pixelMapping() {
  for (unsigned count : {2U, 8U, 16U, 24U, 64U}) for (unsigned start : {1U, count / 2 + 1, count})
    for (unsigned volume : {0U, 1U, 25U, 50U, 99U, 100U}) for (bool reverse : {false, true}) {
      Frame f{{100, 120, 140}, uint8_t(volume), 255, uint8_t(start), reverse};
      unsigned lit = 0;
      for (unsigned position = 0; position < count; ++position) {
        const auto color = pixel(f, position, count);
        if (color[0]) { ++lit; if (color[0] != 100 || color[1] != 120 || color[2] != 140) return false; }
      }
      if (lit != filledPixels(count, volume)) return false;
    }
  Frame f{{100, 120, 140}, 50, 255, 3, false};
  if (pixel(f, 0, 8)[0] != 0 || pixel(f, 2, 8)[0] != 100 || pixel(f, 5, 8)[0] != 100 || pixel(f, 6, 8)[0]) return false;
  f.reverse = true;
  if (pixel(f, 7, 8)[0] != 100 || pixel(f, 3, 8)[0]) return false;
  if (pixel(f, 0, 1)[0] != 50) return false; // One LED uses proportional intensity.
  f.weight = 0;
  if (pixel(f, 3, 8)[0] != 100) return false; // Background returns on expiry.
  Frame same = f; same.volume = 1; same.startPixel = 8; same.reverse = false;
  if (!sameFrame(f, same)) return false; // No redundant background transfers.
  same.weight = 255;
  return !sameFrame(f, same);
}
static_assert(pixelMapping());
