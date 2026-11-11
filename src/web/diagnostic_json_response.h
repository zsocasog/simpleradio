#pragma once
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <esp_heap_caps.h>
#include <cstring>

// Test-build endpoint only. Keep its sizeable JSON body out of scarce internal
// RAM, including the extra String copy made by AsyncBasicResponse. No fallback
// to internal RAM: a failed observation must not destabilize the measured app.
class DiagnosticJsonResponse final : public AsyncAbstractResponse {
public:
  explicit DiagnosticJsonResponse(const JsonDocument& doc) {
    const size_t bytes = measureJson(doc);
    if (doc.overflowed() || !bytes || bytes > 16384) return;
    data_ = static_cast<uint8_t*>(heap_caps_malloc(bytes + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!data_) return;
    if (serializeJson(doc, reinterpret_cast<char*>(data_), bytes + 1) != bytes) return;
    _code = 200;
    _contentType = "application/json";
    _contentLength = bytes;
    _sendContentLength = true;
    valid_ = true;
  }
  ~DiagnosticJsonResponse() override { heap_caps_free(data_); }
  bool _sourceValid() const override { return valid_; }
  size_t _fillBuffer(uint8_t* buffer, size_t maxLen) override {
    if (!valid_ || !buffer || offset_ >= _contentLength) return 0;
    const size_t remaining = _contentLength - offset_;
    const size_t count = remaining < maxLen ? remaining : maxLen;
    memcpy(buffer, data_ + offset_, count);
    offset_ += count;
    return count;
  }
private:
  uint8_t* data_ = nullptr;
  size_t offset_ = 0;
  bool valid_ = false;
};
