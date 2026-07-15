#pragma once

#include "../config/hardware_config.h"

#ifndef UI_LANGUAGE
  #ifdef SIMPLE_RADIO_LANGUAGE
    #define UI_LANGUAGE SIMPLE_RADIO_LANGUAGE
  #else
    #define UI_LANGUAGE hu
  #endif
#endif

#define SR_I18N_STRINGIFY2(value) #value
#define SR_I18N_STRINGIFY(value) SR_I18N_STRINGIFY2(value)
#define SR_I18N_HEADER2(lang) lang_##lang.h
#define SR_I18N_HEADER(lang) SR_I18N_HEADER2(lang)

#include SR_I18N_STRINGIFY(SR_I18N_HEADER(UI_LANGUAGE))
