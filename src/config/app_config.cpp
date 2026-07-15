#include "app_config.h"

#include <LittleFS.h>
#include <time.h>
#include "hardware_capabilities.h"
#include "../storage/atomic_file.h"

static const char* CONFIG_FILE = "/config.json";

static DisplayClockStyle parseClockStyle(const String& value) {
  return value == "analog" ? DisplayClockStyle::Analog : DisplayClockStyle::Digital;
}

static DisplayFooterMode parseFooterMode(const String& value) {
  if (value == "volume") return DisplayFooterMode::Volume;
  if (value == "off") return DisplayFooterMode::Off;
  if (value == "station") return DisplayFooterMode::Station;
  if (value == "datetime") return DisplayFooterMode::DateTime;
  return DisplayFooterMode::Vu;
}

static DisplayVuStyle parseVuStyle(const String& value) {
  if (value == "symmetric") return DisplayVuStyle::Symmetric;
  if (value == "classic") return DisplayVuStyle::Classic;
  return DisplayVuStyle::Bars;
}

static String normalizeVolumeCurve(const String& value) {
  if (value == "linear" || value == "log") return value;
  return "soft";
}

static String normalizeThemeAccent(const String& value) {
  if (value == "ruby") return "red";
  if (value == "amber" || value == "blue" || value == "cyan" || value == "red" || value == "custom") return value;
  return "green";
}

static bool isHexDigit(char c) {
  return (c >= '0' && c <= '9') ||
         (c >= 'a' && c <= 'f') ||
         (c >= 'A' && c <= 'F');
}

static String normalizeHexColor(String value) {
  value.trim();
  if (value.length() != 7 || value[0] != '#') return "#a9f7bf";
  for (uint8_t i = 1; i < 7; ++i) {
    if (!isHexDigit(value[i])) return "#a9f7bf";
  }
  value.toLowerCase();
  return value;
}

AppConfig& AppConfig::instance() {
  static AppConfig config;
  return config;
}

void AppConfig::applyTimeZone() const {
  const char* tz = timeZone.length() ? timeZone.c_str() : "CET-1CEST,M3.5.0/2,M10.5.0/3";
  setenv("TZ", tz, 1);
  tzset();
}

void AppConfig::load() {
  JsonDocument doc;
  readJsonWithBackup(CONFIG_FILE, doc);
  // applyJson also enforces the compiled hardware profile. Run it for an empty
  // document too, so first boot cannot expose impossible default states.
  applyJson(doc);
}

bool AppConfig::save() {
  JsonDocument doc;
  doc["displayInvert"] = displayInvert;
  doc["brightness"] = brightness;
  doc["displayIdleEnabled"] = displayIdleEnabled;
  doc["displayIdleBlank"] = displayIdleBlank;
  doc["displayIdleSeconds"] = displayIdleSeconds;
  doc["displayIdleBrightness"] = displayIdleBrightness;
  doc["displayClockEnabled"] = displayClockEnabled;
  doc["displayClockStyle"] = displayClockStyle;
  doc["displayFooterMode"] = displayFooterMode;
  doc["displayVuStyle"] = displayVuStyle;
  doc["displayVuSensitivity"] = displayVuSensitivity;
  doc["themeAccent"] = themeAccent;
  doc["themeCustomColor"] = themeCustomColor;
  doc["timeZone"] = timeZone;
  doc["autoBrightness"] = autoBrightness;
  doc["dayBrightness"] = dayBrightness;
  doc["nightBrightness"] = nightBrightness;
  doc["dayStartMinute"] = dayStartMinute;
  doc["nightStartMinute"] = nightStartMinute;
  doc["irEnabled"] = irEnabled;
  doc["irSensitivity"] = irSensitivity;
  doc["irActionLearning"] = irActionLearning;
  doc["irPrev"] = String(irPrev);
  doc["irNext"] = String(irNext);
  doc["irToggle"] = String(irToggle);
  doc["irVolUp"] = String(irVolUp);
  doc["irVolDown"] = String(irVolDown);
  doc["irMute"] = String(irMute);
  doc["irPower"] = String(irPower);
  doc["irUp"] = String(irUp);
  doc["irDown"] = String(irDown);
  doc["irLeft"] = String(irLeft);
  doc["irRight"] = String(irRight);
  doc["irOk"] = String(irOk);
  doc["irList"] = String(irList);
  doc["irBack"] = String(irBack);
  doc["irDigit0"] = String(irDigit0);
  doc["irDigit1"] = String(irDigit1);
  doc["irDigit2"] = String(irDigit2);
  doc["irDigit3"] = String(irDigit3);
  doc["irDigit4"] = String(irDigit4);
  doc["irDigit5"] = String(irDigit5);
  doc["irDigit6"] = String(irDigit6);
  doc["irDigit7"] = String(irDigit7);
  doc["irDigit8"] = String(irDigit8);
  doc["irDigit9"] = String(irDigit9);
  doc["irStar"] = String(irStar);
  doc["irHash"] = String(irHash);
  doc["irStation1"] = String(irStation1);
  doc["irStation2"] = String(irStation2);
  doc["irStation3"] = String(irStation3);
  doc["irStation4"] = String(irStation4);
  doc["irStation5"] = String(irStation5);
  doc["encoderEnabled"] = encoderEnabled;
  doc["secondEncoderEnabled"] = secondEncoderEnabled;
  doc["encoderMode"] = encoderMode;
  doc["encoderSensitivity"] = encoderSensitivity;
  doc["encoderVolumeStep"] = encoderVolumeStep;
  doc["encoderLongPressMs"] = encoderLongPressMs;
  doc["encoderAutoPlayStation"] = encoderAutoPlayStation;
  doc["encoderAutoPlayMs"] = encoderAutoPlayMs;
  doc["mqttEnabled"] = mqttEnabled;
  doc["mqttHost"] = mqttHost;
  doc["mqttPort"] = mqttPort;
  doc["mqttUser"] = mqttUser;
  doc["mqttPassword"] = mqttPassword;
  doc["mqttRootTopic"] = mqttRootTopic;
  doc["streamRetryEnabled"] = streamRetryEnabled;
  doc["streamRetryMs"] = streamRetryMs;
  doc["autoStart"] = autoStart;
  doc["volumeCurve"] = volumeCurve;
  doc["frontLedEnabled"] = frontLedEnabled;
  doc["frontLedUseTheme"] = frontLedUseTheme;
  doc["frontLedBrightness"] = frontLedBrightness;
  doc["frontLedStandbyBrightness"] = frontLedStandbyBrightness;
  doc["frontLedColor"] = frontLedColor;

  return writeJsonAtomic(CONFIG_FILE, doc, true);
}

String AppConfig::toJson() const {
  JsonDocument doc;
  doc["displayInvert"] = displayInvert;
  doc["brightness"] = brightness;
  doc["displayIdleEnabled"] = displayIdleEnabled;
  doc["displayIdleBlank"] = displayIdleBlank;
  doc["displayIdleSeconds"] = displayIdleSeconds;
  doc["displayIdleBrightness"] = displayIdleBrightness;
  doc["displayClockEnabled"] = displayClockEnabled;
  doc["displayClockStyle"] = displayClockStyle;
  doc["displayFooterMode"] = displayFooterMode;
  doc["displayVuStyle"] = displayVuStyle;
  doc["displayVuSensitivity"] = displayVuSensitivity;
  doc["themeAccent"] = themeAccent;
  doc["themeCustomColor"] = themeCustomColor;
  doc["timeZone"] = timeZone;
  doc["autoBrightness"] = autoBrightness;
  doc["dayBrightness"] = dayBrightness;
  doc["nightBrightness"] = nightBrightness;
  doc["dayStartMinute"] = dayStartMinute;
  doc["nightStartMinute"] = nightStartMinute;
  doc["irEnabled"] = irEnabled;
  doc["irSensitivity"] = irSensitivity;
  doc["irActionLearning"] = irActionLearning;
  doc["irPrev"] = String(irPrev);
  doc["irNext"] = String(irNext);
  doc["irToggle"] = String(irToggle);
  doc["irVolUp"] = String(irVolUp);
  doc["irVolDown"] = String(irVolDown);
  doc["irMute"] = String(irMute);
  doc["irPower"] = String(irPower);
  doc["irUp"] = String(irUp);
  doc["irDown"] = String(irDown);
  doc["irLeft"] = String(irLeft);
  doc["irRight"] = String(irRight);
  doc["irOk"] = String(irOk);
  doc["irList"] = String(irList);
  doc["irBack"] = String(irBack);
  doc["irDigit0"] = String(irDigit0);
  doc["irDigit1"] = String(irDigit1);
  doc["irDigit2"] = String(irDigit2);
  doc["irDigit3"] = String(irDigit3);
  doc["irDigit4"] = String(irDigit4);
  doc["irDigit5"] = String(irDigit5);
  doc["irDigit6"] = String(irDigit6);
  doc["irDigit7"] = String(irDigit7);
  doc["irDigit8"] = String(irDigit8);
  doc["irDigit9"] = String(irDigit9);
  doc["irStar"] = String(irStar);
  doc["irHash"] = String(irHash);
  doc["irStation1"] = String(irStation1);
  doc["irStation2"] = String(irStation2);
  doc["irStation3"] = String(irStation3);
  doc["irStation4"] = String(irStation4);
  doc["irStation5"] = String(irStation5);
  doc["encoderEnabled"] = encoderEnabled;
  doc["secondEncoderEnabled"] = secondEncoderEnabled;
  doc["encoderMode"] = encoderMode;
  doc["encoderSensitivity"] = encoderSensitivity;
  doc["encoderVolumeStep"] = encoderVolumeStep;
  doc["encoderLongPressMs"] = encoderLongPressMs;
  doc["encoderAutoPlayStation"] = encoderAutoPlayStation;
  doc["encoderAutoPlayMs"] = encoderAutoPlayMs;
  doc["mqttEnabled"] = mqttEnabled;
  doc["mqttHost"] = mqttHost;
  doc["mqttPort"] = mqttPort;
  doc["mqttUser"] = mqttUser;
  doc["mqttPassword"] = mqttPassword;
  doc["mqttRootTopic"] = mqttRootTopic;
  doc["streamRetryEnabled"] = streamRetryEnabled;
  doc["streamRetryMs"] = streamRetryMs;
  doc["autoStart"] = autoStart;
  doc["volumeCurve"] = volumeCurve;
  doc["frontLedEnabled"] = frontLedEnabled;
  doc["frontLedUseTheme"] = frontLedUseTheme;
  doc["frontLedBrightness"] = frontLedBrightness;
  doc["frontLedStandbyBrightness"] = frontLedStandbyBrightness;
  doc["frontLedColor"] = frontLedColor;

  String out;
  serializeJson(doc, out);
  return out;
}

bool AppConfig::applyJson(const JsonDocument& doc) {
  if (doc["displayInvert"].is<bool>()) displayInvert = doc["displayInvert"];
  if (doc["brightness"].is<int>()) brightness = constrain(doc["brightness"].as<int>(), 0, 255);
  if (doc["displayIdleEnabled"].is<bool>()) displayIdleEnabled = doc["displayIdleEnabled"];
  if (doc["displayIdleBlank"].is<bool>()) displayIdleBlank = doc["displayIdleBlank"];
  if (doc["displayIdleSeconds"].is<int>()) displayIdleSeconds = constrain(doc["displayIdleSeconds"].as<int>(), 10, 3600);
  if (doc["displayIdleBrightness"].is<int>()) displayIdleBrightness = constrain(doc["displayIdleBrightness"].as<int>(), 0, 255);
  if (doc["displayClockEnabled"].is<bool>()) displayClockEnabled = doc["displayClockEnabled"];
  if (doc["displayClockStyle"].is<const char*>()) {
    displayClockStyle = doc["displayClockStyle"].as<String>();
    if (displayClockStyle != "analog") displayClockStyle = "digital";
    displayClockStyleId = parseClockStyle(displayClockStyle);
  }
  if (doc["displayFooterMode"].is<const char*>()) {
    displayFooterMode = doc["displayFooterMode"].as<String>();
    if (displayFooterMode != "volume" && displayFooterMode != "off" &&
        displayFooterMode != "station" && displayFooterMode != "datetime" &&
        displayFooterMode != "vu") {
      displayFooterMode = "volume";
    }
    displayFooterModeId = parseFooterMode(displayFooterMode);
  }
  if (doc["displayVuStyle"].is<const char*>()) {
    displayVuStyle = doc["displayVuStyle"].as<String>();
    if (displayVuStyle != "symmetric" && displayVuStyle != "classic" && displayVuStyle != "bars") {
      displayVuStyle = "bars";
    }
    displayVuStyleId = parseVuStyle(displayVuStyle);
  }
  if (doc["displayVuSensitivity"].is<int>()) displayVuSensitivity = constrain(doc["displayVuSensitivity"].as<int>(), 50, 200);
  if (doc["themeAccent"].is<const char*>()) themeAccent = normalizeThemeAccent(doc["themeAccent"].as<String>());
  if (doc["themeCustomColor"].is<const char*>()) themeCustomColor = normalizeHexColor(doc["themeCustomColor"].as<String>());
  if (doc["timeZone"].is<const char*>()) {
    timeZone = doc["timeZone"].as<String>();
    if (!timeZone.length() || timeZone.length() > 96) {
      timeZone = "CET-1CEST,M3.5.0/2,M10.5.0/3";
    }
  }
  if (doc["autoBrightness"].is<bool>()) autoBrightness = doc["autoBrightness"];
  if (doc["dayBrightness"].is<int>()) dayBrightness = constrain(doc["dayBrightness"].as<int>(), 0, 255);
  if (doc["nightBrightness"].is<int>()) nightBrightness = constrain(doc["nightBrightness"].as<int>(), 0, 255);
  if (doc["dayStartMinute"].is<int>()) dayStartMinute = constrain(doc["dayStartMinute"].as<int>(), 0, 1439);
  if (doc["nightStartMinute"].is<int>()) nightStartMinute = constrain(doc["nightStartMinute"].as<int>(), 0, 1439);

  if (doc["irEnabled"].is<bool>()) irEnabled = doc["irEnabled"];
  if (doc["irSensitivity"].is<int>()) irSensitivity = constrain(doc["irSensitivity"].as<int>(), 15, 60);
  if (doc["irActionLearning"].is<const char*>()) irActionLearning = doc["irActionLearning"].as<String>();
  if (doc["irPrev"].is<const char*>()) irPrev = strtoull(doc["irPrev"], nullptr, 10);
  if (doc["irNext"].is<const char*>()) irNext = strtoull(doc["irNext"], nullptr, 10);
  if (doc["irToggle"].is<const char*>()) irToggle = strtoull(doc["irToggle"], nullptr, 10);
  if (doc["irVolUp"].is<const char*>()) irVolUp = strtoull(doc["irVolUp"], nullptr, 10);
  if (doc["irVolDown"].is<const char*>()) irVolDown = strtoull(doc["irVolDown"], nullptr, 10);
  if (doc["irMute"].is<const char*>()) irMute = strtoull(doc["irMute"], nullptr, 10);
  if (doc["irPower"].is<const char*>()) irPower = strtoull(doc["irPower"], nullptr, 10);
  if (doc["irUp"].is<const char*>()) irUp = strtoull(doc["irUp"], nullptr, 10);
  if (doc["irDown"].is<const char*>()) irDown = strtoull(doc["irDown"], nullptr, 10);
  if (doc["irLeft"].is<const char*>()) irLeft = strtoull(doc["irLeft"], nullptr, 10);
  if (doc["irRight"].is<const char*>()) irRight = strtoull(doc["irRight"], nullptr, 10);
  if (doc["irOk"].is<const char*>()) irOk = strtoull(doc["irOk"], nullptr, 10);
  if (doc["irList"].is<const char*>()) irList = strtoull(doc["irList"], nullptr, 10);
  if (doc["irBack"].is<const char*>()) irBack = strtoull(doc["irBack"], nullptr, 10);
  if (doc["irDigit0"].is<const char*>()) irDigit0 = strtoull(doc["irDigit0"], nullptr, 10);
  if (doc["irDigit1"].is<const char*>()) irDigit1 = strtoull(doc["irDigit1"], nullptr, 10);
  if (doc["irDigit2"].is<const char*>()) irDigit2 = strtoull(doc["irDigit2"], nullptr, 10);
  if (doc["irDigit3"].is<const char*>()) irDigit3 = strtoull(doc["irDigit3"], nullptr, 10);
  if (doc["irDigit4"].is<const char*>()) irDigit4 = strtoull(doc["irDigit4"], nullptr, 10);
  if (doc["irDigit5"].is<const char*>()) irDigit5 = strtoull(doc["irDigit5"], nullptr, 10);
  if (doc["irDigit6"].is<const char*>()) irDigit6 = strtoull(doc["irDigit6"], nullptr, 10);
  if (doc["irDigit7"].is<const char*>()) irDigit7 = strtoull(doc["irDigit7"], nullptr, 10);
  if (doc["irDigit8"].is<const char*>()) irDigit8 = strtoull(doc["irDigit8"], nullptr, 10);
  if (doc["irDigit9"].is<const char*>()) irDigit9 = strtoull(doc["irDigit9"], nullptr, 10);
  if (doc["irStar"].is<const char*>()) irStar = strtoull(doc["irStar"], nullptr, 10);
  if (doc["irHash"].is<const char*>()) irHash = strtoull(doc["irHash"], nullptr, 10);
  if (doc["irStation1"].is<const char*>()) irStation1 = strtoull(doc["irStation1"], nullptr, 10);
  if (doc["irStation2"].is<const char*>()) irStation2 = strtoull(doc["irStation2"], nullptr, 10);
  if (doc["irStation3"].is<const char*>()) irStation3 = strtoull(doc["irStation3"], nullptr, 10);
  if (doc["irStation4"].is<const char*>()) irStation4 = strtoull(doc["irStation4"], nullptr, 10);
  if (doc["irStation5"].is<const char*>()) irStation5 = strtoull(doc["irStation5"], nullptr, 10);

  if (doc["encoderEnabled"].is<bool>()) encoderEnabled = doc["encoderEnabled"];
  if (doc["secondEncoderEnabled"].is<bool>()) secondEncoderEnabled = doc["secondEncoderEnabled"];
  if (doc["encoderMode"].is<const char*>()) encoderMode = doc["encoderMode"].as<String>();
  if (doc["encoderSensitivity"].is<int>()) encoderSensitivity = constrain(doc["encoderSensitivity"].as<int>(), 1, 8);
  if (doc["encoderVolumeStep"].is<int>()) encoderVolumeStep = constrain(doc["encoderVolumeStep"].as<int>(), 1, 10);
  if (doc["encoderLongPressMs"].is<int>()) encoderLongPressMs = constrain(doc["encoderLongPressMs"].as<int>(), 300, 3000);
  if (doc["encoderAutoPlayStation"].is<bool>()) encoderAutoPlayStation = doc["encoderAutoPlayStation"];
  if (doc["encoderAutoPlayMs"].is<int>()) encoderAutoPlayMs = constrain(doc["encoderAutoPlayMs"].as<int>(), 300, 10000);

  if (doc["mqttEnabled"].is<bool>()) mqttEnabled = doc["mqttEnabled"];
  if (doc["mqttHost"].is<const char*>()) mqttHost = doc["mqttHost"].as<String>();
  if (doc["mqttPort"].is<int>()) mqttPort = constrain(doc["mqttPort"].as<int>(), 1, 65535);
  if (doc["mqttUser"].is<const char*>()) mqttUser = doc["mqttUser"].as<String>();
  if (doc["mqttPassword"].is<const char*>()) mqttPassword = doc["mqttPassword"].as<String>();
  if (doc["mqttRootTopic"].is<const char*>()) mqttRootTopic = doc["mqttRootTopic"].as<String>();

  if (doc["streamRetryEnabled"].is<bool>()) streamRetryEnabled = doc["streamRetryEnabled"];
  if (doc["streamRetryMs"].is<int>()) streamRetryMs = constrain(doc["streamRetryMs"].as<int>(), 1000, 60000);
  if (doc["autoStart"].is<bool>()) autoStart = doc["autoStart"];
  if (doc["volumeCurve"].is<const char*>()) volumeCurve = normalizeVolumeCurve(doc["volumeCurve"].as<String>());
  if (doc["frontLedEnabled"].is<bool>()) frontLedEnabled = doc["frontLedEnabled"];
  if (doc["frontLedUseTheme"].is<bool>()) frontLedUseTheme = doc["frontLedUseTheme"];
  if (doc["frontLedBrightness"].is<int>()) frontLedBrightness = constrain(doc["frontLedBrightness"].as<int>(), 0, 255);
  if (doc["frontLedStandbyBrightness"].is<int>()) frontLedStandbyBrightness = constrain(doc["frontLedStandbyBrightness"].as<int>(), 0, 255);
  if (doc["frontLedColor"].is<const char*>()) frontLedColor = normalizeHexColor(doc["frontLedColor"].as<String>());

  // Runtime preferences can only enable hardware that exists in this build.
  // This also normalizes stale config.json values after a hardware profile
  // change, so an unavailable second encoder cannot alter encoder 1 behavior.
  if (!HardwareCapabilities::irAvailable) {
    irEnabled = false;
    irActionLearning = "";
  }
  if (!HardwareCapabilities::encoder1Available) encoderEnabled = false;
  if (!HardwareCapabilities::encoder2Available) secondEncoderEnabled = false;
  if (!encoderEnabled) secondEncoderEnabled = false;
  encoderMode = secondEncoderEnabled ? "dual_volume_station" : "single_volume_picker";
  if (!HardwareCapabilities::frontRgbLedAvailable) frontLedEnabled = false;

  return true;
}
