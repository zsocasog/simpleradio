#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

struct Station {
  int id;
  String name;
  String url;
  String logo;
};

class StationManager {
public:
  static StationManager& instance();

  bool begin();
  bool getStation(int id, Station& out) const;
  void toJson(JsonArray arr) const;
  bool saveStation(int id, const String& name, const String& url, const String& logo, int& outId);
  bool deleteStation(int id);
  bool moveStation(int id, int direction);
  bool reorderStations(const String& orderCsv);
  bool stationIdRelative(int currentId, int offset, int& outId) const;
  bool stationIdAtIndex(size_t index, int& outId) const;
  bool stationAtIndex(size_t index, Station& out) const;
  int indexOfStation(int id) const;
  size_t count() const;
  uint32_t revision() const;

private:
  StationManager() = default;

  JsonDocument _doc;
  uint32_t _revision = 1;
  bool saveFile();
  int nextId() const;
};

