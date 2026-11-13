#pragma once
#include <ESPAsyncWebServer.h>
#include "artwork_etag.h"
#include "../artwork/artwork_revision.h"
#include "../artwork/web_image.h"
#include "../storage/read_only_file.h"
#include "../diagnostics/runtime_probe.h"
#include <esp_heap_caps.h>
#include <cstring>

// Snapshot bounded compressed PNG/JPEG bytes unchanged into external RAM.
// Close flash before TCP starts; a slow browser must not retain a file reader
// across a logo replacement or require flash I/O on every ACK. No image codec.
class StationWebImageResponse final : public AsyncAbstractResponse {
public:
  StationWebImageResponse(const char* mount, const char* path)
      : revisionAtOpen_(ArtworkRevision::value()), file_(mount, path),
        pathId_(ArtworkEtag::pathId(path ? path : "")) {
    const auto format = WebArtwork::inspect(file_);
    if (format == WebArtwork::Format::None) { file_.close(); return; }
    _code = 200;
    _contentType = format == WebArtwork::Format::Png ? "image/png" : "image/jpeg";
    _contentLength = file_.size();
    _sendContentLength = true;
    valid_ = true;
  }
  ~StationWebImageResponse() override { heap_caps_free(data_); }
  bool prepare() {
    if (!valid_) return false;
    if (data_ || !_contentLength) return true;
    data_ = static_cast<uint8_t*>(heap_caps_malloc(_contentLength, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (data_) {
      size_t copied = 0;
      while (copied < _contentLength) {
        const size_t remaining = _contentLength - copied;
        const size_t count = remaining < 4096 ? remaining : 4096;
        if (file_.read(data_ + copied, count) != count) break;
        copied += count;
      }
      valid_ = copied == _contentLength;
    } else valid_ = false;
    file_.close();
    if (!valid_) { heap_caps_free(data_); data_ = nullptr; }
    return valid_;
  }
  bool _sourceValid() const override { return valid_; }
  String entityTag() const {
    const uint32_t revision = ArtworkRevision::value();
    if (!valid_ || !revisionAtOpen_ || revision != revisionAtOpen_) return String();
    const auto tag = ArtworkEtag::value(ArtworkRevision::session(), revision, pathId_, file_.size());
    return String(tag.data());
  }
  void notModified() {
    _code = 304;
    _contentLength = 0;
    _sendContentLength = false;
    file_.close();
  }
  size_t _fillBuffer(uint8_t* buffer, size_t maxLen) override {
    SR_PERF_SPAN(ImageFill);
    if (!valid_ || !buffer || offset_ >= _contentLength) return 0;
    const size_t remaining = _contentLength - offset_;
    const size_t wanted = maxLen < remaining ? maxLen : remaining;
    if (!data_) return 0;
    memcpy(buffer, data_ + offset_, wanted);
    offset_ += wanted;
    return wanted;
  }
private:
  uint32_t revisionAtOpen_ = 0;
  ReadOnlyStorage::File file_;
  uint64_t pathId_ = 0;
  size_t offset_ = 0;
  bool valid_ = false;
  uint8_t* data_ = nullptr;
};
