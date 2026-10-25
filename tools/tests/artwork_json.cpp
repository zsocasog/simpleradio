#include "../../src/artwork/artwork_json.h"

static_assert(ArtworkJson::MAX_DOCUMENT_BYTES == 512 * 1024);
static_assert(ArtworkJson::PSRAM_HEADROOM == 512 * 1024);

// Compile the exact ArduinoJson 7.4.3 API, including shared allocator lifetime,
// filtering, failure cleanup, and readonly-response ownership.
bool parseArtwork(const char* response, size_t size) {
  ArtworkJson::Allocator allocator;
  JsonDocument doc(&allocator);
  JsonDocument filter(doc.allocator());
  if (!ArtworkJson::musicBrainzFilter(filter)) return false;
  const auto error = deserializeJson(doc, response, size, DeserializationOption::Filter(filter));
  if (error) { doc.clear(); return false; }
  return doc["recordings"][0]["releases"][0]["media"][0]["format"] == "CD";
}
