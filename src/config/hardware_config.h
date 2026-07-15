#pragma once

// Edit this file before the first firmware upload to match the board wiring.
// Use 1 for enabled / true and 0 for disabled / false.

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------
// Compile-time UI language. Built-in values: hu, en. Alias: eng.
// To add a new language, copy src/i18n/lang_template.h and data/i18n/template.js.
#ifndef UI_LANGUAGE
#define UI_LANGUAGE hu
#endif

// ---------------------------------------------------------------------------
// Display profile
// ---------------------------------------------------------------------------
// Select only the profile here. Driver, logical size and safe bus defaults are
// derived below so a normal hardware build cannot accidentally pick bad timing.
#define DISPLAY_PROFILE_ILI9488_480X320  1
#define DISPLAY_PROFILE_ST7796_480X320   2
#define DISPLAY_PROFILE_ILI9341_320X240  3

#ifndef DISPLAY_PROFILE
#define DISPLAY_PROFILE 1
#endif

// Display rotation: 0..3. Use this when the panel is mounted upside down or
// rotated differently in the enclosure. The default 1 is landscape 480x320 for
// the current front-panel build.
#define DISPLAY_ROTATION 1

// Display SPI pins
#define TFT_MOSI_PIN  11
#define TFT_SCLK_PIN  12
#define TFT_CS_PIN    10
#define TFT_DC_PIN     9
#define TFT_RST_PIN    8
#define TFT_BL_PIN    14

// ---------------------------------------------------------------------------
// I2S audio output
// ---------------------------------------------------------------------------
#define I2S_BCLK_PIN  7
#define I2S_LRC_PIN   6
#define I2S_DOUT_PIN  5

// ---------------------------------------------------------------------------
// Optional IR receiver
// ---------------------------------------------------------------------------
#define HAS_IR  1
#define IR_PIN_HW 15

// ---------------------------------------------------------------------------
// Optional rotary encoders
// ---------------------------------------------------------------------------
// Number of physically installed encoders: 0, 1 or 2. The firmware and WebUI
// derive every encoder capability from this single value.
#define ENCODER_COUNT 1

#define HAS_ENCODER1  (ENCODER_COUNT >= 1)
#define ENC1_A_PIN   18
#define ENC1_B_PIN   17
#define ENC1_SW_PIN  16

#define HAS_ENCODER2  (ENCODER_COUNT >= 2)
#define ENC2_A_PIN   -1
#define ENC2_B_PIN   -1
#define ENC2_SW_PIN  -1

// ---------------------------------------------------------------------------
// Built-in board RGB LED
// ---------------------------------------------------------------------------
// Many ESP32-S3 boards use GPIO48 for the built-in WS2812 LED.
// Keep this enabled if you want the firmware to force it off at boot.
#define DISABLE_BOARD_RGB_LED  true
#define BOARD_RGB_LED_PIN      48

// ---------------------------------------------------------------------------
// Optional front-panel RGB LED for encoder illumination
// ---------------------------------------------------------------------------
#define RGB_LED_NONE      0
#define RGB_LED_PWM       1
#define RGB_LED_NEOPIXEL  2

// Set to RGB_LED_PWM for a discrete common-cathode/common-anode RGB LED, or
// RGB_LED_NEOPIXEL for a single WS2812-style LED.
#define FRONT_RGB_LED_TYPE 0

// PWM RGB LED pins. Only used with RGB_LED_PWM.
#define FRONT_RGB_R_PIN 40
#define FRONT_RGB_G_PIN 39
#define FRONT_RGB_B_PIN 38
#define FRONT_RGB_INVERTED 0
// WS2812-style LED pin. Only used with RGB_LED_NEOPIXEL.
#define FRONT_RGB_DATA_PIN -1

// ---------------------------------------------------------------------------
// Derived display defaults. Usually do not edit below this line.
// ---------------------------------------------------------------------------
#define DISPLAY_ILI9488  9488
#define DISPLAY_ST7796   7796
#define DISPLAY_ILI9341  9341

#if DISPLAY_PROFILE == DISPLAY_PROFILE_ST7796_480X320
  #define DISPLAY_DRIVER        DISPLAY_ST7796
  #define DISPLAY_PANEL_WIDTH   320
  #define DISPLAY_PANEL_HEIGHT  480
  #define DISPLAY_WIDTH         480
  #define DISPLAY_HEIGHT        320
  #define DISPLAY_OFFSET_X      0
  #define DISPLAY_OFFSET_Y      0
  #define DISPLAY_INVERT_PANEL  1
  #define DISPLAY_SPI_WRITE_HZ  40000000
#elif DISPLAY_PROFILE == DISPLAY_PROFILE_ILI9341_320X240
  #define DISPLAY_DRIVER        DISPLAY_ILI9341
  #define DISPLAY_PANEL_WIDTH   240
  #define DISPLAY_PANEL_HEIGHT  320
  #define DISPLAY_WIDTH         320
  #define DISPLAY_HEIGHT        240
  #define DISPLAY_OFFSET_X      0
  #define DISPLAY_OFFSET_Y      0
  #define DISPLAY_INVERT_PANEL  0
  #define DISPLAY_SPI_WRITE_HZ  40000000
#else
  #define DISPLAY_DRIVER        DISPLAY_ILI9488
  #define DISPLAY_PANEL_WIDTH   320
  #define DISPLAY_PANEL_HEIGHT  480
  #define DISPLAY_WIDTH         480
  #define DISPLAY_HEIGHT        320
  #define DISPLAY_OFFSET_X      0
  #define DISPLAY_OFFSET_Y      0
  #define DISPLAY_INVERT_PANEL  1
  #define DISPLAY_SPI_WRITE_HZ  40000000
#endif

#define DISPLAY_SPI_HOST  SPI2_HOST
#define DISPLAY_SPI_MODE  0
