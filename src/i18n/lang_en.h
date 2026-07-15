#pragma once

#include <stdint.h>

namespace I18n {
static constexpr const char* LANGUAGE_CODE = "en";

static constexpr const char* SIMPLE_RADIO = "SimpleRadio";
static constexpr const char* VOLUME_LOWER_PREFIX = "volume ";
static constexpr const char* VOLUME_TITLE = "Volume";
static constexpr const char* PLAYBACK_PAUSED = "Playback paused";
static constexpr const char* NO_STATION = "No station";
static constexpr const char* WIFI_SETUP_TITLE = "WiFi setup";
static constexpr const char* WIFI_SETUP_HINT = "Open the AP and configure WiFi";
static constexpr const char* WIFI_NO_SAVED_NETWORK = "No saved WiFi network";
static constexpr const char* WIFI_CONNECT_PROMPT = "Connect to ESP32-WebRadio";
static constexpr const char* WIFI_MISSING_SSID = "Missing SSID";
static constexpr const char* WIFI_SAVE_FAILED = "Failed to save WiFi";
static constexpr const char* WIFI_SAVED_REBOOTING = "Saved. Rebooting...";
static constexpr const char* STATIONS_TITLE = "Stations";
static constexpr const char* STATIONS_SAVED_SUFFIX = " saved";
static constexpr const char* STATION_PICKER_HINT_SHORT = "turn: choose  press: play";
static constexpr const char* STATION_PICKER_HINT_FULL = "turn/up-down: choose  play/press: start";
static constexpr const char* TIME_SYNC = "Syncing time...";

static constexpr const char* OTA_FAILED = "OTA update failed";
static constexpr const char* OTA_BUSY = "Another OTA upload is still running";
static constexpr const char* OTA_MISSING_CONFIRM = "Missing OTA confirmation";
static constexpr const char* OTA_BAD_PASSWORD = "Invalid OTA password";
static constexpr const char* OTA_EMPTY_FILE = "Empty OTA file";
static constexpr const char* OTA_BEGIN_FAILED = "Cannot start OTA update";
static constexpr const char* OTA_END_FAILED = "OTA finalization failed";
static constexpr const char* OTA_LITTLEFS_REMOUNT_FAILED = "LittleFS remount failed";
static constexpr const char* OTA_NOT_FIRMWARE_BIN = "This does not look like a firmware .bin";
static constexpr const char* OTA_WRITE_FAILED = "OTA write failed";
static constexpr const char* OTA_UPLOAD_INCOMPLETE = "OTA upload did not finish";

static constexpr const char* RESET_POWERON = "Power-on reset";
static constexpr const char* RESET_EXTERNAL = "External reset";
static constexpr const char* RESET_SOFTWARE = "Software reset";
static constexpr const char* RESET_PANIC = "Panic / exception";
static constexpr const char* RESET_INT_WDT = "Interrupt watchdog";
static constexpr const char* RESET_TASK_WDT = "Task watchdog";
static constexpr const char* RESET_WDT = "Watchdog";
static constexpr const char* RESET_DEEP_SLEEP = "Deep sleep wake";
static constexpr const char* RESET_BROWNOUT = "Brownout";
static constexpr const char* RESET_SDIO = "SDIO reset";
static constexpr const char* RESET_USB = "USB reset";
static constexpr const char* RESET_UNKNOWN = "Unknown";

static constexpr const char* MQTT_CONNECTION_TIMEOUT_TEXT = "Connection timeout";
static constexpr const char* MQTT_CONNECTION_LOST_TEXT = "Connection lost";
static constexpr const char* MQTT_CONNECT_FAILED_TEXT = "Connection failed";
static constexpr const char* MQTT_DISCONNECTED_TEXT = "Disconnected";
static constexpr const char* MQTT_CONNECTED_TEXT = "Connected";
static constexpr const char* MQTT_BAD_PROTOCOL_TEXT = "Unsupported protocol";
static constexpr const char* MQTT_BAD_CLIENT_ID_TEXT = "Invalid client ID";
static constexpr const char* MQTT_UNAVAILABLE_TEXT = "Broker unavailable";
static constexpr const char* MQTT_BAD_CREDENTIALS_TEXT = "Invalid credentials";
static constexpr const char* MQTT_UNAUTHORIZED_TEXT = "Unauthorized";
static constexpr const char* MQTT_UNKNOWN_TEXT = "Unknown state";

static inline const char* weekday(uint8_t day) {
  static constexpr const char* DAYS[] = {
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
  };
  return day < 7 ? DAYS[day] : "";
}
}
