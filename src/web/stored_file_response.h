#pragma once
#include <ESPAsyncWebServer.h>
#include <esp_heap_caps.h>
#include <new>
#include <cstring>
#include <cstdlib>
#include "artwork_etag.h"
#include "../storage/read_only_file.h"

// Small persisted JSON files: read the actual bytes and CLOSE the descriptor
// in main before handing a response to AsyncTCP. ESP LittleFS cannot rename a
// target while it has an open reader. Never serve a live-settings substitute.
class StoredFileResponse final : public AsyncAbstractResponse {
public:
  static StoredFileResponse* create(const char* mount, const char* path, int& error) {
    ReadOnlyStorage::File file(mount, path);
    if (!file) { error = 404; return nullptr; }
    const size_t size = file.size();
    if (size > 512 * 1024) { error = 503; return nullptr; } // same bound as persisted JSON documents
    if (heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) < size + 512 * 1024) { error = 503; return nullptr; }
    auto* bytes = static_cast<uint8_t*>(heap_caps_malloc(size ? size : 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!bytes) { error = 503; return nullptr; }
    const bool complete = file.read(bytes, size) == size;
    file.close();
    if (!complete) { free(bytes); error = 503; return nullptr; }
    auto* response = new (std::nothrow) StoredFileResponse(bytes, size);
    if (!response) { free(bytes); error = 503; }
    return response;
  }
  ~StoredFileResponse() { free(bytes_); }
  void setType(const char* type) { _contentType = type; }
  bool _sourceValid() const override { return true; }
  String entityTag() const { return tag_; }
  void notModified() {
    _code = 304; _contentLength = 0; _sendContentLength = false;
    free(bytes_); bytes_ = nullptr;
  }
  size_t _fillBuffer(uint8_t* out, size_t maxLen) override {
    if (!out || !maxLen || offset_ >= _contentLength) return 0;
    const size_t remaining = _contentLength - offset_;
    const size_t count = maxLen < remaining ? maxLen : remaining;
    if (count) memcpy(out, bytes_ + offset_, count);
    offset_ += count;
    return count;
  }
private:
  StoredFileResponse(uint8_t* bytes, size_t size) : bytes_(bytes) {
    _code = 200; _contentType = "application/json"; _contentLength = size; _sendContentLength = true;
    uint32_t hash = 2166136261U;
    for (size_t i = 0; i < size; ++i) hash = (hash ^ bytes[i]) * 16777619U;
    char tag[32]; snprintf(tag, sizeof(tag), "\"%08lx-%lx\"", static_cast<unsigned long>(hash), static_cast<unsigned long>(size));
    tag_ = tag;
  }
  uint8_t* bytes_;
  size_t offset_ = 0;
  String tag_;
};
