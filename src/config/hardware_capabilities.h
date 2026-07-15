#pragma once

#include <stdint.h>
#include "hardware_config.h"

namespace HardwareCapabilities {

static_assert(ENCODER_COUNT >= 0 && ENCODER_COUNT <= 2,
              "ENCODER_COUNT must be 0, 1 or 2");
static_assert(!HAS_ENCODER1 || (ENC1_A_PIN >= 0 && ENC1_B_PIN >= 0),
              "Encoder 1 requires valid A and B pins");
static_assert(!HAS_ENCODER2 || (ENC2_A_PIN >= 0 && ENC2_B_PIN >= 0),
              "Encoder 2 requires valid A and B pins");
static_assert(FRONT_RGB_LED_TYPE >= RGB_LED_NONE && FRONT_RGB_LED_TYPE <= RGB_LED_NEOPIXEL,
              "FRONT_RGB_LED_TYPE is invalid");
static_assert(FRONT_RGB_LED_TYPE != RGB_LED_PWM ||
                (FRONT_RGB_R_PIN >= 0 && FRONT_RGB_G_PIN >= 0 && FRONT_RGB_B_PIN >= 0),
              "PWM front RGB LED requires R, G and B pins");
static_assert(FRONT_RGB_LED_TYPE != RGB_LED_NEOPIXEL || FRONT_RGB_DATA_PIN >= 0,
              "NeoPixel front RGB LED requires a data pin");
static_assert(!HAS_IR || IR_PIN_HW >= 0,
              "IR receiver requires a valid pin");

static constexpr bool encoder1Available =
  HAS_ENCODER1 && ENC1_A_PIN >= 0 && ENC1_B_PIN >= 0;
static constexpr bool encoder2Available =
  HAS_ENCODER2 && ENC2_A_PIN >= 0 && ENC2_B_PIN >= 0;
static constexpr uint8_t encoderCount =
  static_cast<uint8_t>((encoder1Available ? 1 : 0) + (encoder2Available ? 1 : 0));
static constexpr bool irAvailable = HAS_IR && IR_PIN_HW >= 0;
static constexpr bool frontRgbLedAvailable =
  (FRONT_RGB_LED_TYPE == RGB_LED_PWM &&
   FRONT_RGB_R_PIN >= 0 && FRONT_RGB_G_PIN >= 0 && FRONT_RGB_B_PIN >= 0) ||
  (FRONT_RGB_LED_TYPE == RGB_LED_NEOPIXEL && FRONT_RGB_DATA_PIN >= 0);

static constexpr const char* frontRgbLedTypeName() {
#if FRONT_RGB_LED_TYPE == RGB_LED_PWM
  return "pwm";
#elif FRONT_RGB_LED_TYPE == RGB_LED_NEOPIXEL
  return "neopixel";
#else
  return "none";
#endif
}

}  // namespace HardwareCapabilities
