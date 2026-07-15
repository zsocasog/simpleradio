#pragma once

#include <stdint.h>

namespace I18n {
static constexpr const char* LANGUAGE_CODE = "hu";

static constexpr const char* SIMPLE_RADIO = "SimpleRadio";
static constexpr const char* VOLUME_LOWER_PREFIX = "hangerő ";
static constexpr const char* VOLUME_TITLE = "Hangerő";
static constexpr const char* PLAYBACK_PAUSED = "Lejátszás szünetel";
static constexpr const char* NO_STATION = "Nincs állomás";
static constexpr const char* WIFI_SETUP_TITLE = "WiFi beállítás";
static constexpr const char* WIFI_SETUP_HINT = "Nyisd meg az AP-t és állítsd be a WiFi-t";
static constexpr const char* WIFI_NO_SAVED_NETWORK = "Nincs mentett WiFi hálózat";
static constexpr const char* WIFI_CONNECT_PROMPT = "Csatlakozz az ESP32-WebRadio AP-hez";
static constexpr const char* WIFI_MISSING_SSID = "Hiányzó SSID";
static constexpr const char* WIFI_SAVE_FAILED = "WiFi mentés sikertelen";
static constexpr const char* WIFI_SAVED_REBOOTING = "Mentve. Újraindítás...";
static constexpr const char* STATIONS_TITLE = "Állomások";
static constexpr const char* STATIONS_SAVED_SUFFIX = " mentett";
static constexpr const char* STATION_PICKER_HINT_SHORT = "teker: választ  nyom: indít";
static constexpr const char* STATION_PICKER_HINT_FULL = "teker/fel-le: választ  play/nyom: indít";
static constexpr const char* TIME_SYNC = "Idő szinkronizálás...";

static constexpr const char* OTA_FAILED = "OTA frissítés sikertelen";
static constexpr const char* OTA_BUSY = "Másik OTA feltöltés még folyamatban van";
static constexpr const char* OTA_MISSING_CONFIRM = "Hiányzó OTA megerősítés";
static constexpr const char* OTA_BAD_PASSWORD = "Hibás OTA jelszó";
static constexpr const char* OTA_EMPTY_FILE = "Üres OTA fájl";
static constexpr const char* OTA_BEGIN_FAILED = "Nem lehet elkezdeni az OTA frissítést";
static constexpr const char* OTA_END_FAILED = "OTA lezárás sikertelen";
static constexpr const char* OTA_LITTLEFS_REMOUNT_FAILED = "LittleFS visszacsatolás sikertelen";
static constexpr const char* OTA_NOT_FIRMWARE_BIN = "Ez nem firmware .bin fájlnak tűnik";
static constexpr const char* OTA_WRITE_FAILED = "OTA írási hiba";
static constexpr const char* OTA_UPLOAD_INCOMPLETE = "OTA feltöltés nem fejeződött be";

static constexpr const char* RESET_POWERON = "Bekapcsolás";
static constexpr const char* RESET_EXTERNAL = "Külső reset";
static constexpr const char* RESET_SOFTWARE = "Szoftveres reset";
static constexpr const char* RESET_PANIC = "Panic / kivétel";
static constexpr const char* RESET_INT_WDT = "Interrupt watchdog";
static constexpr const char* RESET_TASK_WDT = "Task watchdog";
static constexpr const char* RESET_WDT = "Watchdog";
static constexpr const char* RESET_DEEP_SLEEP = "Deep sleep ébresztés";
static constexpr const char* RESET_BROWNOUT = "Brownout";
static constexpr const char* RESET_SDIO = "SDIO reset";
static constexpr const char* RESET_USB = "USB reset";
static constexpr const char* RESET_UNKNOWN = "Ismeretlen";

static constexpr const char* MQTT_CONNECTION_TIMEOUT_TEXT = "Kapcsolódási időtúllépés";
static constexpr const char* MQTT_CONNECTION_LOST_TEXT = "Kapcsolat megszakadt";
static constexpr const char* MQTT_CONNECT_FAILED_TEXT = "Kapcsolódás sikertelen";
static constexpr const char* MQTT_DISCONNECTED_TEXT = "Nincs kapcsolat";
static constexpr const char* MQTT_CONNECTED_TEXT = "Csatlakozva";
static constexpr const char* MQTT_BAD_PROTOCOL_TEXT = "Nem támogatott protokoll";
static constexpr const char* MQTT_BAD_CLIENT_ID_TEXT = "Hibás kliens azonosító";
static constexpr const char* MQTT_UNAVAILABLE_TEXT = "Broker nem elérhető";
static constexpr const char* MQTT_BAD_CREDENTIALS_TEXT = "Hibás hitelesítés";
static constexpr const char* MQTT_UNAUTHORIZED_TEXT = "Nincs jogosultság";
static constexpr const char* MQTT_UNKNOWN_TEXT = "Ismeretlen állapot";

static inline const char* weekday(uint8_t day) {
  static constexpr const char* DAYS[] = {
    "vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"
  };
  return day < 7 ? DAYS[day] : "";
}
}
