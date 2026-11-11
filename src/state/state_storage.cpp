#include "state_storage.h"
#include <LittleFS.h>
#include <ArduinoJson.h>
#include "player_state.h"
#include "../stations/station_manager.h"
#include "../config/app_config.h"
#include "../storage/atomic_file.h"
#include "../storage/read_only_file.h"
#include "../artwork/artwork_json.h"

StateStorage& StateStorage::instance() {
  static StateStorage s;
  return s;
}

void StateStorage::load() {
  persisted_.invalidate();
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

bool StateStorage::save() {
  PlayerStateSnapshot ps = PlayerState::instance().snapshot();
  const PersistedControls::Value value{ps.stationId, ps.volume, ps.playing,
                                     ps.eqLow, ps.eqMid, ps.eqHigh, ps.balance};
  return persisted_.save(value, ReadOnlyStorage::exists(LittleFS.mountpoint(), "/state.json"), [&] {
    ArtworkJson::Allocator allocator;
    JsonDocument doc(&allocator);
    doc["stationId"] = value.stationId;
    doc["volume"] = value.volume;
    doc["playing"] = value.playing;
    doc["eqLow"] = value.eqLow;
    doc["eqMid"] = value.eqMid;
    doc["eqHigh"] = value.eqHigh;
    doc["balance"] = value.balance;
    return !doc.overflowed() && writeJsonAtomic("/state.json", doc);
  });
}
