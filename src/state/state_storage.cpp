#include "state_storage.h"
#include <LittleFS.h>
#include <ArduinoJson.h>
#include "player_state.h"
#include "../stations/station_manager.h"
#include "../config/app_config.h"
#include "../storage/atomic_file.h"

StateStorage& StateStorage::instance() {
  static StateStorage s;
  return s;
}

void StateStorage::load() {
  JsonDocument doc;
  if (!readJsonWithBackup("/state.json", doc)) return;

  PlayerState& ps = PlayerState::instance();

  if (doc["stationId"].is<int>()) {
    if (!ps.loadStation(doc["stationId"], true, false)) {
      ps.clearStation(false);
    }
  }

  if (doc["volume"].is<int>()) {
    ps.volume = constrain(doc["volume"], 0, 100);
  }

  ps.playing = AppConfig::instance().autoStart && ps.streamUrl.length();

  if (doc["eqLow"].is<int>() || doc["eqMid"].is<int>() || doc["eqHigh"].is<int>()) {
    ps.setEq(
      doc["eqLow"].is<int>() ? doc["eqLow"].as<int>() : ps.eqLow,
      doc["eqMid"].is<int>() ? doc["eqMid"].as<int>() : ps.eqMid,
      doc["eqHigh"].is<int>() ? doc["eqHigh"].as<int>() : ps.eqHigh
    );
    playerStateDirty = false;
  }

  if (doc["balance"].is<int>()) {
    ps.setBalance(doc["balance"].as<int>());
    playerStateDirty = false;
  }
}

void StateStorage::save() {
  JsonDocument doc;
  PlayerStateSnapshot ps = PlayerState::instance().snapshot();

  doc["stationId"] = ps.stationId;
  doc["volume"] = ps.volume;
  doc["playing"] = ps.playing;
  doc["eqLow"] = ps.eqLow;
  doc["eqMid"] = ps.eqMid;
  doc["eqHigh"] = ps.eqHigh;
  doc["balance"] = ps.balance;

  writeJsonAtomic("/state.json", doc);
}
