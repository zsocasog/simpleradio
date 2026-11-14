#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include "../artwork/artwork_json.h"

struct Station {
  int id;
  String name;
  String url;
  String logo;
};

enum class StationImportStatus { Ok, Invalid, Conflict, Limit, Busy, Memory, WriteFailed };
struct StationImportResult {
  size_t added = 0;
  size_t skipped = 0;
  size_t total = 0;
  uint32_t revision = 0;
};

class StationManager {
public:
  static StationManager& instance();

  bool begin();
  bool getStation(int id, Station& out) const;
  bool matchesStation(int id, const String& name, const String& url, const String& logo) const;
  void toJson(JsonArray arr, uint32_t* revision = nullptr) const;
  StationImportStatus importStations(JsonArrayConst incoming, bool replace, uint32_t expectedRevision,
                                    StationImportResult& result);
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

  // Both the published list and its transactional copy use this long-lived
  // PSRAM allocator. Swapping a document backed by a local allocator would
  // leave a dangling allocator after the save returns. Writers are serialized.
  ArtworkJson::Allocator jsonAllocator_;
  JsonDocument _doc{&jsonAllocator_};
  uint32_t _revision = 1;
  bool saveFile();
  int nextId() const;
};

