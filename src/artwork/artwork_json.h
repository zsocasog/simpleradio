#pragma once

#include <ArduinoJson.h>
#include <esp_heap_caps.h>
#include <stddef.h>

namespace ArtworkJson {
constexpr size_t MAX_DOCUMENT_BYTES = 512 * 1024;
constexpr size_t PSRAM_HEADROOM = 512 * 1024;

// Metadata has many small pools/strings. Default malloc prefers internal RAM
// for blocks <=4096 bytes on this board, even when the HTTP body is in PSRAM.
// Never fall back to internal RAM: audio, TLS and newlib FILE locks need it.
class Allocator final : public ArduinoJson::Allocator {
public:
  void* allocate(size_t size) override {
    if (!size || !canGrow(size, 0)) return nullptr;
    void* result = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (result) account(0, heap_caps_get_allocated_size(result));
    return result;
  }

  void deallocate(void* ptr) override {
    if (!ptr) return;
    used_ -= heap_caps_get_allocated_size(ptr);
    heap_caps_free(ptr);
  }

  void* reallocate(void* ptr, size_t newSize) override {
    if (!ptr) return allocate(newSize);
    if (!newSize) { deallocate(ptr); return nullptr; }
    const size_t oldSize = heap_caps_get_allocated_size(ptr);
    if (newSize > oldSize && !canGrow(newSize, oldSize)) return nullptr;
    void* result = heap_caps_realloc(ptr, newSize, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    // ArduinoJson assumes shrinking succeeds. Keeping the larger original
    // allocation satisfies that contract without spending any internal RAM.
    if (!result && newSize <= oldSize) return ptr;
    if (result) account(oldSize, heap_caps_get_allocated_size(result));
    return result;
  }

  size_t usedBytes() const { return used_; }
  size_t peakBytes() const { return peak_; }

private:
  bool canGrow(size_t requested, size_t previous) const {
    const size_t retained = used_ - previous;
    if (retained > MAX_DOCUMENT_BYTES || requested > MAX_DOCUMENT_BYTES - retained) return false;
    const size_t growth = requested - previous;
    return heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) >= growth + PSRAM_HEADROOM;
  }
  void account(size_t previous, size_t current) {
    used_ = used_ - previous + current;
    if (used_ > peak_) peak_ = used_;
  }
  size_t used_ = 0;
  size_t peak_ = 0;
};

// Keep every field used for track/artist/release verification. Ignore tags,
// countries, packaging, labels, identifiers and unrelated release metadata.
inline bool musicBrainzFilter(JsonDocument& filter) {
  static constexpr const char* schema = R"json({
    "id":true,"title":true,"status":true,
    "artist-credit":true,
    "release-group":{"id":true,"primary-type":true,"secondary-types":true},
    "recordings":[{
      "score":true,"video":true,"title":true,
      "artist-credit":true,
      "releases":[{
        "id":true,"title":true,"date":true,"status":true,
        "artist-credit":true,
        "release-group":{"id":true,"primary-type":true,"secondary-types":true},
        "media":[{"format":true}]
      }]
    }],
    "release-groups":[{
      "id":true,"score":true,"title":true,"primary-type":true,"secondary-types":true,
      "artist-credit":true
    }]
  })json";
  return deserializeJson(filter, schema) == DeserializationError::Ok;
}
} // namespace ArtworkJson
