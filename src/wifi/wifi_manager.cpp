#include "wifi_manager.h"

#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>
#include <LittleFS.h>
#include <WiFi.h>
#include <atomic>

#include "../storage/atomic_file.h"

#include "../display/display.h"
#include "../display/display_presenter.h"
#include "../config/app_config.h"
#include "../config/logging.h"
#include "../i18n/i18n.h"
#include "../state/player_state.h"

static const char* WIFI_FILE = "/wifi.json";
static AsyncWebServer wifiServer(80);

struct WifiCred {
  String ssid;
  String pass;
};

static WifiCred creds[5];
static size_t credCount = 0;
static unsigned long lastReconnect = 0;

// Requests run on AsyncTCP. The main loop owns association, flash writes and
// the AP-to-station handoff. Publishing the phase transfers the pending data.
enum class PortalPhase { Off, Idle, Queued, Connecting, Connected, JoinFailed, SaveFailed };
static std::atomic<PortalPhase> portalPhase{PortalPhase::Off};
static std::atomic<uint32_t> portalAddress{0};
static std::atomic<uint32_t> acknowledgedAddress{0};
static String handoffId;
static WifiCred pendingNetwork;
static uint32_t phaseStarted = 0;

static bool acceptingNetwork(PortalPhase phase) {
  return phase == PortalPhase::Idle || phase == PortalPhase::JoinFailed || phase == PortalPhase::SaveFailed;
}

#if defined(SIMPLE_RADIO_FIXED_WIFI)
static const char* FIXED_WIFI_SSID = WIFI_TEST_SSID;
static const char* FIXED_WIFI_PASS = WIFI_TEST_PASS;
#endif

WifiManager& WifiManager::instance() {
  static WifiManager w;
  return w;
}

WifiRunMode WifiManager::mode() const {
  return _mode;
}

bool WifiManager::matchesSetupHandoff(const String& id) const {
  return handoffId.length() && id == handoffId;
}

bool WifiManager::loadCredentials() {
  JsonDocument doc;
  if (!readJsonWithBackup(WIFI_FILE, doc) || !doc.is<JsonArray>()) return false;

  credCount = 0;
  for (JsonObject obj : doc.as<JsonArray>()) {
    if (credCount >= 5) break;
    creds[credCount++] = {
      obj["ssid"].as<String>(),
      obj["pass"].as<String>()
    };
  }

  Serial.printf("Loaded %u WiFi credential(s)\n", static_cast<unsigned>(credCount));
  return credCount > 0;
}

bool WifiManager::tryConnect() {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);

  for (size_t i = 0; i < credCount; ++i) {
    Serial.print("Connecting to WiFi: ");
    Serial.println(creds[i].ssid);

    WiFi.begin(creds[i].ssid.c_str(), creds[i].pass.c_str());
    unsigned long start = millis();

    while (millis() - start < 8000) {
      if (WiFi.status() == WL_CONNECTED) {
        WiFi.setSleep(false);
        WiFi.setAutoReconnect(true);
        Serial.print("WiFi connected, IP: ");
        Serial.println(WiFi.localIP());
        return true;
      }
      delay(200);
    }

    WiFi.disconnect(false);
    delay(200);
  }

  Serial.println("WiFi connect failed");
  return false;
}

void WifiManager::startConfigPortal() {
  WiFi.persistent(false);
  WiFi.disconnect(false);
  delay(100);
  WiFi.setAutoReconnect(false);
  WiFi.mode(WIFI_AP_STA);
  handoffId = String(esp_random(), HEX);
  portalPhase = PortalPhase::Idle;
  WiFi.softAP("ESP32-WebRadio");

  IPAddress ip = WiFi.softAPIP();
  Serial.print("AP mode started, IP: ");
  Serial.println(ip);

  PlayerState& ps = PlayerState::instance();
  ps.playing = false;
  ps.station = I18n::WIFI_SETUP_TITLE;
  ps.artist = I18n::WIFI_NO_SAVED_NETWORK;
  ps.title = I18n::WIFI_CONNECT_PROMPT;
  ps.bitrate = ip.toString();
  Display::instance().render(DisplayPresenter::build(ps));

  wifiServer.on("/", HTTP_GET, [](AsyncWebServerRequest* r) {
    r->send(LittleFS, "/wifi.html", "text/html");
  }).setFilter(ON_AP_FILTER);

  wifiServer.on("/scan", HTTP_GET, [](AsyncWebServerRequest* r) {
    if (!acceptingNetwork(portalPhase.load())) { r->send(409); return; }
    const bool details = r->hasParam("details");
    int count = WiFi.scanComplete();
    if (!details) {
      // Keep the original array-of-names contract for older setup clients.
      count = WiFi.scanNetworks();
    } else if (r->hasParam("fresh") && count != WIFI_SCAN_RUNNING) {
      count = WiFi.scanNetworks(true);
    }
    if (count == WIFI_SCAN_RUNNING) { r->send(202, "application/json", "[]"); return; }
    if (count < 0) { r->send(503, "application/json", "[]"); return; }
    JsonDocument doc;
    JsonArray networks = doc.to<JsonArray>();
    for (int i = 0; i < count; ++i) {
      String ssid = WiFi.SSID(i);
      if (!ssid.length()) continue;
      if (details) {
        JsonObject network = networks.add<JsonObject>();
        network["ssid"] = ssid;
        network["rssi"] = WiFi.RSSI(i);
        network["open"] = WiFi.encryptionType(i) == WIFI_AUTH_OPEN;
      } else {
        networks.add(ssid);
      }
    }
    String out;
    serializeJson(doc, out);
    r->send(200, "application/json", out);
  }).setFilter(ON_AP_FILTER);

  wifiServer.on("/save", HTTP_POST, [](AsyncWebServerRequest* r) {
    if (!acceptingNetwork(portalPhase.load()) || WiFi.scanComplete() == WIFI_SCAN_RUNNING) {
      r->send(409); return;
    }
    String ssid = r->hasParam("ssid", true) ? r->getParam("ssid", true)->value() : "";
    String pass = r->hasParam("pass", true) ? r->getParam("pass", true)->value() : "";
    if (!ssid.length() || ssid.length() > 32 || pass.length() > 64) { r->send(400); return; }
    pendingNetwork = {ssid, pass};
    portalPhase = PortalPhase::Queued;
    r->send(202, "application/json", "{\"state\":\"connecting\"}");
  }).setFilter(ON_AP_FILTER);

  wifiServer.on("/setup/status", HTTP_GET, [](AsyncWebServerRequest* r) {
    JsonDocument doc;
    const AppConfig& config = AppConfig::instance();
    doc["themeAccent"] = config.themeAccent;
    if (config.themeAccent == "custom") doc["themeCustomColor"] = config.themeCustomColor;
    switch (portalPhase.load()) {
      case PortalPhase::Connected:
        doc["state"] = "connected";
        doc["ip"] = IPAddress(portalAddress.load()).toString();
        doc["id"] = handoffId;
        break;
      case PortalPhase::Queued:
      case PortalPhase::Connecting: doc["state"] = "connecting"; break;
      case PortalPhase::JoinFailed: doc["state"] = "join_failed"; break;
      case PortalPhase::SaveFailed: doc["state"] = "save_failed"; break;
      default: doc["state"] = "idle"; break;
    }
    String body;
    serializeJson(doc, body);
    auto* response = r->beginResponse(200, "application/json", body);
    response->addHeader("Cache-Control", "no-store");
    r->send(response);
  }).setFilter(ON_AP_FILTER);
  wifiServer.on("/setup/finish", HTTP_POST, [](AsyncWebServerRequest* r) {
    IPAddress received;
    if (portalPhase != PortalPhase::Connected || !r->hasParam("ip", true) ||
        !received.fromString(r->getParam("ip", true)->value()) || uint32_t(received) != portalAddress.load()) {
      r->send(409); return;
    }
    acknowledgedAddress = uint32_t(received);
    r->send(204);
  }).setFilter(ON_AP_FILTER);

  for (const char* asset : {"/wifi.css", "/wifi.js", "/theme.js", "/i18n-catalog.js", "/i18n.js", "/favicon.svg", "/icons.svg"}) {
    wifiServer.serveStatic(asset, LittleFS, asset).setFilter(ON_AP_FILTER);
  }
  wifiServer.begin();
}

void WifiManager::begin() {
#if defined(SIMPLE_RADIO_FIXED_WIFI)
  credCount = 1;
  creds[0] = {FIXED_WIFI_SSID, FIXED_WIFI_PASS};
  if (tryConnect()) {
    _mode = WifiRunMode::STA_OK;
    _lastConnected = true;
    return;
  }

  Serial.println("Fixed WiFi test mode failed; retrying STA without AP portal");
  _mode = WifiRunMode::AP_CONFIG;
  return;
#else
  if (loadCredentials() && tryConnect()) {
    _mode = WifiRunMode::STA_OK;
    _lastConnected = true;
    return;
  }

  _mode = WifiRunMode::AP_CONFIG;
  startConfigPortal();
#endif
}

bool WifiManager::isConnected() const {
  return WiFi.status() == WL_CONNECTED;
}

static bool saveJoinedNetwork() {
  JsonDocument doc;
  JsonArray networks = doc.to<JsonArray>();
  auto add = [&](const WifiCred& network) {
    auto entry = networks.add<JsonObject>();
    entry["ssid"] = network.ssid;
    entry["pass"] = network.pass;
  };
  add(pendingNetwork);
  for (size_t i = 0; i < credCount && networks.size() < 5; ++i) {
    if (creds[i].ssid != pendingNetwork.ssid) add(creds[i]);
  }
  return !doc.overflowed() && writeJsonAtomic(WIFI_FILE, doc);
}

static bool advancePortal() {
  const uint32_t now = millis();
  switch (portalPhase.load()) {
    case PortalPhase::Queued:
      phaseStarted = now;
      WiFi.begin(pendingNetwork.ssid.c_str(), pendingNetwork.pass.c_str());
      portalPhase = PortalPhase::Connecting;
      break;
    case PortalPhase::Connecting: {
      const IPAddress address = WiFi.localIP();
      if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == pendingNetwork.ssid && uint32_t(address) != 0) {
        const bool saved = saveJoinedNetwork();
        pendingNetwork.pass = "";
        if (!saved) {
          WiFi.disconnect(false);
          portalPhase = PortalPhase::SaveFailed;
          break;
        }
        acknowledgedAddress = 0;
        portalAddress = uint32_t(address);
        phaseStarted = now;
        PlayerState::instance().setBitrate(address.toString());
        Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
        portalPhase = PortalPhase::Connected;
      } else if (now - phaseStarted >= 25000) {
        WiFi.disconnect(false);
        pendingNetwork.pass = "";
        portalPhase = PortalPhase::JoinFailed;
      }
      break;
    }
    case PortalPhase::Connected: {
      const IPAddress current = WiFi.localIP();
      if (WiFi.status() != WL_CONNECTED || !uint32_t(current)) {
        portalPhase = PortalPhase::JoinFailed;
        break;
      }
      if (uint32_t(current) != portalAddress.load()) {
        acknowledgedAddress = 0;
        portalAddress = uint32_t(current);
        phaseStarted = now;
        PlayerState::instance().setBitrate(current.toString());
        Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
      }
      // Give the browser time to receive the LAN address. Continue unattended
      // too, in case the phone left the setup network during the channel change.
      if (acknowledgedAddress.load() != uint32_t(current) && now - phaseStarted < 75000) break;
      if (!WiFi.mode(WIFI_STA)) break;
      wifiServer.end();
      WiFi.setSleep(false);
      WiFi.setAutoReconnect(true);
      PlayerState::instance().clearStation(false);
      portalPhase = PortalPhase::Off;
      return true;
    }
    default: break;
  }
  return false;
}

bool WifiManager::loop() {
  if (_mode == WifiRunMode::AP_CONFIG) {
    if (!advancePortal()) return false;
    _mode = WifiRunMode::STA_OK;
    _lastConnected = isConnected();
    return true;
  }

  bool connected = isConnected();
  bool changed = connected != _lastConnected;
  if (changed) {
    _lastConnected = connected;
    if (connected) {
      Serial.printf("[wifi] reconnected: %s, IP=%s\n", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
    } else {
      Serial.println("[wifi] connection lost, automatic reconnect active");
    }
  }

  if (!connected) handleReconnect();
  return changed;
}

void WifiManager::handleReconnect() {
  if (millis() - lastReconnect < 5000) return;
  lastReconnect = millis();

  Serial.println("[wifi] reconnect attempt");
  WiFi.reconnect();
}
