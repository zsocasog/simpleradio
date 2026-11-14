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
