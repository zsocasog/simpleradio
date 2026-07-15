#pragma once

#include <Arduino.h>

#ifndef SIMPLE_RADIO_SERIAL_LOGS
#define SIMPLE_RADIO_SERIAL_LOGS 0
#endif

#if !SIMPLE_RADIO_SERIAL_LOGS
class SimpleRadioSilentSerial {
public:
  void begin(unsigned long) {}

  template <typename... Args>
  void print(Args&&...) {}

  template <typename... Args>
  void println(Args&&...) {}

  int printf(const char*, ...) { return 0; }
};

static SimpleRadioSilentSerial simpleRadioSilentSerial;
#ifdef Serial
#undef Serial
#endif
#define Serial simpleRadioSilentSerial
#endif
