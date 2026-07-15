#include "wifi_manager.h"

#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>
#include <LittleFS.h>
#include <WiFi.h>

#include "../display/display.h"
#include "../display/display_presenter.h"
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

bool WifiManager::loadCredentials() {
  if (!LittleFS.exists(WIFI_FILE)) {
    Serial.println("wifi.json not found");
    return false;
  }

  File f = LittleFS.open(WIFI_FILE, "r");
  if (!f) {
    Serial.println("failed to open wifi.json");
    return false;
  }

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();

  if (err) {
    Serial.println("wifi.json parse error");
    return false;
  }

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

  for (size_t i = 0; i < credCount; ++i) {
    Serial.print("Connecting to WiFi: ");
    Serial.println(creds[i].ssid);

    WiFi.begin(creds[i].ssid.c_str(), creds[i].pass.c_str());
    unsigned long start = millis();

    while (millis() - start < 8000) {
      if (WiFi.status() == WL_CONNECTED) {
        WiFi.setSleep(false);
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
  WiFi.mode(WIFI_AP);
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
  });

  wifiServer.on("/scan", HTTP_GET, [](AsyncWebServerRequest* r) {
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    int n = WiFi.scanNetworks();
    for (int i = 0; i < n; i++) {
      arr.add(WiFi.SSID(i));
    }

    String out;
    serializeJson(doc, out);
    r->send(200, "application/json", out);
  });

  wifiServer.on("/save", HTTP_POST, [](AsyncWebServerRequest* r) {
    if (!r->hasParam("ssid", true)) {
      r->send(400, "text/plain", I18n::WIFI_MISSING_SSID);
      return;
    }

    String ssid = r->getParam("ssid", true)->value();
    String pass = r->hasParam("pass", true) ? r->getParam("pass", true)->value() : "";

    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    JsonObject o = arr.add<JsonObject>();
    o["ssid"] = ssid;
    o["pass"] = pass;

    File f = LittleFS.open(WIFI_FILE, "w");
    if (!f) {
      r->send(500, "text/plain", I18n::WIFI_SAVE_FAILED);
      return;
    }

    serializeJson(doc, f);
    f.close();

    r->send(200, "text/plain", I18n::WIFI_SAVED_REBOOTING);
    delay(500);
    ESP.restart();
  });

  wifiServer.serveStatic("/wifi.css", LittleFS, "/wifi.css");
  wifiServer.serveStatic("/wifi.js", LittleFS, "/wifi.js");
  wifiServer.begin();
}

void WifiManager::begin() {
#if defined(SIMPLE_RADIO_FIXED_WIFI)
  credCount = 1;
  creds[0] = {FIXED_WIFI_SSID, FIXED_WIFI_PASS};
  if (tryConnect()) {
    _mode = WifiRunMode::STA_OK;
    return;
  }

  Serial.println("Fixed WiFi test mode failed; retrying STA without AP portal");
  _mode = WifiRunMode::AP_CONFIG;
  return;
#else
  if (loadCredentials() && tryConnect()) {
    _mode = WifiRunMode::STA_OK;
    return;
  }

  _mode = WifiRunMode::AP_CONFIG;
  startConfigPortal();
#endif
}

bool WifiManager::isConnected() const {
  return WiFi.status() == WL_CONNECTED;
}

void WifiManager::handleReconnect() {
  if (millis() - lastReconnect < 5000) return;
  lastReconnect = millis();

  WiFi.reconnect();
}
