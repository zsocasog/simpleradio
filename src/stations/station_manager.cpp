#include "station_manager.h"
#include <LittleFS.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <climits>
#include <vector>
#include "../config/logging.h"
#include "../storage/atomic_file.h"

static SemaphoreHandle_t stationMutex = nullptr;

static String cleanLogoValue(const String& value) {
  String cleaned = value;
  cleaned.trim();
  String lowered = cleaned;
  lowered.toLowerCase();
  if (lowered == "null" || lowered == "undefined" || lowered == "none") return "";
  return cleaned;
}

static SemaphoreHandle_t stationLockHandle() {
  if (!stationMutex) {
    stationMutex = xSemaphoreCreateRecursiveMutex();
  }
  return stationMutex;
}

class StationLock {
public:
  StationLock() {
    SemaphoreHandle_t mutex = stationLockHandle();
    locked = mutex && xSemaphoreTakeRecursive(mutex, pdMS_TO_TICKS(1000)) == pdTRUE;
  }

  ~StationLock() {
    if (locked) xSemaphoreGiveRecursive(stationLockHandle());
  }

  bool ok() const {
    return locked;
  }

private:
  bool locked = false;
};

StationManager& StationManager::instance() {
  static StationManager sm;
  return sm;
}

bool StationManager::begin() {
  StationLock lock;
  if (!lock.ok()) return false;

  if (!readJsonWithBackup("/stations.json", _doc)) {
    Serial.println("stations.json parse error");
    return false;
  }

  ++_revision;
  return true;
}

bool StationManager::getStation(int id, Station& out) const {
  StationLock lock;
  if (!lock.ok()) return false;

  JsonArrayConst stations = _doc["stations"];
  if (stations.isNull()) return false;

  for (JsonObjectConst s : stations) {
    if (s["id"].as<int>() == id) {
      out.id   = id;
      out.name = s["name"].as<String>();
      out.url  = s["url"].as<String>();
      out.logo = cleanLogoValue(s["logo"].as<String>());
      return true;
    }
  }
  return false;
}

void StationManager::toJson(JsonArray arr) const {
  StationLock lock;
  if (!lock.ok()) return;

  JsonArrayConst stations = _doc["stations"];
  if (stations.isNull()) return;

  size_t index = 0;
  for (JsonObjectConst s : stations) {
    JsonObject o = arr.add<JsonObject>();
    o["number"] = static_cast<int>(index + 1);
    o["id"]   = s["id"].as<int>();
    o["name"] = s["name"].as<String>();
    o["url"] = s["url"].as<String>();
    String logo = cleanLogoValue(s["logo"].as<String>());
    if (logo.length()) {
      o["logo"] = logo;
    }
    ++index;
  }
}

int StationManager::nextId() const {
  StationLock lock;
  if (!lock.ok()) return 0;

  JsonArrayConst stations = _doc["stations"];
  int maxId = -1;

  if (!stations.isNull()) {
    for (JsonObjectConst s : stations) {
      maxId = max(maxId, s["id"].as<int>());
    }
  }

  return maxId + 1;
}

bool StationManager::saveFile() {
  StationLock lock;
  if (!lock.ok()) return false;

  if (!writeJsonAtomic("/stations.json", _doc, true)) {
    Serial.println("failed to write stations.json");
    return false;
  }
  ++_revision;
  return true;
}

bool StationManager::saveStation(int id, const String& name, const String& url, const String& logo, int& outId) {
  StationLock lock;
  if (!lock.ok()) return false;

  if (!name.length() || !url.length()) return false;

  JsonArray stations = _doc["stations"].as<JsonArray>();
  if (stations.isNull()) {
    stations = _doc["stations"].to<JsonArray>();
  }

  outId = id >= 0 ? id : nextId();

  for (JsonObject s : stations) {
    if (s["id"].as<int>() == outId) {
      s["name"] = name;
      s["url"] = url;
      s["logo"] = cleanLogoValue(logo);
      return saveFile();
    }
  }

  JsonObject s = stations.add<JsonObject>();
  s["id"] = outId;
  s["name"] = name;
  s["url"] = url;
  s["logo"] = cleanLogoValue(logo);
  return saveFile();
}

bool StationManager::deleteStation(int id) {
  StationLock lock;
  if (!lock.ok()) return false;

  JsonArray stations = _doc["stations"].as<JsonArray>();
  if (stations.isNull()) return false;

  for (size_t i = 0; i < stations.size(); ++i) {
    if (stations[i]["id"].as<int>() == id) {
      stations.remove(i);
      return saveFile();
    }
  }

  return false;
}

bool StationManager::moveStation(int id, int direction) {
  StationLock lock;
  if (!lock.ok()) return false;

  JsonArray stations = _doc["stations"].as<JsonArray>();
  if (stations.isNull() || stations.size() < 2 || direction == 0) return false;

  int from = -1;
  for (size_t i = 0; i < stations.size(); ++i) {
    if (stations[i]["id"].as<int>() == id) {
      from = static_cast<int>(i);
      break;
    }
  }

  if (from < 0) return false;

  int to = from + (direction < 0 ? -1 : 1);
  if (to < 0 || to >= static_cast<int>(stations.size())) return false;

  JsonObject a = stations[from];
  JsonObject b = stations[to];

  int aId = a["id"].as<int>();
  String aName = a["name"].as<String>();
  String aUrl = a["url"].as<String>();
  String aLogo = a["logo"].as<String>();

  a["id"] = b["id"].as<int>();
  a["name"] = b["name"].as<String>();
  a["url"] = b["url"].as<String>();
  a["logo"] = b["logo"].as<String>();

  b["id"] = aId;
  b["name"] = aName;
  b["url"] = aUrl;
  b["logo"] = aLogo;

  return saveFile();
}

static bool parseStationOrder(const String& orderCsv, std::vector<int>& ids) {
  ids.clear();

  int start = 0;
  while (start <= static_cast<int>(orderCsv.length())) {
    int comma = orderCsv.indexOf(',', start);
    String token = comma >= 0 ? orderCsv.substring(start, comma) : orderCsv.substring(start);
    token.trim();

    if (!token.length()) return false;
    char* end = nullptr;
    long value = strtol(token.c_str(), &end, 10);
    if (!end || *end != '\0' || value < 0 || value > INT_MAX) return false;

    ids.push_back(static_cast<int>(value));
    if (comma < 0) break;
    start = comma + 1;
  }

  return !ids.empty();
}

bool StationManager::reorderStations(const String& orderCsv) {
  StationLock lock;
  if (!lock.ok()) return false;

  JsonArrayConst stations = _doc["stations"];
  if (stations.isNull() || stations.size() < 2) return false;

  std::vector<int> ids;
  if (!parseStationOrder(orderCsv, ids) || ids.size() != stations.size()) return false;

  bool changed = false;
  std::vector<Station> ordered;
  ordered.reserve(ids.size());

  for (size_t targetIndex = 0; targetIndex < ids.size(); ++targetIndex) {
    int id = ids[targetIndex];

    for (size_t i = 0; i < targetIndex; ++i) {
      if (ids[i] == id) return false;
    }

    bool found = false;
    for (size_t currentIndex = 0; currentIndex < stations.size(); ++currentIndex) {
      JsonObjectConst s = stations[currentIndex];
      if (s["id"].as<int>() != id) continue;

      Station station;
      station.id = id;
      station.name = s["name"].as<String>();
      station.url = s["url"].as<String>();
      station.logo = cleanLogoValue(s["logo"].as<String>());
      ordered.push_back(station);
      changed = changed || currentIndex != targetIndex;
      found = true;
      break;
    }

    if (!found) return false;
  }

  if (!changed) return true;

  _doc.clear();
  JsonArray nextStations = _doc["stations"].to<JsonArray>();
  for (const Station& station : ordered) {
    JsonObject s = nextStations.add<JsonObject>();
    s["id"] = station.id;
    s["name"] = station.name;
    s["url"] = station.url;
    s["logo"] = cleanLogoValue(station.logo);
  }

  return saveFile();
}

bool StationManager::stationIdRelative(int currentId, int offset, int& outId) const {
  StationLock lock;
  if (!lock.ok()) return false;

  JsonArrayConst stations = _doc["stations"];
  if (stations.isNull() || stations.size() == 0) return false;

  int currentIndex = 0;
  for (size_t i = 0; i < stations.size(); ++i) {
    if (stations[i]["id"].as<int>() == currentId) {
      currentIndex = static_cast<int>(i);
      break;
    }
  }

  int nextIndex = currentIndex + offset;
  while (nextIndex < 0) nextIndex += stations.size();
  nextIndex = nextIndex % stations.size();

  outId = stations[nextIndex]["id"].as<int>();
  return true;
}

bool StationManager::stationIdAtIndex(size_t index, int& outId) const {
  StationLock lock;
  if (!lock.ok()) return false;

  JsonArrayConst stations = _doc["stations"];
  if (stations.isNull() || index >= stations.size()) return false;

  outId = stations[index]["id"].as<int>();
  return true;
}

bool StationManager::stationAtIndex(size_t index, Station& out) const {
  StationLock lock;
  if (!lock.ok()) return false;

  JsonArrayConst stations = _doc["stations"];
  if (stations.isNull() || index >= stations.size()) return false;

  JsonObjectConst s = stations[index];
  out.id = s["id"].as<int>();
  out.name = s["name"].as<String>();
  out.url = s["url"].as<String>();
  out.logo = cleanLogoValue(s["logo"].as<String>());
  return true;
}

int StationManager::indexOfStation(int id) const {
  StationLock lock;
  if (!lock.ok()) return -1;

  JsonArrayConst stations = _doc["stations"];
  if (stations.isNull()) return -1;

  for (size_t i = 0; i < stations.size(); ++i) {
    if (stations[i]["id"].as<int>() == id) return static_cast<int>(i);
  }

  return -1;
}

size_t StationManager::count() const {
  StationLock lock;
  if (!lock.ok()) return 0;

  JsonArrayConst stations = _doc["stations"];
  return stations.isNull() ? 0 : stations.size();
}

uint32_t StationManager::revision() const {
  StationLock lock;
  if (!lock.ok()) return 0;
  return _revision;
}
