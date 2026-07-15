#include "mqtt_controller.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <WiFiClient.h>

#include "../config/app_config.h"
#include "../config/version.h"
#include "../display/display.h"
#include "../i18n/i18n.h"
#include "../state/player_state.h"
#include "../stations/station_manager.h"
#include "../web/web_server.h"

static WiFiClient mqttNet;
static PubSubClient mqtt(mqttNet);
static constexpr unsigned long MQTT_RECONNECT_MS = 15000;
static unsigned long lastConnectAttempt = 0;
static uint32_t lastPublishedStateRevision = 0;
static uint32_t lastPublishedStationsRevision = 0;
static String lastMqttHost;
static uint16_t lastMqttPort = 0;
static String lastMqttRoot;
static String lastMqttUser;
static String lastMqttPassword;
static bool discoveryPublished = false;

static String topic(const char* suffix) {
  String out = AppConfig::instance().mqttRootTopic;
  if (!out.length()) out = "simpleradio";
  out += "/";
  out += suffix;
  return out;
}

static String deviceId() {
  return "simpleradio_" + String((uint32_t)ESP.getEfuseMac(), HEX);
}

static String discoveryTopic(const char* component, const char* object) {
  return "homeassistant/" + String(component) + "/" + deviceId() + "_" + String(object) + "/config";
}

static void addDeviceInfo(JsonDocument& doc) {
  JsonObject device = doc["device"].to<JsonObject>();
  JsonArray identifiers = device["identifiers"].to<JsonArray>();
  identifiers.add(deviceId());
  device["name"] = "SimpleRadio";
  device["manufacturer"] = "SimpleRadio";
  device["model"] = "ESP32 Internet Radio";
  device["configuration_url"] = "http://" + WiFi.localIP().toString() + "/";

  JsonObject origin = doc["origin"].to<JsonObject>();
  origin["name"] = "SimpleRadio firmware";
  origin["sw_version"] = APP_VERSION;
}

static void publishDiscovery(const char* component, const char* object, JsonDocument& doc) {
  addDeviceInfo(doc);
  doc["unique_id"] = deviceId() + "_" + String(object);
  doc["default_entity_id"] = String(component) + ".simpleradio_" + String(object);
  doc["availability_topic"] = topic("availability");
  doc["payload_available"] = "online";
  doc["payload_not_available"] = "offline";

  String payload;
  serializeJson(doc, payload);
  mqtt.publish(discoveryTopic(component, object).c_str(), payload.c_str(), true);
}

static void publishDiscoveryMessages() {
  JsonDocument doc;

  doc.clear();
  doc["name"] = "Playback";
  doc["icon"] = "mdi:radio";
  doc["state_topic"] = topic("status");
  doc["command_topic"] = topic("command");
  doc["payload_on"] = "play";
  doc["payload_off"] = "stop";
  doc["state_on"] = "ON";
  doc["state_off"] = "OFF";
  doc["value_template"] = "{{ 'ON' if value_json.playing else 'OFF' }}";
  publishDiscovery("switch", "playback", doc);

  doc.clear();
  doc["name"] = "Volume";
  doc["icon"] = "mdi:volume-high";
  doc["min"] = 0;
  doc["max"] = 100;
  doc["step"] = 1;
  doc["mode"] = "slider";
  doc["unit_of_measurement"] = "%";
  doc["state_topic"] = topic("status");
  doc["command_topic"] = topic("command");
  doc["value_template"] = "{{ value_json.volume }}";
  doc["command_template"] = "vol {{ value | int }}";
  publishDiscovery("number", "volume", doc);

  doc.clear();
  doc["name"] = "Balance";
  doc["icon"] = "mdi:speaker-multiple";
  doc["min"] = -100;
  doc["max"] = 100;
  doc["step"] = 1;
  doc["mode"] = "slider";
  doc["unit_of_measurement"] = "%";
  doc["state_topic"] = topic("status");
  doc["command_topic"] = topic("command");
  doc["value_template"] = "{{ value_json.balance }}";
  doc["command_template"] = "balance {{ value | int }}";
  publishDiscovery("number", "balance", doc);

  doc.clear();
  doc["name"] = "Station";
  doc["icon"] = "mdi:radio-tower";
  doc["state_topic"] = topic("status");
  doc["value_template"] = "{{ value_json.station }}";
  doc["json_attributes_topic"] = topic("status");
  publishDiscovery("sensor", "station", doc);

  doc.clear();
  doc["name"] = "Stations";
  doc["icon"] = "mdi:playlist-music";
  doc["state_topic"] = topic("stations");
  doc["value_template"] = "{{ value_json.stations | count }}";
  doc["json_attributes_topic"] = topic("stations");
  publishDiscovery("sensor", "stations", doc);

  doc.clear();
  doc["name"] = "Title";
  doc["icon"] = "mdi:music-note";
  doc["state_topic"] = topic("status");
  doc["value_template"] = "{{ value_json.title }}";
  publishDiscovery("sensor", "title", doc);

  doc.clear();
  doc["name"] = "Artist";
  doc["icon"] = "mdi:account-music";
  doc["state_topic"] = topic("status");
  doc["value_template"] = "{{ value_json.artist }}";
  publishDiscovery("sensor", "artist", doc);

  doc.clear();
  doc["name"] = "Previous station";
  doc["icon"] = "mdi:skip-previous";
  doc["command_topic"] = topic("command");
  doc["payload_press"] = "prev";
  publishDiscovery("button", "previous_station", doc);

  doc.clear();
  doc["name"] = "Next station";
  doc["icon"] = "mdi:skip-next";
  doc["command_topic"] = topic("command");
  doc["payload_press"] = "next";
  publishDiscovery("button", "next_station", doc);

  doc.clear();
  doc["name"] = "Reboot";
  doc["icon"] = "mdi:restart";
  doc["entity_category"] = "diagnostic";
  doc["command_topic"] = topic("command");
  doc["payload_press"] = "reboot";
  publishDiscovery("button", "reboot", doc);
}

static String stationsJson() {
  JsonDocument doc;
  JsonArray arr = doc["stations"].to<JsonArray>();
  StationManager& manager = StationManager::instance();
  size_t stationCount = manager.count();
  for (size_t index = 0; index < stationCount; ++index) {
    Station station;
    if (!manager.stationAtIndex(index, station)) continue;

    JsonObject item = arr.add<JsonObject>();
    item["number"] = static_cast<int>(index + 1);
    item["id"] = station.id;
    item["name"] = station.name;
    if (station.logo.length()) item["logo"] = station.logo;
  }

  String out;
  serializeJson(doc, out);
  return out;
}

static void applyStationOffset(int offset) {
  int nextId = -1;
  PlayerStateSnapshot state = PlayerState::instance().snapshot();
  if (!StationManager::instance().stationIdRelative(state.stationId, offset, nextId)) return;

  JsonDocument cmd;
  cmd["station"] = nextId;
  cmd["play"] = true;
  queuePlayerCommand(cmd);
}

static void applyCommand(String command) {
  Display::instance().notifyActivity();
  command.trim();
  command.toLowerCase();

  PlayerStateSnapshot state = PlayerState::instance().snapshot();
  JsonDocument cmd;

  if (command == "prev") {
    applyStationOffset(-1);
    return;
  }

  if (command == "next") {
    applyStationOffset(1);
    return;
  }

  if (command == "toggle") {
    cmd["play"] = !state.playing;
  } else if (command == "stop") {
    cmd["play"] = false;
  } else if (command == "start" || command == "play") {
    cmd["play"] = true;
  } else if (command == "reboot" || command == "boot") {
    ESP.restart();
  } else if (command == "volp") {
    cmd["volume"] = min(100, state.volume + 2);
  } else if (command == "volm") {
    cmd["volume"] = max(0, state.volume - 2);
  } else if (command.startsWith("vol ")) {
    cmd["volume"] = command.substring(4).toInt();
  } else if (command.startsWith("balance ")) {
    cmd["balance"] = command.substring(8).toInt();
  } else if (command.startsWith("play ")) {
    cmd["station"] = command.substring(5).toInt();
    cmd["play"] = true;
  } else if (command.startsWith("eq ")) {
    int first = command.indexOf(' ');
    int second = command.indexOf(' ', first + 1);
    int third = command.indexOf(' ', second + 1);
    if (first > 0 && second > first && third > second) {
      cmd["eqLow"] = command.substring(first + 1, second).toInt();
      cmd["eqMid"] = command.substring(second + 1, third).toInt();
      cmd["eqHigh"] = command.substring(third + 1).toInt();
    }
  } else {
    return;
  }

  queuePlayerCommand(cmd);
}

static void onMessage(char* topicName, uint8_t* payload, unsigned int length) {
  String command;
  command.reserve(length);

  for (unsigned int i = 0; i < length; ++i) {
    command += static_cast<char>(payload[i]);
  }

  if (String(topicName) == "homeassistant/status") {
    command.trim();
    if (command == "online") discoveryPublished = false;
    return;
  }

  applyCommand(command);
}

MqttController& MqttController::instance() {
  static MqttController controller;
  return controller;
}

void MqttController::begin() {
  mqtt.setCallback(onMessage);
  mqtt.setBufferSize(8192);
  mqtt.setSocketTimeout(1);
  mqtt.setKeepAlive(15);
}

bool MqttController::enabled() const {
  AppConfig& config = AppConfig::instance();
  return config.mqttEnabled && config.mqttHost.length();
}

bool MqttController::connected() const {
  return mqtt.connected();
}

int MqttController::state() const {
  return mqtt.state();
}

const char* MqttController::stateText() const {
  switch (mqtt.state()) {
    case MQTT_CONNECTION_TIMEOUT: return I18n::MQTT_CONNECTION_TIMEOUT_TEXT;
    case MQTT_CONNECTION_LOST: return I18n::MQTT_CONNECTION_LOST_TEXT;
    case MQTT_CONNECT_FAILED: return I18n::MQTT_CONNECT_FAILED_TEXT;
    case MQTT_DISCONNECTED: return I18n::MQTT_DISCONNECTED_TEXT;
    case MQTT_CONNECTED: return I18n::MQTT_CONNECTED_TEXT;
    case MQTT_CONNECT_BAD_PROTOCOL: return I18n::MQTT_BAD_PROTOCOL_TEXT;
    case MQTT_CONNECT_BAD_CLIENT_ID: return I18n::MQTT_BAD_CLIENT_ID_TEXT;
    case MQTT_CONNECT_UNAVAILABLE: return I18n::MQTT_UNAVAILABLE_TEXT;
    case MQTT_CONNECT_BAD_CREDENTIALS: return I18n::MQTT_BAD_CREDENTIALS_TEXT;
    case MQTT_CONNECT_UNAUTHORIZED: return I18n::MQTT_UNAUTHORIZED_TEXT;
    default: return I18n::MQTT_UNKNOWN_TEXT;
  }
}

void MqttController::loop() {
  if (!WiFi.isConnected()) return;

  AppConfig& config = AppConfig::instance();
  if (!config.mqttEnabled || !config.mqttHost.length()) {
    if (mqtt.connected()) mqtt.disconnect();
    return;
  }

  if (config.mqttHost != lastMqttHost ||
      config.mqttPort != lastMqttPort ||
      config.mqttRootTopic != lastMqttRoot ||
      config.mqttUser != lastMqttUser ||
      config.mqttPassword != lastMqttPassword) {
    lastMqttHost = config.mqttHost;
    lastMqttPort = config.mqttPort;
    lastMqttRoot = config.mqttRootTopic;
    lastMqttUser = config.mqttUser;
    lastMqttPassword = config.mqttPassword;
    lastConnectAttempt = 0;
    lastPublishedStateRevision = 0;
    lastPublishedStationsRevision = 0;
    discoveryPublished = false;
    if (mqtt.connected()) mqtt.disconnect();
    mqtt.setServer(lastMqttHost.c_str(), lastMqttPort);
  }

  if (!mqtt.connected()) {
    unsigned long now = millis();
    if (now - lastConnectAttempt < MQTT_RECONNECT_MS) return;
    lastConnectAttempt = now;

    String clientId = "simpleradio-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    String availabilityTopic = topic("availability");
    if (config.mqttUser.length()) {
      mqtt.connect(clientId.c_str(), config.mqttUser.c_str(), config.mqttPassword.c_str(), availabilityTopic.c_str(), 0, true, "offline");
    } else {
      mqtt.connect(clientId.c_str(), availabilityTopic.c_str(), 0, true, "offline");
    }

    if (mqtt.connected()) {
      mqtt.subscribe(topic("command").c_str());
      mqtt.subscribe("homeassistant/status");
      mqtt.publish(availabilityTopic.c_str(), "online", true);
      publishDiscoveryMessages();
      discoveryPublished = true;
    }
  }

  mqtt.loop();

  if (mqtt.connected() && !discoveryPublished) {
    publishDiscoveryMessages();
    discoveryPublished = true;
  }

  uint32_t stateRevision = PlayerState::instance().revision();
  if (stateRevision != lastPublishedStateRevision) {
    PlayerStateSnapshot snapshot = PlayerState::instance().snapshot();
    String stateJson = PlayerState::instance().toJson();
    mqtt.publish(topic("status").c_str(), stateJson.c_str(), true);
    mqtt.publish(topic("volume").c_str(), String(snapshot.volume).c_str(), true);
    mqtt.publish(topic("balance").c_str(), String(snapshot.balance).c_str(), true);
    lastPublishedStateRevision = stateRevision;
  }

  uint32_t stationsRevision = StationManager::instance().revision();
  if (stationsRevision != lastPublishedStationsRevision) {
    String stationsPayload = stationsJson();
    mqtt.publish(topic("stations").c_str(), stationsPayload.c_str(), true);
    lastPublishedStationsRevision = stationsRevision;
  }
}
