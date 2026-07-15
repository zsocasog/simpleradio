#pragma once

#include "hardware_config.h"

// Compatibility layer for existing modules. Edit hardware_config.h, not this file.

// I2S audio
#define I2S_BCLK   I2S_BCLK_PIN
#define I2S_LRC    I2S_LRC_PIN
#define I2S_DOUT   I2S_DOUT_PIN

// TFT SPI
#define TFT_MOSI  TFT_MOSI_PIN
#define TFT_SCLK  TFT_SCLK_PIN
#define TFT_CS    TFT_CS_PIN
#define TFT_DC    TFT_DC_PIN
#define TFT_RST   TFT_RST_PIN
#define TFT_BL    TFT_BL_PIN

// Optional IR receiver
#if HAS_IR
#define IR_PIN IR_PIN_HW
#else
#define IR_PIN -1
#endif

// Optional rotary encoders
#if HAS_ENCODER1
#define ENC1_A  ENC1_A_PIN
#define ENC1_B  ENC1_B_PIN
#define ENC1_SW ENC1_SW_PIN
#else
#define ENC1_A  -1
#define ENC1_B  -1
#define ENC1_SW -1
#endif

#if HAS_ENCODER2
#define ENC2_A  ENC2_A_PIN
#define ENC2_B  ENC2_B_PIN
#define ENC2_SW ENC2_SW_PIN
#else
#define ENC2_A  -1
#define ENC2_B  -1
#define ENC2_SW -1
#endif
