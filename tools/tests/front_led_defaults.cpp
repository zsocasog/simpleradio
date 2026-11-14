#include "../../src/config/hardware_config.h"
#undef FRONT_RGB_LED_TYPE
#undef FRONT_RGB_DATA_PIN
#if LED_TEST_PROFILE == 1
#define FRONT_RGB_LED_TYPE RGB_LED_PWM
#define FRONT_RGB_DATA_PIN -1
#else
#define FRONT_RGB_LED_TYPE RGB_LED_NEOPIXEL
#define FRONT_RGB_DATA_PIN 48
#endif
#include "../../src/led/front_led_policy.h"
static_assert(FrontLedPolicy::valid(FrontLedPolicy::defaultHardware()));
static_assert(FrontLedPolicy::defaultHardware().count == 1);
#if LED_TEST_PROFILE == 1
static_assert(FrontLedPolicy::defaultHardware().type == FrontLedPolicy::Type::Pwm);
static_assert(FrontLedPolicy::defaultHardware().redPin == FRONT_RGB_R_PIN);
static_assert(FrontLedPolicy::defaultHardware().inverted == bool(FRONT_RGB_INVERTED));
#else
static_assert(FrontLedPolicy::defaultHardware().type == FrontLedPolicy::Type::NeoPixel);
static_assert(FrontLedPolicy::defaultHardware().dataPin == 48);
#endif
