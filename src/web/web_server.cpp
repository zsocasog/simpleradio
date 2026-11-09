#include "web_server.h"
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <Update.h>
#include <WiFi.h>
#include <esp_system.h>
#include <esp_heap_caps.h>
#include <esp_app_desc.h>
#include <sys/stat.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include "../state/player_state.h"
#include "../state/state_storage.h"
#include "../storage/ota_backup.h"
#include "../config/app_config.h"
#include "../config/hardware_capabilities.h"
#include "../stations/station_manager.h"
#include "../artwork/artwork_cache.h"
#include "../artwork/album_art_store.h"
#include "../artwork/artwork_memory_gate.h"
#include "../artwork/artwork_http.h"
#include "../artwork/artwork_json.h"
#include "../artwork/lcd_bmp_stream.h"
#include "station_artwork_response.h"
#include <memory>
#include <algorithm>
#include <new>
#include "../display/display.h"
#include "../display/display_presenter.h"
#include "../i18n/i18n.h"
#include "../led/status_led.h"
#include "../config/version.h"
#include "../mqtt/mqtt_controller.h"
#include "../config/logging.h"
#include "recovery_page.h"
#include "webui_compatibility.h"
#include "../diagnostics/runtime_probe.h"

#ifndef SIMPLE_RADIO_OTA_PASSWORD
#define SIMPLE_RADIO_OTA_PASSWORD "simpleradio"
#endif

AsyncWebServer server(80);
AsyncWebSocket ws("/ws");

static SemaphoreHandle_t stateJsonMutex = nullptr;
static String lastBroadcastState;
static unsigned long lastWsCleanupMs = 0;

static SemaphoreHandle_t stateJsonLockHandle() {
  if (!stateJsonMutex) {
    stateJsonMutex = xSemaphoreCreateMutex();
  }
  return stateJsonMutex;
}

static String cachedStateJson() {
  String out;
  SemaphoreHandle_t mutex = stateJsonLockHandle();
  if (mutex && xSemaphoreTake(mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
    out = lastBroadcastState;
    xSemaphoreGive(mutex);
  }
  return out;
}

static bool updateCachedStateJson(const String& stateJson) {
  bool changed = true;
  SemaphoreHandle_t mutex = stateJsonLockHandle();
  if (mutex && xSemaphoreTake(mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
    changed = stateJson != lastBroadcastState;
    if (changed) lastBroadcastState = stateJson;
    xSemaphoreGive(mutex);
  }
  return changed;
}

enum QueuedActionType : uint8_t {
  ACTION_NONE = 0,
  ACTION_COMMAND,
  ACTION_LOAD_STATION,
  ACTION_CLEAR_STATION,
  ACTION_DELETE_STATION
};

struct QueuedPlayerAction {
  QueuedActionType type = ACTION_NONE;
  bool persistState = true;
  bool forceStateSave = false;
  bool hasPlay = false;
  bool play = false;
  bool hasVolume = false;
  int volume = 0;
  bool hasEqLow = false;
  int eqLow = 0;
  bool hasEqMid = false;
  int eqMid = 0;
  bool hasEqHigh = false;
  int eqHigh = 0;
  bool hasBalance = false;
  int balance = 0;
  bool hasStation = false;
  int stationId = -1;
  bool resetMetadata = true;
  int fallbackId = -1;
  bool playAfterDelete = false;
};

struct PendingDelete {
  bool active = false;
  int stationId = -1;
  int fallbackId = -1;
  bool playAfterDelete = false;
  unsigned long commitAt = 0;
};

static constexpr uint8_t ACTION_QUEUE_SIZE = 12;
static portMUX_TYPE actionMux = portMUX_INITIALIZER_UNLOCKED;
static QueuedPlayerAction actionQueue[ACTION_QUEUE_SIZE];
static uint8_t actionHead = 0;
static uint8_t actionTail = 0;
static uint8_t actionCount = 0;
static PendingDelete pendingDelete;
static portMUX_TYPE stateSaveMux = portMUX_INITIALIZER_UNLOCKED;
static bool stateSavePending = false;
static unsigned long stateSaveDue = 0;
struct ControlEditor { uint32_t clientId = 0; bool active = false; };
static ControlEditor controlEditors[8];

static bool controlsBeingEditedLocked() {
  for (const auto& editor : controlEditors) if (editor.active) return true;
  return false;
}

static void setWebControlEditing(uint32_t clientId, bool editing) {
  const unsigned long now = millis();
  portENTER_CRITICAL(&stateSaveMux);
  int freeSlot = -1;
  bool found = false;
  for (size_t i = 0; i < 8; ++i) {
    if (controlEditors[i].active && controlEditors[i].clientId == clientId) {
      controlEditors[i].active = editing;
      found = true;
      break;
    }
    if (!controlEditors[i].active) freeSlot = static_cast<int>(i);
  }
  if (editing && !found && freeSlot >= 0) controlEditors[freeSlot] = {clientId, true};
  // A second gesture can start before the previous 800 ms save timer expires.
  // Pause that pending write until the final release (or client disconnect).
  if (!editing && found && !controlsBeingEditedLocked() && stateSavePending) stateSaveDue = now + 800;
  portEXIT_CRITICAL(&stateSaveMux);
}
static volatile bool displayActivityPending = false;
static volatile bool displayConfigRefreshPending = false;
static volatile bool rebootPending = false;
static unsigned long rebootAt = 0;
static bool otaUploadActive = false;
static bool otaUploadFailed = false;
static bool otaUploadOk = false;
static bool otaFilesystemTarget = false;
static bool otaFilesystemUnmounted = false;
static size_t otaUploadedBytes = 0;
static uint32_t otaUploadGeneration = 0;
static unsigned long otaUploadLastMs = 0;
static String otaUploadError;

static String htmlEscape(String value) {
  value.replace("&", "&amp;");
  value.replace("<", "&lt;");
  value.replace(">", "&gt;");
  value.replace("\"", "&quot;");
  value.replace("'", "&#39;");
  return value;
}

static void sendRecoveryPage(AsyncWebServerRequest* request) {
  const WebUiCompatibilityInfo& webui = WebUiCompatibility::info();
  String page = FPSTR(RECOVERY_PAGE);
  page.replace("__FW_VERSION__", htmlEscape(APP_VERSION));
  page.replace("__FW_API__", String(WEB_API_VERSION));
  page.replace("__UI_VERSION__", htmlEscape(webui.webuiVersion.length() ? webui.webuiVersion : "ismeretlen / unknown"));
  String apiRange = webui.manifestValid
                      ? String(webui.minimumApiVersion) + ".." + String(webui.maximumApiVersion)
                      : "?";
  page.replace("__UI_API__", apiRange);
  page.replace("__REASON__", htmlEscape(WebUiCompatibility::reasonText()));
  AsyncWebServerResponse* response = request->beginResponse(200, "text/html; charset=utf-8", page);
  response->addHeader("Cache-Control", "no-store, max-age=0");
  request->send(response);
}

static OtaBackup::Snapshot otaRuntimeBackup(
  [](size_t bytes) { return static_cast<uint8_t*>(heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)); },
  heap_caps_free);
static bool otaRuntimeBackupReady = false;

static constexpr unsigned long OTA_UPLOAD_STALE_MS = 30000;

static void requestDisplayActivity() {
  displayActivityPending = true;
}

static bool isPureVolumeAction(const QueuedPlayerAction& action) {
  return action.type == ACTION_COMMAND &&
         action.hasVolume &&
         !action.hasPlay &&
         !action.hasEqLow &&
         !action.hasEqMid &&
         !action.hasEqHigh &&
         !action.hasBalance &&
         !action.hasStation;
}

static void requestDisplayConfigRefresh() {
  displayConfigRefreshPending = true;
}

static void processDisplayRequests() {
  if (displayActivityPending) {
    displayActivityPending = false;
    Display::instance().notifyActivity();
  }

  if (displayConfigRefreshPending) {
    displayConfigRefreshPending = false;
    Display::instance().applyConfig();
    Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
    broadcastState(true);
  }
}

static void requestReboot() {
  rebootPending = true;
  rebootAt = millis() + 700;
}

static void stopPlaybackForMaintenance() {
  JsonDocument stopCmd;
  stopCmd["play"] = false;
  PlayerState::instance().applyCommand(stopCmd);
  broadcastState(true);
}

static void clearOtaRuntimeBackups() {
  otaRuntimeBackup.clear();
  otaRuntimeBackupReady = false;
}

static bool backupOtaRuntimeFiles() {
  // Keep a previous snapshot if an interrupted update still needs recovery.
  if (otaRuntimeBackupReady) return true;
  clearOtaRuntimeBackups();
  auto capture = [](const char* path) {
    File file = LittleFS.open(path, "r");
    if (!file || file.isDirectory()) return false;
    return otaRuntimeBackup.add(path, file.size(), [&](uint8_t* data, size_t size) {
      size_t offset = 0;
      while (offset < size) {
        const size_t count = file.read(data + offset, std::min(size - offset, size_t(4096)));
        if (!count) return false;
        offset += count;
        delay(0);
      }
      return true;
    });
  };
  for (const char* path : {"/wifi.json", "/config.json", "/state.json", "/stations.json",
                           "/wifi.json.bak", "/config.json.bak", "/state.json.bak", "/stations.json.bak"}) {
    if (LittleFS.exists(path) && !capture(path)) { clearOtaRuntimeBackups(); return false; }
  }
  if (LittleFS.exists("/logos")) {
    File root = LittleFS.open("/logos");
    if (!root || !root.isDirectory()) { clearOtaRuntimeBackups(); return false; }
    for (File file = root.openNextFile(); file; file = root.openNextFile()) {
      String name = file.name();
      const int slash = name.lastIndexOf('/');
      if (slash >= 0) name.remove(0, slash + 1);
      if (file.isDirectory()) { clearOtaRuntimeBackups(); return false; }
      if (name.endsWith(".tmp") || name.endsWith(".bak")) continue;
      const String path = "/logos/" + name;
      file.close();
      if (!capture(path.c_str())) { clearOtaRuntimeBackups(); return false; }
    }
  }
  otaRuntimeBackupReady = true;
  Serial.printf("[ota] preserved runtime files: %u, bytes=%u\n",
                unsigned(otaRuntimeBackup.count()), unsigned(otaRuntimeBackup.bytes()));
  return true;
}

static bool restoreOtaRuntimeFiles() {
  if (!otaRuntimeBackupReady) return true;
  return otaRuntimeBackup.restore([](const char* path, const uint8_t* data, size_t size) {
    if (strncmp(path, "/logos/", 7) == 0 && !LittleFS.exists("/logos") && !LittleFS.mkdir("/logos")) return false;
    File file = LittleFS.open(path, "w");
    if (!file) return false;
    size_t offset = 0;
    while (offset < size) {
      const size_t count = file.write(data + offset, std::min(size - offset, size_t(4096)));
      if (!count) return false;
      offset += count;
      delay(0);
    }
    file.flush();
    const bool complete = file.size() == size && !file.getWriteError();
    file.close();
    if (!complete) Serial.printf("[ota] failed to restore %s\n", path);
    return complete;
  });
}

static void remountLittleFsAfterFailedOta() {
  if (otaFilesystemUnmounted) {
    if (!LittleFS.begin(false)) return;
    otaFilesystemUnmounted = false;
  }
  if (!otaFilesystemUnmounted && restoreOtaRuntimeFiles()) clearOtaRuntimeBackups();
}

static String otaErrorText(const String& fallback) {
  const char* updateError = Update.errorString();
  if (Update.hasError() && updateError && updateError[0]) return String(updateError);
  return fallback.length() ? fallback : I18n::OTA_FAILED;
}

static void failOtaUpload(AsyncWebServerRequest* request, const String& error) {
  otaUploadFailed = true;
  otaUploadError = otaErrorText(error);
  request->setAttribute("error", otaUploadError.c_str());
  if (Update.isRunning()) Update.abort();
  remountLittleFsAfterFailedOta();
  otaUploadActive = false;
}

static String otaRequestPassword(AsyncWebServerRequest* request) {
  if (request->hasHeader("X-SimpleRadio-OTA-Password")) {
    return request->header("X-SimpleRadio-OTA-Password");
  }
  if (request->hasParam("password")) {
    return request->getParam("password")->value();
  }
  return "";
}

static String jsonErrorResponse(const char* error) {
  return String("{\"ok\":false,\"error\":\"") + error + "\"}";
}

static bool beginOtaUpload(AsyncWebServerRequest* request, size_t total, int command, bool filesystemTarget) {
  if (otaUploadActive && millis() - otaUploadLastMs > OTA_UPLOAD_STALE_MS) {
    if (Update.isRunning()) Update.abort();
    remountLittleFsAfterFailedOta();
    otaUploadActive = false;
  }

  request->setAttribute("otaAccepted", "0");
  if (otaUploadActive) {
    request->setAttribute("error", I18n::OTA_BUSY);
    return false;
  }
  if (!filesystemTarget && otaRuntimeBackupReady) {
    request->setAttribute("error", I18n::OTA_RESTORE_FAILED);
    return false;
  }

  otaUploadFailed = false;
  otaUploadOk = false;
  otaUploadError = "";
  otaUploadedBytes = 0;
  otaFilesystemTarget = filesystemTarget;
  otaFilesystemUnmounted = false;
  otaUploadLastMs = millis();
  request->setAttribute("otaOk", "0");

  if (!request->hasParam("confirm") || request->getParam("confirm")->value() != "1") {
    request->setAttribute("error", I18n::OTA_MISSING_CONFIRM);
    otaUploadFailed = true;
    return false;
  }

  if (otaRequestPassword(request) != SIMPLE_RADIO_OTA_PASSWORD) {
    request->setAttribute("error", I18n::OTA_BAD_PASSWORD);
    otaUploadFailed = true;
    return false;
  }

  if (total == 0) {
    request->setAttribute("error", I18n::OTA_EMPTY_FILE);
    otaUploadFailed = true;
    return false;
  }

  otaUploadActive = true;
  stopPlaybackForMaintenance();

  if (filesystemTarget) {
    if (!backupOtaRuntimeFiles()) {
      otaUploadFailed = true;
      otaUploadActive = false;
      request->setAttribute("error", I18n::OTA_BACKUP_FAILED);
      return false;
    }
    LittleFS.end();
    otaFilesystemUnmounted = true;
  } else {
    clearOtaRuntimeBackups();
  }

  if (!Update.begin(total, command)) {
    failOtaUpload(request, I18n::OTA_BEGIN_FAILED);
    return false;
  }

  request->setAttribute("otaAccepted", "1");
  request->setAttribute("otaGeneration", String(++otaUploadGeneration).c_str());

  Serial.printf("[ota] begin %s, bytes=%u\n",
                filesystemTarget ? "littlefs" : "firmware",
                static_cast<unsigned>(total));
  return true;
}

static void finishOtaUpload(AsyncWebServerRequest* request) {
  if (otaUploadFailed) {
    otaUploadActive = false;
    return;
  }

  if (!Update.end(true)) {
    failOtaUpload(request, I18n::OTA_END_FAILED);
    return;
  }

  if (otaFilesystemTarget) {
    if (!LittleFS.begin(false)) {
      failOtaUpload(request, I18n::OTA_LITTLEFS_REMOUNT_FAILED);
      return;
    }
    otaFilesystemUnmounted = false;
    if (!restoreOtaRuntimeFiles()) {
      otaUploadFailed = true;
      otaUploadActive = false;
      request->setAttribute("error", I18n::OTA_RESTORE_FAILED);
      return; // Retain PSRAM originals for a subsequent filesystem retry.
    }
    WebUiCompatibility::refresh();
  }

  clearOtaRuntimeBackups();
  otaUploadOk = true;
  otaUploadActive = false;
  request->setAttribute("otaOk", "1");
  Serial.printf("[ota] finished %s, bytes=%u\n",
                otaFilesystemTarget ? "littlefs" : "firmware",
                static_cast<unsigned>(otaUploadedBytes));
}

static void handleOtaChunk(AsyncWebServerRequest* request,
                           uint8_t* data,
                           size_t len,
                           size_t index,
                           size_t total,
                           int command,
                           bool filesystemTarget) {
  if (index == 0 && !beginOtaUpload(request, total, command, filesystemTarget)) {
    return;
  }

  if (request->getAttribute("otaAccepted") != "1" ||
      request->getAttribute("otaGeneration") != String(otaUploadGeneration) ||
      !otaUploadActive || otaUploadFailed) return;

  otaUploadLastMs = millis();
  if (!filesystemTarget && index == 0 && len && data[0] != 0xE9) {
    failOtaUpload(request, I18n::OTA_NOT_FIRMWARE_BIN);
    return;
  }

  if (len && Update.write(data, len) != len) {
    failOtaUpload(request, I18n::OTA_WRITE_FAILED);
    return;
  }

  otaUploadedBytes += len;
  if (index + len >= total) {
    finishOtaUpload(request);
  }
}

static void processRebootRequest() {
  if (rebootPending && millis() >= rebootAt) {
    ESP.restart();
  }
}

static const char* resetReasonText(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return I18n::RESET_POWERON;
    case ESP_RST_EXT: return I18n::RESET_EXTERNAL;
    case ESP_RST_SW: return I18n::RESET_SOFTWARE;
    case ESP_RST_PANIC: return I18n::RESET_PANIC;
    case ESP_RST_INT_WDT: return I18n::RESET_INT_WDT;
    case ESP_RST_TASK_WDT: return I18n::RESET_TASK_WDT;
    case ESP_RST_WDT: return I18n::RESET_WDT;
    case ESP_RST_DEEPSLEEP: return I18n::RESET_DEEP_SLEEP;
    case ESP_RST_BROWNOUT: return I18n::RESET_BROWNOUT;
    case ESP_RST_SDIO: return I18n::RESET_SDIO;
    case ESP_RST_USB: return I18n::RESET_USB;
    default: return I18n::RESET_UNKNOWN;
  }
}

static int wifiQualityFromRssi(int rssi) {
  if (rssi <= -100) return 0;
  if (rssi >= -50) return 100;
  return 2 * (rssi + 100);
}

static bool settingsSavePending();

static String systemStatusJson() {
  ArtworkJson::Allocator jsonAllocator;
  JsonDocument doc(&jsonAllocator);

  PlayerStateSnapshot player = PlayerState::instance().snapshot();
  JsonObject status = doc["status"].to<JsonObject>();
  status["playing"] = player.playing;
  status["station"] = player.station;
  status["volume"] = player.volume;
  status["streamConnectionState"] = streamConnectionStateName(player.streamConnectionState);
  status["streamConnectFailures"] = player.streamConnectFailures;
  status["clients"] = ws.count();

  JsonObject wifi = doc["wifi"].to<JsonObject>();
  wifi["connected"] = WiFi.isConnected();
  wifi["ssid"] = WiFi.isConnected() ? WiFi.SSID() : "";
  wifi["ip"] = WiFi.isConnected() ? WiFi.localIP().toString() : "";
  wifi["mac"] = WiFi.macAddress();
  wifi["rssi"] = WiFi.isConnected() ? WiFi.RSSI() : 0;
  wifi["quality"] = WiFi.isConnected() ? wifiQualityFromRssi(WiFi.RSSI()) : 0;

  JsonObject mqttStatus = doc["mqtt"].to<JsonObject>();
  mqttStatus["configured"] = MqttController::instance().enabled();
  mqttStatus["connected"] = MqttController::instance().connected();
  mqttStatus["state"] = MqttController::instance().state();
  mqttStatus["stateText"] = MqttController::instance().stateText();
  mqttStatus["host"] = AppConfig::instance().mqttHost;
  mqttStatus["port"] = AppConfig::instance().mqttPort;
  mqttStatus["rootTopic"] = AppConfig::instance().mqttRootTopic;
  mqttStatus["hasAuth"] = AppConfig::instance().mqttUser.length() > 0;

  JsonObject system = doc["system"].to<JsonObject>();
  system["uptimeMs"] = millis();
  system["chipModel"] = ESP.getChipModel();
  system["version"] = APP_VERSION;
  const uint8_t* elfHash = esp_app_get_description()->app_elf_sha256;
  char buildId[10];
  snprintf(buildId, sizeof(buildId), "%02x%02x%02x%02x%x", elfHash[0], elfHash[1], elfHash[2], elfHash[3], elfHash[4] >> 4);
  system["buildId"] = buildId;
  system["webApiVersion"] = WEB_API_VERSION;
  system["chipRevision"] = ESP.getChipRevision();
  system["cpuMhz"] = ESP.getCpuFreqMHz();
  system["flashSize"] = ESP.getFlashChipSize();
  system["sdk"] = ESP.getSdkVersion();
  system["resetReason"] = static_cast<int>(esp_reset_reason());
  system["resetReasonText"] = resetReasonText(esp_reset_reason());
  system["heapFree"] = ESP.getFreeHeap();
  system["heapMinFree"] = ESP.getMinFreeHeap();
  system["settingsSavePending"] = settingsSavePending();
  system["artworkNetworkActive"] = ArtworkHttp::backgroundNetworkActive();
  system["heapLargest"] = ESP.getMaxAllocHeap();
  system["psramFree"] = ESP.getFreePsram();
  JsonObject artwork = doc["artwork"].to<JsonObject>();
  artwork["audioReady"] = ArtworkCache::instance().audioReady();
  artwork["serviceAgeMs"] = ArtworkCache::instance().serviceAgeMs();
  artwork["active"] = ArtworkCache::instance().downloadActive();
  artwork["elapsedMs"] = ArtworkCache::instance().downloadElapsedMs();
  artwork["job"] = ArtworkCache::instance().activeDownloadLabel();

  const WebUiCompatibilityInfo& webuiInfo = WebUiCompatibility::info();
  JsonObject webui = doc["webui"].to<JsonObject>();
  webui["version"] = webuiInfo.webuiVersion;
  webui["manifestPresent"] = webuiInfo.manifestPresent;
  webui["manifestValid"] = webuiInfo.manifestValid;
  webui["compatible"] = webuiInfo.compatible;
  webui["minimumApiVersion"] = webuiInfo.minimumApiVersion;
  webui["maximumApiVersion"] = webuiInfo.maximumApiVersion;
  webui["reason"] = webuiInfo.reason;

  JsonObject filesystem = doc["filesystem"].to<JsonObject>();
  const size_t fsTotal = LittleFS.totalBytes();
  const size_t fsUsed = LittleFS.usedBytes();
  filesystem["totalBytes"] = fsTotal;
  filesystem["usedBytes"] = fsUsed;
  filesystem["freeBytes"] = fsTotal > fsUsed ? fsTotal - fsUsed : 0;
  filesystem["artworkCacheBytes"] = ArtworkCache::instance().cacheBytes();
  filesystem["artworkCacheLimitBytes"] = ArtworkCache::instance().cacheLimitBytes();
  filesystem["artworkCacheTargetBytes"] = ArtworkCache::instance().cacheTargetBytes();

  String out;
  serializeJson(doc, out);
  return out;
}

static String hardwareCapabilitiesJson() {
  ArtworkJson::Allocator jsonAllocator;
  JsonDocument doc(&jsonAllocator);
  doc["schemaVersion"] = 1;
  doc["transientPlayerControls"] = true;
  doc["encoderCount"] = HardwareCapabilities::encoderCount;

  JsonObject encoder1 = doc["encoder1"].to<JsonObject>();
  encoder1["available"] = HardwareCapabilities::encoder1Available;
  encoder1["hasButton"] = HardwareCapabilities::encoder1Available && ENC1_SW_PIN >= 0;

  JsonObject encoder2 = doc["encoder2"].to<JsonObject>();
  encoder2["available"] = HardwareCapabilities::encoder2Available;
  encoder2["hasButton"] = HardwareCapabilities::encoder2Available && ENC2_SW_PIN >= 0;

  JsonObject frontLed = doc["frontRgbLed"].to<JsonObject>();
  frontLed["available"] = HardwareCapabilities::frontRgbLedAvailable;
  frontLed["type"] = HardwareCapabilities::frontRgbLedTypeName();
  frontLed["inverted"] = HardwareCapabilities::frontRgbLedAvailable && FRONT_RGB_INVERTED;

  JsonObject ir = doc["ir"].to<JsonObject>();
  ir["available"] = HardwareCapabilities::irAvailable;

  String out;
  serializeJson(doc, out);
  return out;
}

static void scheduleStateSave() {
  unsigned long due = millis() + 800;

  portENTER_CRITICAL(&stateSaveMux);
  stateSavePending = true;
  stateSaveDue = due;
  portEXIT_CRITICAL(&stateSaveMux);
}

void requestStateSave() {
  scheduleStateSave();
}

static void flushScheduledStateSave(bool force = false) {
  bool shouldSave = false;
  unsigned long now = millis();

  portENTER_CRITICAL(&stateSaveMux);
  if (stateSavePending && (force || (!controlsBeingEditedLocked() && now >= stateSaveDue))) {
    stateSavePending = false;
    shouldSave = true;
  }
  portEXIT_CRITICAL(&stateSaveMux);

  if (!shouldSave) return;

  StateStorage::instance().save();
}

static void enqueuePlayerAction(const QueuedPlayerAction& action) {
  if (action.type == ACTION_NONE) return;

  portENTER_CRITICAL(&actionMux);
  // Only merge the trailing compatible command. A release/commit is a barrier:
  // a new drag must never replace a preview before the previous drag's commit.
  if (isPureVolumeAction(action) && actionCount && !action.forceStateSave) {
    const uint8_t index = (actionHead + ACTION_QUEUE_SIZE - 1) % ACTION_QUEUE_SIZE;
    if (isPureVolumeAction(actionQueue[index]) && !actionQueue[index].forceStateSave &&
        actionQueue[index].persistState == action.persistState) {
      actionQueue[index] = action;
      portEXIT_CRITICAL(&actionMux);
      return;
    }
  }

  if (actionCount >= ACTION_QUEUE_SIZE) {
    actionTail = (actionTail + 1) % ACTION_QUEUE_SIZE;
    --actionCount;
  }
  actionQueue[actionHead] = action;
  actionHead = (actionHead + 1) % ACTION_QUEUE_SIZE;
  ++actionCount;
  portEXIT_CRITICAL(&actionMux);
}

static bool dequeuePlayerAction(QueuedPlayerAction& action) {
  bool hasAction = false;

  portENTER_CRITICAL(&actionMux);
  if (actionCount > 0) {
    action = actionQueue[actionTail];
    actionTail = (actionTail + 1) % ACTION_QUEUE_SIZE;
    --actionCount;
    hasAction = true;
  }
  portEXIT_CRITICAL(&actionMux);

  return hasAction;
}

bool queuePlayerCommand(const JsonDocument& cmd) {
  QueuedPlayerAction action;
  action.type = ACTION_COMMAND;
  bool hasField = false;

  if (cmd["play"].is<bool>()) {
    action.hasPlay = true;
    action.play = cmd["play"].as<bool>();
    hasField = true;
  }
  if (cmd["volume"].is<int>()) {
    action.hasVolume = true;
    action.volume = cmd["volume"].as<int>();
    hasField = true;
  }
  if (cmd["eqLow"].is<int>()) {
    action.hasEqLow = true;
    action.eqLow = cmd["eqLow"].as<int>();
    hasField = true;
  }
  if (cmd["eqMid"].is<int>()) {
    action.hasEqMid = true;
    action.eqMid = cmd["eqMid"].as<int>();
    hasField = true;
  }
  if (cmd["eqHigh"].is<int>()) {
    action.hasEqHigh = true;
    action.eqHigh = cmd["eqHigh"].as<int>();
    hasField = true;
  }
  if (cmd["balance"].is<int>()) {
    action.hasBalance = true;
    action.balance = cmd["balance"].as<int>();
    hasField = true;
  }
  if (cmd["station"].is<int>()) {
    action.hasStation = true;
    action.stationId = cmd["station"].as<int>();
    hasField = true;
  }

  if (!hasField) return false;
  // Web sliders may preview only volume/EQ/balance without persisting. Normal
  // commands (including MQTT/older web UIs) keep their previous save behavior.
  if (!action.hasPlay && !action.hasStation && cmd["persist"].is<bool>()) {
    action.persistState = cmd["persist"].as<bool>();
    action.forceStateSave = action.persistState; // The final value may already be live.
  }
  enqueuePlayerAction(action);
  return true;
}

static void queueLoadStation(int stationId, bool resetMetadata) {
  QueuedPlayerAction action;
  action.type = ACTION_LOAD_STATION;
  action.stationId = stationId;
  action.resetMetadata = resetMetadata;
  enqueuePlayerAction(action);
}

static void queueDeleteStation(int stationId, int fallbackId, bool playAfterDelete) {
  QueuedPlayerAction action;
  action.type = ACTION_DELETE_STATION;
  action.stationId = stationId;
  action.fallbackId = fallbackId;
  action.playAfterDelete = playAfterDelete;
  enqueuePlayerAction(action);
}

static bool ensureDir(const char* path) {
  return LittleFS.exists(path) || LittleFS.mkdir(path);
}

static bool isPngFile(const String& path) {
  File file = LittleFS.open(path, "r");
  if (!file) return false;

  uint8_t signature[8];
  bool ok = file.read(signature, sizeof(signature)) == sizeof(signature) &&
            signature[0] == 0x89 &&
            signature[1] == 'P' &&
            signature[2] == 'N' &&
            signature[3] == 'G';
  file.close();
  return ok;
}

static bool commitLogoUpload(const String& tempPath, const String& targetPath, String& error) {
  if (!tempPath.length() || !targetPath.length() || !LittleFS.exists(tempPath) || !isPngFile(tempPath)) {
    if (tempPath.length() && LittleFS.exists(tempPath)) LittleFS.remove(tempPath);
    error = "Invalid PNG";
    return false;
  }

  String backupPath = targetPath + ".bak";
  if (LittleFS.exists(backupPath)) LittleFS.remove(backupPath);

  bool hadTarget = LittleFS.exists(targetPath);
  if (hadTarget && !LittleFS.rename(targetPath, backupPath)) {
    LittleFS.remove(tempPath);
    error = "Existing logo backup failed";
    return false;
  }

  if (!LittleFS.rename(tempPath, targetPath)) {
    if (hadTarget && LittleFS.exists(backupPath)) {
      LittleFS.rename(backupPath, targetPath);
    }
    LittleFS.remove(tempPath);
    error = "Logo replace failed";
    return false;
  }

  ArtworkCache::instance().invalidateLcdThumbnail(targetPath);
  if (LittleFS.exists(backupPath)) LittleFS.remove(backupPath);
  return true;
}

static void removeLocalLogoWithThumbnail(const String& path) {
  if (!path.length()) return;
  ArtworkCache::instance().invalidateLcdThumbnail(path);
  if (LittleFS.exists(path)) LittleFS.remove(path);
}

static bool supportedLogoExtension(const String& filename) {
  String lower = filename;
  lower.toLowerCase();
  return lower.endsWith(".png") ||
         lower.endsWith(".jpg") ||
         lower.endsWith(".jpeg") ||
         lower.endsWith(".bmp");
}

static String safeLogoFilename(String filename) {
  filename.replace("\\", "/");
  int slash = filename.lastIndexOf('/');
  if (slash >= 0) filename = filename.substring(slash + 1);
  filename.trim();
  if (!filename.length() || !supportedLogoExtension(filename)) return "";

  String safe;
  safe.reserve(filename.length());
  for (size_t i = 0; i < filename.length(); ++i) {
    char c = filename[i];
    bool ok = (c >= 'a' && c <= 'z') ||
              (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') ||
              c == '.' || c == '-' || c == '_';
    safe += ok ? c : '-';
  }

  while (safe.indexOf("..") >= 0) {
    safe.replace("..", ".");
  }
  safe.trim();
  if (!safe.length() || safe[0] == '.') return "";
  return safe;
}

static bool appendSlugCodepoint(String& out, uint32_t cp) {
  char mapped = 0;
  if (cp >= 'A' && cp <= 'Z') {
    mapped = static_cast<char>(cp - 'A' + 'a');
  } else if ((cp >= 'a' && cp <= 'z') || (cp >= '0' && cp <= '9')) {
    mapped = static_cast<char>(cp);
  } else {
    switch (cp) {
      case 0x00C1:
      case 0x00E1:
        mapped = 'a';
        break;
      case 0x00C9:
      case 0x00E9:
        mapped = 'e';
        break;
      case 0x00CD:
      case 0x00ED:
        mapped = 'i';
        break;
      case 0x00D3:
      case 0x00F3:
      case 0x00D6:
      case 0x00F6:
      case 0x0150:
      case 0x0151:
        mapped = 'o';
        break;
      case 0x00DA:
      case 0x00FA:
      case 0x00DC:
      case 0x00FC:
      case 0x0170:
      case 0x0171:
        mapped = 'u';
        break;
      default:
        break;
    }
  }

  if (mapped) {
    out += mapped;
    return true;
  }

  if (!out.length() || out[out.length() - 1] != '-') out += '-';
  return false;
}

static uint32_t readUtf8Codepoint(const String& text, size_t& index) {
  uint8_t c = static_cast<uint8_t>(text[index++]);
  if (c < 0x80) return c;
  if ((c & 0xE0) == 0xC0 && index < text.length()) {
    uint8_t c1 = static_cast<uint8_t>(text[index]);
    if ((c1 & 0xC0) == 0x80) {
      ++index;
      return ((c & 0x1F) << 6) | (c1 & 0x3F);
    }
  }
  if ((c & 0xF0) == 0xE0 && index + 1 < text.length()) {
    uint8_t c1 = static_cast<uint8_t>(text[index]);
    uint8_t c2 = static_cast<uint8_t>(text[index + 1]);
    if ((c1 & 0xC0) == 0x80 && (c2 & 0xC0) == 0x80) {
      index += 2;
      return ((c & 0x0F) << 12) | ((c1 & 0x3F) << 6) | (c2 & 0x3F);
    }
  }
  return '-';
}

static String stationNameSlug(const String& name, size_t maxLen = 32) {
  String slug;
  slug.reserve(maxLen);

  for (size_t i = 0; i < name.length() && slug.length() < maxLen; ) {
    uint32_t cp = readUtf8Codepoint(name, i);
    appendSlugCodepoint(slug, cp);
  }

  while (slug.endsWith("-")) {
    slug.remove(slug.length() - 1);
  }
  while (slug.startsWith("-")) {
    slug.remove(0, 1);
  }
  while (slug.indexOf("--") >= 0) {
    slug.replace("--", "-");
  }
  if (slug.length() > maxLen) {
    slug = slug.substring(0, maxLen);
    while (slug.endsWith("-")) {
      slug.remove(slug.length() - 1);
    }
    while (slug.startsWith("-")) {
      slug.remove(0, 1);
    }
  }
  return slug;
}

static String stationLogoUploadPath(int id) {
  Station station;
  String slug;
  if (StationManager::instance().getStation(id, station)) {
    const String prefix = "/logos/station-" + String(id);
    if ((station.logo.startsWith(prefix + "-") || station.logo == prefix + ".png") &&
        station.logo.endsWith(".png") && station.logo.indexOf('/', 7) < 0 && station.logo.indexOf("..") < 0) {
      return station.logo; // Repair/replace this station's existing generated path in place.
    }
    slug = stationNameSlug(station.name);
  }

  String path = "/logos/station-" + String(id);
  if (slug.length()) path += "-" + slug;
  path += ".png";
  return path;
}

static int stationIdFromLogoUploadPath(const String& path) {
  const String prefix = "/logos/station-";
  if (!path.startsWith(prefix)) return -1;

  size_t index = prefix.length();
  long id = 0;
  bool hasDigit = false;
  while (index < path.length()) {
    char c = path[index++];
    if (c < '0' || c > '9') break;
    hasDigit = true;
    id = id * 10 + (c - '0');
    if (id > INT_MAX) return -1;
  }
  return hasDigit ? static_cast<int>(id) : -1;
}

static void removeOldStationLogoUploads(int id, const String& keepPath) {
  if (!LittleFS.exists("/logos")) return;

  String exact = "/logos/station-" + String(id) + ".png";
  String prefix = "/logos/station-" + String(id) + "-";

  File root = LittleFS.open("/logos");
  if (!root || !root.isDirectory()) return;

  File file = root.openNextFile();
  while (file) {
    if (!file.isDirectory()) {
      String path = file.path();
      if (!path.length()) path = file.name();
      String lower = path;
      lower.toLowerCase();
      bool owned = path == exact || (path.startsWith(prefix) && lower.endsWith(".png"));
      file.close();
      if (owned && path != keepPath) {
        removeLocalLogoWithThumbnail(path);
      }
    } else {
      file.close();
    }
    file = root.openNextFile();
  }
  root.close();
}

static String logoBasename(String path) {
  path.replace("\\", "/");
  int slash = path.lastIndexOf('/');
  return slash >= 0 ? path.substring(slash + 1) : path;
}

static void onWsEvent(
  AsyncWebSocket *server,
  AsyncWebSocketClient *client,
  AwsEventType type,
  void *arg,
  uint8_t *data,
  size_t len
) {
  if (type == WS_EVT_DISCONNECT) { setWebControlEditing(client->id(), false); return; }
  if (type == WS_EVT_CONNECT) {
    String stateJson = cachedStateJson();
    if (!stateJson.length()) stateJson = PlayerState::instance().toJson();
    client->text(stateJson);
    return;
  }

  if (type == WS_EVT_DATA) {
    AwsFrameInfo *info = (AwsFrameInfo*)arg;
    if (!info->final || info->opcode != WS_TEXT) return;

    ArtworkJson::Allocator jsonAllocator;
    JsonDocument cmd(&jsonAllocator);
    if (deserializeJson(cmd, data, len) != DeserializationError::Ok) return;
    if (!cmd["ping"].isNull()) {
      client->text("{\"pong\":true}");
      return;
    }
    if (cmd["controlEdit"].is<bool>()) {
      setWebControlEditing(client->id(), cmd["controlEdit"].as<bool>());
      return;
    }
    requestDisplayActivity();
    queuePlayerCommand(cmd);
  }
}

static bool applyQueuedCommand(const QueuedPlayerAction& action) {
  int preparedStationId = -1;
  String preparedArtworkPath;
  bool shouldDeferPlayback = false;

  if (action.hasPlay && action.play) {
    // Cancel idle artwork before the new playback state reaches the audio
    // task, reducing the chance of a TLS handshake racing the audio connect.
    ArtworkCache::instance().cancelIdlePrewarm();
  }

  bool changed = false;
  if (action.hasPlay) {
    if (!action.play) {
      ArtworkCache::instance().cancelPendingPlayback();
    } else {
      PlayerStateSnapshot state = PlayerState::instance().snapshot();
      preparedStationId = action.hasStation ? action.stationId : state.stationId;
      bool artworkReady = preparedStationId >= 0 &&
                          ArtworkCache::instance().stationArtworkReady(preparedStationId, &preparedArtworkPath);
      ArtworkCache::instance().cancelPendingPlayback();
      bool switchingStation = state.playing &&
                              action.hasStation &&
                              action.stationId >= 0 &&
                              action.stationId != state.stationId;
      if (switchingStation && !artworkReady) {
        Display::instance().notifyActivity();
        JsonDocument stopCmd;
        stopCmd["play"] = false;
        changed |= PlayerState::instance().applyCommand(stopCmd);
        Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
        vTaskDelay(pdMS_TO_TICKS(80));
        state = PlayerState::instance().snapshot();
      }

      // Audio playback must not wait for a remote logo or its LCD thumbnail.
      // Artwork continues in the background and updates the display when ready.
      shouldDeferPlayback = false;
    }
  }

  JsonDocument cmd;
  if (action.hasPlay) cmd["play"] = shouldDeferPlayback ? false : action.play;
  if (action.hasVolume) cmd["volume"] = action.volume;
  if (action.hasEqLow) cmd["eqLow"] = action.eqLow;
  if (action.hasEqMid) cmd["eqMid"] = action.eqMid;
  if (action.hasEqHigh) cmd["eqHigh"] = action.eqHigh;
  if (action.hasBalance) cmd["balance"] = action.balance;
  if (action.hasStation) cmd["station"] = action.stationId;
  changed |= PlayerState::instance().applyCommand(cmd);

  if (shouldDeferPlayback && !ArtworkCache::instance().deferStationPlayback(preparedStationId)) {
    JsonDocument resumeCmd;
    resumeCmd["play"] = true;
    changed |= PlayerState::instance().applyCommand(resumeCmd);
  }

  if (preparedStationId >= 0 && preparedArtworkPath.length()) {
    PlayerStateSnapshot state = PlayerState::instance().snapshot();
    if (state.stationId == preparedStationId && state.cachedArtworkPath != preparedArtworkPath) {
      PlayerState::instance().setCachedArtworkPath(preparedArtworkPath);
      Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
      changed = true;
    }
  }

  return changed;
}

static bool stopCurrentPlaybackForDelete() {
  if (!PlayerState::instance().snapshot().playing) return false;

  JsonDocument stopCmd;
  stopCmd["play"] = false;
  return PlayerState::instance().applyCommand(stopCmd);
}

static bool commitPendingDelete() {
  if (!pendingDelete.active || millis() < pendingDelete.commitAt) return false;

  PendingDelete op = pendingDelete;
  pendingDelete = PendingDelete();

  bool deleted = StationManager::instance().deleteStation(op.stationId);
  if (!deleted) return false;
  removeOldStationLogoUploads(op.stationId, "");

  PlayerStateSnapshot state = PlayerState::instance().snapshot();
  bool changed = false;

  if (state.stationId == op.stationId) {
    if (op.fallbackId >= 0) {
      JsonDocument nextCmd;
      nextCmd["station"] = op.fallbackId;
      nextCmd["play"] = op.playAfterDelete;
      changed = PlayerState::instance().applyCommand(nextCmd);
    } else {
      changed = PlayerState::instance().clearStation();
    }
  }

  if (changed) {
    scheduleStateSave();
    broadcastState();
  }
  return true;
}

struct StationLogoUploadBuffer {
  size_t size;
  size_t received;
  uint8_t bytes[1];
};

struct StationSaveJob {
  AsyncWebServerRequestPtr request;
  String name;
  String url;
  String logo;
  int id = -1;
  int outId = -1;
  bool saved = false;
  bool done = false;
  bool started = false;
  bool memoryClaimed = false;
  int errorStatus = 500;
  bool prepareLogo = true;
  StationLogoUploadBuffer* upload = nullptr;
  String error;
  uint32_t elapsedMs = 0;
  ~StationSaveJob() {
    free(upload);
    if (memoryClaimed) ArtworkMemory::gate().endStationSave();
  }
};

static portMUX_TYPE stationSaveMux = portMUX_INITIALIZER_UNLOCKED;
static StationSaveJob* pendingStationSave = nullptr;
static constexpr uint32_t STATION_SAVE_TASK_STACK = 6144;

static bool storeStationLogo(StationSaveJob& job) {
  job.logo = stationLogoUploadPath(job.id);
  const String tempPath = job.logo + ".upload";
  if (!ensureDir("/logos")) { job.error = "Logo directory unavailable"; return false; }
  if (LittleFS.exists(tempPath)) LittleFS.remove(tempPath);
  File file = LittleFS.open(tempPath, "w");
  if (!file) { job.error = "Logo file open failed"; return false; }
  bool ok = true;
  for (size_t offset = 0; offset < job.upload->size;) {
    const size_t count = min(static_cast<size_t>(4096), job.upload->size - offset);
    if (file.write(job.upload->bytes + offset, count) != count) { ok = false; break; }
    offset += count;
    vTaskDelay(1);
  }
  file.flush();
  file.close();
  if (!ok) {
    LittleFS.remove(tempPath);
    job.error = "Logo write failed";
    return false;
  }
  if (!commitLogoUpload(tempPath, job.logo, job.error)) return false;
  removeOldStationLogoUploads(job.id, job.logo);
  return true;
}

static void stationSaveTask(void* parameter) {
  auto* job = static_cast<StationSaveJob*>(parameter);
  const uint32_t startedMs = millis();
  // An aborted request which never started must not create a station. Once
  // writing has begun, finish the atomic commit even if the browser goes away.
  if (!job->request.expired()) {
    if (job->upload) job->saved = storeStationLogo(*job);
    else job->saved = StationManager::instance().saveStation(job->id, job->name, job->url, job->logo, job->outId);
  }
  job->elapsedMs = millis() - startedMs;
  portENTER_CRITICAL(&stationSaveMux);
  job->done = true;
  portEXIT_CRITICAL(&stationSaveMux);
  vTaskDelete(nullptr); // The main loop owns and releases the completed job.
}

static void startStationSaveJob(AsyncWebServerRequest* request, StationSaveJob* job) {
  // Copy the request's data; only the library's weak continuation pointer may
  // outlive its handler. At most one job/stack can be admitted at a time.
  bool admitted = false;
  portENTER_CRITICAL(&stationSaveMux);
  if (!pendingStationSave) {
    pendingStationSave = job;
    admitted = true;
  }
  portEXIT_CRITICAL(&stationSaveMux);
  if (!admitted) {
    delete job;
    request->send(503, "text/plain", "Another station save is in progress");
    return;
  }
  job->request = request->pause();
  // No worker stack is allocated in the request handler. The main loop starts
  // it once album preparation has released the shared memory gate.
}

static void dispatchPendingStationSave() {
  StationSaveJob* job = nullptr;
  portENTER_CRITICAL(&stationSaveMux);
  if (pendingStationSave && !pendingStationSave->started && !pendingStationSave->done) job = pendingStationSave;
  portEXIT_CRITICAL(&stationSaveMux);
  if (!job) return;
  if (job->request.expired()) {
    job->done = true;
    return;
  }
  if (!ArtworkMemory::gate().beginStationSave()) return;
  job->memoryClaimed = true;
  job->started = true;
  // AsyncTCP runs above the audio tasks. Flash I/O must not execute there or
  // inherit its priority; this short-lived worker runs below audio on either CPU.
  if (xTaskCreatePinnedToCore(stationSaveTask, "station-save", STATION_SAVE_TASK_STACK,
                             job, 0, nullptr, tskNO_AFFINITY) != pdPASS) {
    job->errorStatus = 503;
    job->error = "Station save task unavailable";
    job->done = true;
  }
}

static void queueStationSave(AsyncWebServerRequest* request, int id, const String& name,
                             const String& url, const String& logo, bool prepareLogo) {
  auto* job = new (std::nothrow) StationSaveJob;
  if (!job) { request->send(503, "text/plain", "Station save memory unavailable"); return; }
  job->id = id;
  job->name = name;
  job->url = url;
  job->logo = logo;
  job->prepareLogo = prepareLogo;
  startStationSaveJob(request, job);
}

static void completeStationSave() {
  StationSaveJob* completed = nullptr;
  portENTER_CRITICAL(&stationSaveMux);
  if (pendingStationSave && pendingStationSave->done) {
    completed = pendingStationSave;
    pendingStationSave = nullptr;
  }
  portEXIT_CRITICAL(&stationSaveMux);
  if (!completed) return;
  std::unique_ptr<StationSaveJob> job(completed);
  if (job->saved) {
    if (job->prepareLogo && job->logo.length()) ArtworkCache::instance().requestPrewarm(job->logo, true);
    if (!job->upload) {
      const auto state = PlayerState::instance().snapshot();
      if (state.stationId == job->outId) queueLoadStation(job->outId, state.streamUrl != job->url);
    }
    Serial.printf("[stations] %s saved #%d in %lums\n", job->upload ? "logo" : "station",
                  job->upload ? job->id : job->outId, static_cast<unsigned long>(job->elapsedMs));
  }
  if (auto request = job->request.lock()) {
    if (job->saved) {
      ArtworkJson::Allocator jsonAllocator;
      JsonDocument doc(&jsonAllocator);
      if (job->upload) doc["path"] = job->logo;
      else doc["id"] = job->outId;
      String out;
      serializeJson(doc, out);
      request->send(200, "application/json", out);
    } else {
      request->send(job->errorStatus, "text/plain", job->error.length() ? job->error : "Failed to save station");
    }
  }
}

static uint32_t activeStationLogoUpload = 0;
static uint32_t stationLogoUploadSequence = 0;

static void releaseStationLogoUpload(uint32_t token) {
  portENTER_CRITICAL(&stationSaveMux);
  if (activeStationLogoUpload == token) activeStationLogoUpload = 0;
  portEXIT_CRITICAL(&stationSaveMux);
}

static void receiveStationLogo(AsyncWebServerRequest* request, uint8_t* data, size_t len,
                                size_t index, size_t total) {
  if (request->hasAttribute("error")) return;
  if (index == 0) {
    static constexpr size_t MAX_LOGO_UPLOAD_BYTES = 120 * 1024;
    if (!request->hasParam("id") || request->getParam("id")->value().toInt() < 0 ||
        total < 8 || total > MAX_LOGO_UPLOAD_BYTES) {
      request->setAttribute("error", "Invalid logo upload"); return;
    }
    uint32_t token = 0;
    portENTER_CRITICAL(&stationSaveMux);
    if (!activeStationLogoUpload) {
      if (++stationLogoUploadSequence == 0) ++stationLogoUploadSequence;
      activeStationLogoUpload = token = stationLogoUploadSequence;
    }
    portEXIT_CRITICAL(&stationSaveMux);
    if (!token) { request->setAttribute("error", "Another logo upload is active"); return; }
    auto* upload = static_cast<StationLogoUploadBuffer*>(heap_caps_malloc(
        offsetof(StationLogoUploadBuffer, bytes) + total, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!upload) {
      releaseStationLogoUpload(token);
      request->setAttribute("error", "Logo PSRAM unavailable"); return;
    }
    upload->size = total;
    upload->received = 0;
    // The library frees _tempObject on disconnect; transfer it to the worker
    // only once the full, validated request body has arrived. No flash I/O here.
    request->_tempObject = upload;
    request->setAttribute("logoToken", String(token).c_str());
    request->onDisconnect([token]() { releaseStationLogoUpload(token); });
  }
  auto* upload = static_cast<StationLogoUploadBuffer*>(request->_tempObject);
  if (!upload || total != upload->size || index != upload->received ||
      index > total || len > total - index) {
    request->setAttribute("error", "Incomplete logo upload"); return;
  }
  memcpy(upload->bytes + index, data, len);
  upload->received += len;
}

static void discardStationLogoUpload(AsyncWebServerRequest* request) {
  free(request->_tempObject);
  request->_tempObject = nullptr;
}

static void queueStationLogoUpload(AsyncWebServerRequest* request) {
  const uint32_t token = strtoul(request->getAttribute("logoToken").c_str(), nullptr, 10);
  releaseStationLogoUpload(token);
  const String error = request->getAttribute("error");
  if (error.length()) {
    discardStationLogoUpload(request);
    request->send(400, "text/plain", error); return;
  }
  auto* upload = static_cast<StationLogoUploadBuffer*>(request->_tempObject);
  const uint8_t pngSignature[8] = {0x89, 'P', 'N', 'G', 13, 10, 26, 10};
  if (!request->hasParam("id") || !upload || upload->size < sizeof(pngSignature) ||
      upload->received != upload->size || memcmp(upload->bytes, pngSignature, sizeof(pngSignature)) != 0) {
    discardStationLogoUpload(request);
    request->send(400, "text/plain", "Invalid PNG"); return;
  }
  auto* job = new (std::nothrow) StationSaveJob;
  if (!job) {
    discardStationLogoUpload(request);
    request->send(503, "text/plain", "Logo save memory unavailable"); return;
  }
  job->id = request->getParam("id")->value().toInt();
  job->upload = upload;
  request->_tempObject = nullptr; // The job destructor now owns the PSRAM buffer.
  startStationSaveJob(request, job);
}

static void executeQueuedAction(const QueuedPlayerAction& action) {
  bool changed = false;

  switch (action.type) {
    case ACTION_COMMAND:
      changed = applyQueuedCommand(action);
      break;

    case ACTION_LOAD_STATION:
      changed = PlayerState::instance().loadStation(action.stationId, action.resetMetadata);
      break;

    case ACTION_CLEAR_STATION:
      changed = PlayerState::instance().clearStation();
      break;

    case ACTION_DELETE_STATION: {
      if (pendingDelete.active) {
        enqueuePlayerAction(action);
        return;
      }
      PlayerStateSnapshot state = PlayerState::instance().snapshot();
      if (state.stationId == action.stationId && state.playing) {
        changed = stopCurrentPlaybackForDelete();
        pendingDelete.active = true;
        pendingDelete.stationId = action.stationId;
        pendingDelete.fallbackId = action.fallbackId;
        pendingDelete.playAfterDelete = action.playAfterDelete;
        pendingDelete.commitAt = millis() + 180;
      } else {
        pendingDelete.active = true;
        pendingDelete.stationId = action.stationId;
        pendingDelete.fallbackId = action.fallbackId;
        pendingDelete.playAfterDelete = action.playAfterDelete;
        pendingDelete.commitAt = millis();
      }
      break;
    }

    case ACTION_NONE:
    default:
      break;
  }

  if ((changed && action.persistState) || action.forceStateSave) scheduleStateSave();
  if (changed || action.forceStateSave) {
    broadcastState();
  }
}

struct SettingsSaveJob {
  ArtworkJson::Allocator allocator;
  JsonDocument doc{&allocator};
  std::weak_ptr<AsyncWebServerRequest> request;
  uint32_t startedMs = 0;
  bool replied = false;
};
static SettingsSaveJob* pendingSettingsSave = nullptr;
static portMUX_TYPE settingsSaveMux = portMUX_INITIALIZER_UNLOCKED;
static constexpr uint32_t SETTINGS_SAVE_WAIT_MS = 15000;

static bool settingsSavePending() {
  portENTER_CRITICAL(&settingsSaveMux);
  const bool pending = pendingSettingsSave != nullptr;
  portEXIT_CRITICAL(&settingsSaveMux);
  return pending;
}

static bool queueSettingsSave(AsyncWebServerRequest* request, SettingsSaveJob* job) {
  if (!job || job->doc.overflowed()) return false;
  // Without pause(), the server auto-sends 501 when this handler returns.
  // Publish only after the request is paused, just like station-save jobs.
  job->request = request->pause();
  job->startedMs = millis();
  portENTER_CRITICAL(&settingsSaveMux);
  const bool accepted = !pendingSettingsSave && !otaUploadActive && !rebootPending;
  if (accepted) {
    ArtworkHttp::reserveSettingsSave();
    pendingSettingsSave = job;
  }
  portEXIT_CRITICAL(&settingsSaveMux);
  return accepted;
}

static void processSettingsSave() {
  portENTER_CRITICAL(&settingsSaveMux);
  SettingsSaveJob* job = pendingSettingsSave;
  portEXIT_CRITICAL(&settingsSaveMux);
  if (!job) return;
  if (job->request.expired()) {
    portENTER_CRITICAL(&settingsSaveMux);
    pendingSettingsSave = nullptr;
    ArtworkHttp::releaseSettingsSave();
    portEXIT_CRITICAL(&settingsSaveMux);
    delete job;
    return;
  }
  const bool timedOut = millis() - job->startedMs >= SETTINGS_SAVE_WAIT_MS;
  if (job->replied) {
    // Keep TLS out until the response has drained too. Weak ownership never
    // prolongs the HTTP request or replaces its disconnect callback.
    if (timedOut) {
      if (auto request = job->request.lock()) {
        // abort() deliberately does nothing once a reply has been sent.
        if (auto* client = request->client()) client->close(true);
      }
    }
    return;
  }
  if (ArtworkHttp::backgroundNetworkActive() && !timedOut && !otaUploadActive && !rebootPending) return;
  if (auto request = job->request.lock()) {
    int status = 200;
    String response;
    const String previousLastFmApiKey = AppConfig::instance().lastFmApiKey;
    if (timedOut || otaUploadActive || rebootPending) {
      status = 503;
      response = "Settings save temporarily unavailable";
    } else if (!AppConfig::instance().applyJson(job->doc)) {
      status = 400;
      response = "Invalid remote layout or IR profile";
    } else if (!AppConfig::instance().save()) {
      status = 500;
      response = "Failed to save config";
    } else {
      if (previousLastFmApiKey != AppConfig::instance().lastFmApiKey) {
        ArtworkCache::instance().retryCurrentAlbumLookup();
      }
      AppConfig::instance().applyTimeZone();
      StatusLed::instance().applyConfig();
      requestDisplayConfigRefresh();
      response = AppConfig::instance().toJson();
    }
    auto* reply = request->beginResponse(status, status == 200 ? "application/json" : "text/plain", response);
    reply->addHeader("Connection", "close");
    request->send(reply);
    job->replied = true;
    job->startedMs = millis();
  }
}

void webServerLoop() {
  processSettingsSave();
  completeStationSave();
  dispatchPendingStationSave();
  unsigned long now = millis();
  if (now - lastWsCleanupMs >= 1000) {
    lastWsCleanupMs = now;
    ws.cleanupClients();
  }
  processDisplayRequests();
  processRebootRequest();
  commitPendingDelete();

  QueuedPlayerAction action;
  uint8_t processed = 0;
  while (processed < 4 && dequeuePlayerAction(action)) {
    executeQueuedAction(action);
    ++processed;
    if (pendingDelete.active) break;
  }

  commitPendingDelete();
  flushScheduledStateSave();
  processDisplayRequests();
  processRebootRequest();
}

void webServerBegin() {
  Serial.println("[web] begin");
  WebUiCompatibility::refresh();
  ws.onEvent(onWsEvent);
  server.addHandler(&ws);

  server.on("/api/artwork/station", HTTP_GET, [](AsyncWebServerRequest* request) {
    if (!request->hasParam("id")) { request->send(400); return; }
    String imagePath;
    ArtworkCache& cache = ArtworkCache::instance();
    if (!cache.stationArtworkReady(request->getParam("id")->value().toInt(), &imagePath) || !imagePath.length()) {
      request->send(404); return;
    }
    const String path = cache.lcdThumbnailPath(imagePath);
    auto* response = new (std::nothrow) StationArtworkResponse(LittleFS.mountpoint(), path.c_str());
    if (!response) { request->send(503); return; }
    if (!response->_sourceValid()) { delete response; request->send(404); return; }
    response->addHeader("Cache-Control", "no-cache");
    request->send(response);
  });

  server.on("/api/stations", HTTP_GET, [](AsyncWebServerRequest* request) {
    ArtworkJson::Allocator jsonAllocator;
    JsonDocument doc(&jsonAllocator);
    JsonArray arr = doc["stations"].to<JsonArray>();
    StationManager::instance().toJson(arr);

    String out;
    serializeJson(doc, out);
    request->send(200, "application/json", out);
  });

  server.on("/api/logos", HTTP_GET, [](AsyncWebServerRequest* request) {
    ArtworkJson::Allocator jsonAllocator;
    JsonDocument doc(&jsonAllocator);
    JsonArray arr = doc["logos"].to<JsonArray>();

    const char* mount = LittleFS.mountpoint();
    char absolute[320];
    struct stat info{};
    const int length = mount ? snprintf(absolute, sizeof(absolute), "%s/logos", mount) : -1;
    if (length > 0 && static_cast<size_t>(length) < sizeof(absolute) &&
        ::stat(absolute, &info) == 0 && S_ISDIR(info.st_mode)) {
      File root = LittleFS.open("/logos");
      if (root && root.isDirectory()) {
        bool directory = false;
        String path = root.getNextFileName(&directory);
        while (path.length()) {
          if (!directory) {
            const String name = logoBasename(path);
            const int count = snprintf(absolute, sizeof(absolute), "%s/logos/%s", mount, name.c_str());
            // Directory enumeration must not fopen() every logo: that creates
            // newlib FILE mutexes even though only name and size are needed.
            if (supportedLogoExtension(name) && count > 0 && static_cast<size_t>(count) < sizeof(absolute) &&
                ::stat(absolute, &info) == 0 && S_ISREG(info.st_mode)) {
              JsonObject item = arr.add<JsonObject>();
              item["name"] = name;
              item["path"] = "/logos/" + name;
              item["size"] = static_cast<uint32_t>(info.st_size);
            }
          }
          path = root.getNextFileName(&directory);
        }
        root.close();
      }
    }

    if (doc.overflowed()) { request->send(503, "text/plain", "Logo list memory unavailable"); return; }
    String out;
    serializeJson(doc, out);
    request->send(200, "application/json", out);
  });

  server.on("/api/station/save", HTTP_POST, [](AsyncWebServerRequest* request) {
    requestDisplayActivity();
    if (!request->hasParam("name", true) || !request->hasParam("url", true)) {
      request->send(400, "text/plain", "Missing name or url");
      return;
    }

    int id = -1;
    if (request->hasParam("id", true) && request->getParam("id", true)->value().length()) {
      id = request->getParam("id", true)->value().toInt();
    }

    String name = request->getParam("name", true)->value();
    String url = request->getParam("url", true)->value();
    String logo = request->hasParam("logo", true) ? request->getParam("logo", true)->value() : "";
    const bool prepareLogo = !request->hasParam("prepareLogo", true) ||
                             request->getParam("prepareLogo", true)->value() != "0";
    queueStationSave(request, id, name, url, logo, prepareLogo);
  });

  server.on("/api/station/logo/prepare", HTTP_POST, [](AsyncWebServerRequest* request) {
    if (!request->hasParam("id", true)) { request->send(400); return; }
    Station station;
    if (!StationManager::instance().getStation(request->getParam("id", true)->value().toInt(), station)) {
      request->send(404); return;
    }
    const bool queued = ArtworkCache::instance().requestPrewarm(station.logo, true);
    request->send(queued ? 202 : 503, "text/plain", queued ? "Queued" : "Logo queue unavailable");
  });

  server.on("/api/station/delete", HTTP_POST, [](AsyncWebServerRequest* request) {
    requestDisplayActivity();
    if (!request->hasParam("id", true)) {
      request->send(400, "text/plain", "Missing id");
      return;
    }

    int id = request->getParam("id", true)->value().toInt();
    PlayerStateSnapshot state = PlayerState::instance().snapshot();
    bool deletingCurrent = state.stationId == id;
    bool wasPlaying = state.playing;
    int fallbackId = -1;

    if (deletingCurrent) {
      int index = StationManager::instance().indexOfStation(id);
      size_t count = StationManager::instance().count();
      if (count > 1) {
        size_t fallbackIndex = 0;
        if (index >= 0 && static_cast<size_t>(index + 1) < count) {
          fallbackIndex = static_cast<size_t>(index + 1);
        } else if (index > 0) {
          fallbackIndex = static_cast<size_t>(index - 1);
        }
        StationManager::instance().stationIdAtIndex(fallbackIndex, fallbackId);
      }
    }

    if (deletingCurrent) {
      queueDeleteStation(id, fallbackId, wasPlaying && AppConfig::instance().autoStart);
      request->send(200, "text/plain", "OK");
      return;
    }

    if (!StationManager::instance().deleteStation(id)) {
      request->send(404, "text/plain", "Station not found");
      return;
    }
    removeOldStationLogoUploads(id, "");

    request->send(200, "text/plain", "OK");
  });

  server.on("/api/station/move", HTTP_POST, [](AsyncWebServerRequest* request) {
    requestDisplayActivity();
    if (!request->hasParam("id", true) || !request->hasParam("direction", true)) {
      request->send(400, "text/plain", "Missing id or direction");
      return;
    }

    int id = request->getParam("id", true)->value().toInt();
    int direction = request->getParam("direction", true)->value().toInt();
    if (!StationManager::instance().moveStation(id, direction)) {
      request->send(400, "text/plain", "Station order unchanged");
      return;
    }

    request->send(200, "text/plain", "OK");
  });

  server.on("/api/station/reorder", HTTP_POST, [](AsyncWebServerRequest* request) {
    requestDisplayActivity();
    if (!request->hasParam("order", true)) {
      request->send(400, "text/plain", "Missing order");
      return;
    }

    String order = request->getParam("order", true)->value();
    if (!StationManager::instance().reorderStations(order)) {
      request->send(400, "text/plain", "Invalid station order");
      return;
    }

    request->send(200, "text/plain", "OK");
  });

  server.on(
    "/api/logo/upload", HTTP_POST,
    [](AsyncWebServerRequest* request) { queueStationLogoUpload(request); },
    nullptr,
    [](AsyncWebServerRequest* request, uint8_t* data, size_t len, size_t index, size_t total) {
      receiveStationLogo(request, data, len, index, total);
    }
  );

  server.on(
    "/api/logos/upload",
    HTTP_POST,
    [](AsyncWebServerRequest* request) {
      String error = request->getAttribute("error");
      String countText = request->getAttribute("count");
      if (error.length()) {
        request->send(400, "application/json", "{\"ok\":false,\"error\":\"" + error + "\"}");
        return;
      }

      ArtworkJson::Allocator jsonAllocator;
      JsonDocument doc(&jsonAllocator);
      doc["ok"] = true;
      doc["count"] = countText.length() ? countText.toInt() : 0;
      String out;
      serializeJson(doc, out);
      request->send(200, "application/json", out);
    },
    [](AsyncWebServerRequest* request, const String& filename, size_t index, uint8_t* data, size_t len, bool final) {
      static File uploadFile;
      static bool fileActive = false;
      static bool fileFailed = false;
      static unsigned long uploadLastMs = 0;
      static uint16_t uploadedCount = 0;
      static size_t uploadedBytes = 0;
      static String uploadPath;
      static String uploadTempPath;
      static constexpr size_t MAX_BULK_LOGO_BYTES = 240 * 1024;
      static constexpr unsigned long UPLOAD_STALE_MS = 15000;

      if (index == 0) {
        if (request->getAttribute("started") != "1") {
          if (uploadFile) uploadFile.close();
          fileActive = false;
          fileFailed = false;
          uploadedCount = 0;
          uploadedBytes = 0;
          uploadPath = "";
          uploadTempPath = "";
          request->setAttribute("started", "1");
          request->setAttribute("count", "0");
        }

        if (fileActive && millis() - uploadLastMs > UPLOAD_STALE_MS) {
          if (uploadFile) uploadFile.close();
          if (uploadTempPath.length() && LittleFS.exists(uploadTempPath)) LittleFS.remove(uploadTempPath);
          fileActive = false;
        }

        if (fileActive) {
          request->setAttribute("error", "Another logo file is still uploading");
          fileFailed = true;
          return;
        }

        fileFailed = false;
        uploadedBytes = 0;
        uploadPath = "";
        uploadTempPath = "";
        uploadLastMs = millis();

        String cleanFilename = safeLogoFilename(filename);
        if (!cleanFilename.length() || !ensureDir("/logos")) {
          request->setAttribute("error", "Invalid logo upload");
          fileFailed = true;
          return;
        }

        uploadPath = "/logos/" + cleanFilename;
        uploadTempPath = uploadPath + ".upload";
        if (LittleFS.exists(uploadTempPath)) LittleFS.remove(uploadTempPath);
        uploadFile = LittleFS.open(uploadTempPath, "w");
        if (!uploadFile) {
          request->setAttribute("error", "Logo file open failed");
          fileFailed = true;
          return;
        }
        fileActive = true;
      }

      if (fileFailed) {
        if (final) {
          if (uploadFile) uploadFile.close();
          if (uploadTempPath.length() && LittleFS.exists(uploadTempPath)) LittleFS.remove(uploadTempPath);
          fileActive = false;
        }
        return;
      }

      uploadLastMs = millis();
      uploadedBytes += len;
      if (uploadedBytes > MAX_BULK_LOGO_BYTES) {
        request->setAttribute("error", "Logo file is too large");
        fileFailed = true;
      } else if (uploadFile && len && uploadFile.write(data, len) != len) {
        request->setAttribute("error", "Logo write failed");
        fileFailed = true;
      }

      if (final) {
        if (uploadFile) uploadFile.close();
        fileActive = false;
        if (!fileFailed) {
          String commitError;
          if (commitLogoUpload(uploadTempPath, uploadPath, commitError)) {
            uploadedCount++;
            request->setAttribute("count", String(uploadedCount).c_str());
            ArtworkCache::instance().requestPrewarm(uploadPath, false);
          } else {
            request->setAttribute("error", commitError.c_str());
            fileFailed = true;
          }
        }
        if (fileFailed && uploadTempPath.length() && LittleFS.exists(uploadTempPath)) {
          LittleFS.remove(uploadTempPath);
        }
      }
    },
    nullptr
  );

  server.on(AlbumArtStore::ROUTE, HTTP_GET, [](AsyncWebServerRequest* request) {
    if (!request->hasParam("id") || request->getParam("id")->value().length() != 17) {
      request->send(400, "text/plain", "Invalid album image id");
      return;
    }
    auto frame = AlbumArtStore::instance().acquire(
        String(AlbumArtStore::PATH_PREFIX) + request->getParam("id")->value());
    if (!frame) {
      request->send(404, "text/plain", "Album image expired");
      return;
    }
    const char* contentType = frame->format == AlbumArtPolicy::Format::Png ? "image/png" : "image/jpeg";
    // The pinned server copies each callback result into its own send buffer,
    // whose remainder survives partial TCP writes. Once all source bytes have
    // been copied, a slow ACK/keepalive must no longer pin an album pool slot.
    auto* response = request->beginResponse(contentType, frame->imageBytes,
        [frame](uint8_t* buffer, size_t maxLen, size_t index) mutable -> size_t {
          if (!frame) return 0;
          const size_t count = frame->read(buffer, maxLen, index);
          if (index >= frame->imageBytes || count >= frame->imageBytes - index) frame.reset();
          return count;
        });
    if (!response) {
      request->send(503, "text/plain", "Album response unavailable");
      return;
    }
    response->addHeader("Cache-Control", "no-store, max-age=0");
    request->send(response);
  });

  server.on(
    "/api/artwork/cache",
    HTTP_POST,
    [](AsyncWebServerRequest* request) {
      String error = request->getAttribute("error");
      String tempPath = request->getAttribute("temp");
      String sourceUrl = request->getAttribute("url");

      if (error.length()) {
        if (tempPath.length() && LittleFS.exists(tempPath)) LittleFS.remove(tempPath);
        request->send(400, "application/json", "{\"ok\":false,\"error\":\"" + error + "\"}");
        return;
      }

      if (!ArtworkCache::instance().queueBrowserArtworkImport(sourceUrl, tempPath)) {
        if (tempPath.length() && LittleFS.exists(tempPath)) LittleFS.remove(tempPath);
        request->send(503, "application/json", "{\"ok\":false,\"error\":\"Artwork cache queue busy\"}");
        return;
      }
      request->send(202, "application/json", "{\"ok\":true,\"pending\":true}");
    },
    nullptr,
    [](AsyncWebServerRequest* request, uint8_t* data, size_t len, size_t index, size_t total) {
      static File uploadFile;
      static bool uploadActive = false;
      static bool failed = false;
      static String tempPath;
      static String sourceUrl;
      static size_t uploadedBytes = 0;
      static unsigned long uploadLastMs = 0;
      static constexpr size_t MAX_BROWSER_ARTWORK_BYTES = 240 * 1024;
      static constexpr unsigned long UPLOAD_STALE_MS = 15000;

      if (index == 0) {
        if (uploadFile) uploadFile.close();
        if (uploadActive && millis() - uploadLastMs > UPLOAD_STALE_MS) {
          uploadActive = false;
        }

        failed = false;
        uploadedBytes = 0;
        tempPath = "/cache/browser-art-" + String(static_cast<unsigned long>(esp_random()), HEX) + ".tmp";
        sourceUrl = "";
        uploadLastMs = millis();
        request->setAttribute("temp", tempPath.c_str());

        if (uploadActive) {
          request->setAttribute("error", "Artwork upload already active");
          failed = true;
          return;
        }
        uploadActive = true;

        if (!request->hasParam("url") || total == 0 || total > MAX_BROWSER_ARTWORK_BYTES || !ensureDir("/cache")) {
          request->setAttribute("error", "Invalid artwork upload");
          failed = true;
          uploadActive = false;
          return;
        }

        sourceUrl = request->getParam("url")->value();
        sourceUrl.trim();
        if (!sourceUrl.startsWith("http://") && !sourceUrl.startsWith("https://")) {
          request->setAttribute("error", "Invalid artwork URL");
          failed = true;
          uploadActive = false;
          return;
        }
        request->setAttribute("url", sourceUrl.c_str());

        if (LittleFS.exists(tempPath)) LittleFS.remove(tempPath);
        uploadFile = LittleFS.open(tempPath, "w");
        if (!uploadFile) {
          request->setAttribute("error", "Artwork temp open failed");
          failed = true;
          uploadActive = false;
          return;
        }
      }

      if (failed) {
        if (index + len >= total) {
          if (uploadFile) uploadFile.close();
          if (tempPath.length() && LittleFS.exists(tempPath)) LittleFS.remove(tempPath);
          uploadActive = false;
        }
        return;
      }

      uploadLastMs = millis();
      uploadedBytes += len;
      if (uploadedBytes > MAX_BROWSER_ARTWORK_BYTES) {
        request->setAttribute("error", "Artwork upload too large");
        failed = true;
      } else if (uploadFile && len && uploadFile.write(data, len) != len) {
        request->setAttribute("error", "Artwork write failed");
        failed = true;
      }

      if (index + len >= total) {
        if (uploadFile) uploadFile.close();
        uploadActive = false;
        if (failed && tempPath.length() && LittleFS.exists(tempPath)) {
          LittleFS.remove(tempPath);
        }
      }
    }
  );

  server.on("/api/config", HTTP_GET, [](AsyncWebServerRequest* request) {
    request->send(200, "application/json", AppConfig::instance().toJson());
  });

  server.on("/api/hardware", HTTP_GET, [](AsyncWebServerRequest* request) {
    request->send(200, "application/json", hardwareCapabilitiesJson());
  });

  server.on("/api/system/status", HTTP_GET, [](AsyncWebServerRequest* request) {
    request->send(200, "application/json", systemStatusJson());
  });

#if SIMPLE_RADIO_RUNTIME_DIAGNOSTICS
  server.on("/api/diagnostics", HTTP_GET, [](AsyncWebServerRequest* request) {
    const auto s = RuntimeProbe::snapshot();
    ArtworkJson::Allocator allocator;
    JsonDocument doc(&allocator);
    doc["schema"] = 1; doc["uptimeMs"] = millis();
    doc["heapFree"] = ESP.getFreeHeap(); doc["heapLargest"] = ESP.getMaxAllocHeap();
    doc["psramFree"] = ESP.getFreePsram();
    JsonObject audio = doc["audio"].to<JsonObject>();
#define PROBE_FIELD(name) audio[#name] = s.name
    PROBE_FIELD(epoch); PROBE_FIELD(sampleRate); PROBE_FIELD(dmaFrames); PROBE_FIELD(active);
    PROBE_FIELD(starts); PROBE_FIELD(stops); PROBE_FIELD(sentFrames); PROBE_FIELD(acceptedBytes);
    PROBE_FIELD(sentBlocks); PROBE_FIELD(writes); PROBE_FIELD(partialWrites);
    PROBE_FIELD(writeTimeouts); PROBE_FIELD(writeErrors); PROBE_FIELD(sentGapMaxUs);
    PROBE_FIELD(feedGapMaxUs); PROBE_FIELD(writeMaxUs); PROBE_FIELD(feedDeadlineMisses);
    PROBE_FIELD(feedAgeUs); PROBE_FIELD(sentAgeUs); PROBE_FIELD(pumpCalls);
    PROBE_FIELD(pumpGapMaxUs); PROBE_FIELD(pumpWorkMaxUs); PROBE_FIELD(inputBytes);
    PROBE_FIELD(inputCapacity); PROBE_FIELD(inputMinBytes); PROBE_FIELD(inputSamples);
    PROBE_FIELD(inputEmptySamples);
#undef PROBE_FIELD
    String out; serializeJson(doc, out);
    request->send(200, "application/json", out);
  });
#endif

  server.on("/api/system/reboot", HTTP_POST, [](AsyncWebServerRequest* request) {
    request->send(200, "application/json", "{\"rebooting\":true}");
    requestReboot();
  });

  server.on(
    "/api/ota/firmware",
    HTTP_POST,
    [](AsyncWebServerRequest* request) {
      String error = request->getAttribute("error");
      if (error.length()) {
        request->send(400, "application/json", "{\"ok\":false,\"error\":\"" + error + "\"}");
        return;
      }
      if (request->getAttribute("otaOk") != "1") {
        request->send(400, "application/json", jsonErrorResponse(I18n::OTA_UPLOAD_INCOMPLETE));
        return;
      }
      request->send(200, "application/json", "{\"ok\":true,\"rebooting\":true}");
      requestReboot();
    },
    nullptr,
    [](AsyncWebServerRequest* request, uint8_t* data, size_t len, size_t index, size_t total) {
      handleOtaChunk(request, data, len, index, total, U_FLASH, false);
    }
  );

  server.on(
    "/api/ota/filesystem",
    HTTP_POST,
    [](AsyncWebServerRequest* request) {
      String error = request->getAttribute("error");
      if (error.length()) {
        request->send(400, "application/json", "{\"ok\":false,\"error\":\"" + error + "\"}");
        return;
      }
      if (request->getAttribute("otaOk") != "1") {
        request->send(400, "application/json", jsonErrorResponse(I18n::OTA_UPLOAD_INCOMPLETE));
        return;
      }
      request->send(200, "application/json", "{\"ok\":true,\"rebooting\":true}");
      requestReboot();
    },
    nullptr,
    [](AsyncWebServerRequest* request, uint8_t* data, size_t len, size_t index, size_t total) {
      handleOtaChunk(request, data, len, index, total, U_FLASHFS, true);
    }
  );

  server.on("/api/config/save", HTTP_POST, [](AsyncWebServerRequest* request) {
    requestDisplayActivity();
    std::unique_ptr<SettingsSaveJob> job(new (std::nothrow) SettingsSaveJob);
    if (!job) { request->send(503, "text/plain", "Failed to save config"); return; }
    JsonDocument& doc = job->doc;

    auto setBool = [&](const char* name) {
      if (request->hasParam(name, true)) {
        String value = request->getParam(name, true)->value();
        doc[name] = value == "1" || value == "true" || value == "on";
      }
    };

    auto setInt = [&](const char* name) {
      if (request->hasParam(name, true)) {
        doc[name] = request->getParam(name, true)->value().toInt();
      }
    };

    auto setString = [&](const char* name) {
      if (request->hasParam(name, true)) {
        doc[name] = request->getParam(name, true)->value();
      }
    };

    setBool("displayInvert");
    setInt("brightness");
    setBool("displayIdleEnabled");
    setBool("displayIdleBlank");
    setInt("displayIdleSeconds");
    setInt("displayIdleBrightness");
    setBool("displayClockEnabled");
    setString("displayClockStyle");
    setString("displayFooterMode");
    setString("displayArtworkMode");
    setString("lastFmApiKey");
    setBool("clearLastFmApiKey");
    setString("displayVuStyle");
    setString("themeAccent");
    setString("themeCustomColor");
    setString("timeZone");
    setBool("autoBrightness");
    setInt("dayBrightness");
    setInt("nightBrightness");
    setInt("dayStartMinute");
    setInt("nightStartMinute");
    setBool("irEnabled");
    setInt("irSensitivity");
    setString("irActionLearning");
    setString("irRemoteProfile");
    setString("irRemoteCustom");
    setString("irRemoteCodeMap");
    setString("irPrev");
    setString("irNext");
    setString("irToggle");
    setString("irVolUp");
    setString("irVolDown");
    setString("irMute");
    setString("irPower");
    setString("irUp");
    setString("irDown");
    setString("irLeft");
    setString("irRight");
    setString("irOk");
    setString("irList");
    setString("irBack");
    setString("irDigit0");
    setString("irDigit1");
    setString("irDigit2");
    setString("irDigit3");
    setString("irDigit4");
    setString("irDigit5");
    setString("irDigit6");
    setString("irDigit7");
    setString("irDigit8");
    setString("irDigit9");
    setString("irStar");
    setString("irHash");
    setString("irStation1");
    setString("irStation2");
    setString("irStation3");
    setString("irStation4");
    setString("irStation5");
    setBool("encoderEnabled");
    setBool("secondEncoderEnabled");
    setString("encoderMode");
    setInt("encoderSensitivity");
    setInt("encoderVolumeStep");
    setInt("encoderLongPressMs");
    setBool("encoderAutoPlayStation");
    setInt("encoderAutoPlayMs");
    setBool("mqttEnabled");
    setString("mqttHost");
    setInt("mqttPort");
    setString("mqttUser");
    setString("mqttPassword");
    setString("mqttRootTopic");
    setBool("streamRetryEnabled");
    setInt("streamRetryMs");
    setBool("autoStart");
    setString("volumeCurve");
    setBool("frontLedEnabled");
    setBool("frontLedUseTheme");
    setInt("frontLedBrightness");
    setInt("frontLedStandbyBrightness");
    setString("frontLedColor");

    if (!queueSettingsSave(request, job.get())) {
      request->send(503, "text/plain", "Failed to save config");
      return;
    }
    job.release(); // Main loop owns it until the completed response disconnects.
  });

  server.on("/recovery", HTTP_GET, [](AsyncWebServerRequest* request) {
    sendRecoveryPage(request);
  });

  if (WebUiCompatibility::info().compatible) {
    server.serveStatic("/", LittleFS, "/")
          .setDefaultFile("index.html")
          .setCacheControl("no-store, max-age=0");
  } else {
    Serial.printf("[webui] recovery mode: %s\n", WebUiCompatibility::info().reason.c_str());
    server.on("/", HTTP_GET, [](AsyncWebServerRequest* request) {
      sendRecoveryPage(request);
    });
    server.on("/index.html", HTTP_GET, [](AsyncWebServerRequest* request) {
      sendRecoveryPage(request);
    });
  }

  server.begin();
  Serial.println("[web] listening on port 80");
}

bool broadcastState(bool forceDisplay) {
  String s = PlayerState::instance().toJson();
  bool changed = updateCachedStateJson(s);
  if (changed) {
    ws.textAll(s);
  }
  if (changed || forceDisplay) {
    Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
  }
  return changed;
}

void notifyStationArtworkReady() {
  if (!ws.count()) return;
  // Include the complete ordinary state so older WebUIs can safely ignore the
  // extra flag. This notification does not force an LCD/player-state redraw.
  String state = PlayerState::instance().toJson();
  if (!state.endsWith("}")) return;
  state.remove(state.length() - 1);
  state += ",\"stationArtworkReady\":true}";
  ws.textAll(state);
}
