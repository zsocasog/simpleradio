#include <Arduino.h>
#include <LittleFS.h>

#include "state/player_state.h"
#include "state/state_storage.h"
#include "audio/audio_player.h"
#include "artwork/artwork_cache.h"
#include "config/app_config.h"
#include "display/display.h"
#include "web/web_server.h"
#include "wifi/wifi_manager.h"
#include "stations/station_manager.h"
#include "mqtt/mqtt_controller.h"
#include "input/input_controller.h"
#include "led/status_led.h"
#include "config/logging.h"

#include <esp_system.h>
#include <esp_heap_caps.h>
#include <mbedtls/platform.h>
#include <time.h>

AudioPlayer audioPlayer;

static void* mbedtlsPsramCalloc(size_t count, size_t size) {
  if (psramFound()) {
    void* ptr = heap_caps_calloc(count, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (ptr) return ptr;
  }
  return heap_caps_calloc(count, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

static void mbedtlsPsramFree(void* ptr) {
  heap_caps_free(ptr);
}

static void configureTlsMemory() {
  int result = mbedtls_platform_set_calloc_free(mbedtlsPsramCalloc, mbedtlsPsramFree);
  Serial.printf("[setup] TLS allocator: %s, PSRAM free=%u\n",
                result == 0 ? "PSRAM preferred" : "default",
                static_cast<unsigned>(ESP.getFreePsram()));
}

static void configureLocalTime() {
  static bool configured = false;
  if (configured) return;

  AppConfig& config = AppConfig::instance();
  config.applyTimeZone();
  configTzTime(config.timeZone.c_str(), "pool.ntp.org", "time.nist.gov");
  configured = true;
}

void setup() {
  Serial.begin(115200);
  delay(200);

  Serial.println("RESET REASON:");
  Serial.println(esp_reset_reason());

  configureTlsMemory();

  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount failed!");
  }

  AppConfig::instance().load();
  StatusLed::instance().begin();
  Display& display = Display::instance();
  display.begin();
  display.showBootProgress(10);
  ArtworkCache::instance().begin();
  display.showBootProgress(20);

  WifiManager& wifi = WifiManager::instance();
  display.showBootProgress(30);
  wifi.begin();
  
  if (wifi.mode() == WifiRunMode::STA_OK) {
    Serial.println("[setup] STA ready");
    display.showBootProgress(55);
    configureLocalTime();
    Serial.println("[setup] time configured");
    display.showBootProgress(62);
    StationManager::instance().begin();
    Serial.println("[setup] stations loaded");
    display.showBootProgress(70);
    StateStorage::instance().load();
    Serial.println("[setup] state loaded");
    display.showBootProgress(76);
    webServerBegin();
    Serial.println("[setup] web started");
    display.showBootProgress(84);
    MqttController::instance().begin();
    Serial.println("[setup] mqtt started");
    display.showBootProgress(89);
    InputController::instance().begin();
    Serial.println("[setup] input started");
    display.showBootProgress(94);
    audioPlayer.begin();
    Serial.println("[setup] audio started");
    display.showBootProgress(98);
    broadcastState();
    Serial.println("[setup] initial state broadcast");
  }

  display.showBootProgress(100);
  display.finishBoot();
}

void loop() {
 if (WifiManager::instance().mode() == WifiRunMode::STA_OK) {
    bool wifiChanged = WifiManager::instance().loop();
    audioPlayer.loop();
    webServerLoop();
    ArtworkCache::instance().loop();
    MqttController::instance().loop();
    InputController::instance().loop();
    StatusLed::instance().loop();
    if (playerStateDirty) {
      playerStateDirty = false;
      broadcastState();
    }
    if (wifiChanged) {
      broadcastState(true);
    }
  }
  Display::instance().tick();
  vTaskDelay(1);
}
