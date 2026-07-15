#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include "hardware_config.h"

enum class DisplayClockStyle : uint8_t {
  Digital = 0,
  Analog = 1
};

enum class DisplayFooterMode : uint8_t {
  Vu = 0,
  Volume = 1,
  Off = 2,
  Station = 3,
  DateTime = 4
};

enum class DisplayVuStyle : uint8_t {
  Bars = 0,
  Symmetric = 1,
  Classic = 2
};

class AppConfig {
public:
  static AppConfig& instance();

  void load();
  bool save();
  void applyTimeZone() const;

  String toJson() const;
  bool applyJson(const JsonDocument& doc);

  bool displayInvert = false;
  uint8_t brightness = 230;
  bool displayIdleEnabled = false;
  bool displayIdleBlank = false;
  uint16_t displayIdleSeconds = 120;
  uint8_t displayIdleBrightness = 13;
  bool displayClockEnabled = false;
  String displayClockStyle = "digital";
  String displayFooterMode = "volume";
  String displayVuStyle = "bars";
  uint8_t displayVuSensitivity = 100;
  String themeAccent = "green";
  String themeCustomColor = "#a9f7bf";
  DisplayClockStyle displayClockStyleId = DisplayClockStyle::Digital;
  DisplayFooterMode displayFooterModeId = DisplayFooterMode::Volume;
  DisplayVuStyle displayVuStyleId = DisplayVuStyle::Bars;
  String timeZone = "CET-1CEST,M3.5.0/2,M10.5.0/3";
  bool autoBrightness = false;
  uint8_t dayBrightness = 230;
  uint8_t nightBrightness = 51;
  uint16_t dayStartMinute = 7 * 60;
  uint16_t nightStartMinute = 20 * 60;

  bool irEnabled = false;
  uint8_t irSensitivity = 40;
  String irActionLearning;
  uint64_t irPrev = 0;
  uint64_t irNext = 0;
  uint64_t irToggle = 0;
  uint64_t irVolUp = 0;
  uint64_t irVolDown = 0;
  uint64_t irMute = 0;
  uint64_t irPower = 0;
  uint64_t irUp = 0;
  uint64_t irDown = 0;
  uint64_t irLeft = 0;
  uint64_t irRight = 0;
  uint64_t irOk = 0;
  uint64_t irList = 0;
  uint64_t irBack = 0;
  uint64_t irDigit0 = 0;
  uint64_t irDigit1 = 0;
  uint64_t irDigit2 = 0;
  uint64_t irDigit3 = 0;
  uint64_t irDigit4 = 0;
  uint64_t irDigit5 = 0;
  uint64_t irDigit6 = 0;
  uint64_t irDigit7 = 0;
  uint64_t irDigit8 = 0;
  uint64_t irDigit9 = 0;
  uint64_t irStar = 0;
  uint64_t irHash = 0;
  uint64_t irStation1 = 0;
  uint64_t irStation2 = 0;
  uint64_t irStation3 = 0;
  uint64_t irStation4 = 0;
  uint64_t irStation5 = 0;

  bool encoderEnabled = true;
  bool secondEncoderEnabled = false;
  String encoderMode = "single_volume_picker";
  uint8_t encoderSensitivity = 8;
  uint8_t encoderVolumeStep = 5;
  uint16_t encoderLongPressMs = 700;
  bool encoderAutoPlayStation = true;
  uint16_t encoderAutoPlayMs = 2500;

  bool mqttEnabled = false;
  String mqttHost;
  uint16_t mqttPort = 1883;
  String mqttUser;
  String mqttPassword;
  String mqttRootTopic = "simpleradio";

  bool streamRetryEnabled = true;
  uint16_t streamRetryMs = 5000;
  bool autoStart = false;
  String volumeCurve = "soft";
  bool frontLedEnabled = false;
  bool frontLedUseTheme = true;
  uint8_t frontLedBrightness = 128;
  uint8_t frontLedStandbyBrightness = 13;
  String frontLedColor = "#a9f7bf";

private:
  AppConfig() = default;
};
