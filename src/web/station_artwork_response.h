#pragma once

#include <ESPAsyncWebServer.h>
#include "artwork_etag.h"
#include "../artwork/artwork_revision.h"
#include "../storage/read_only_file.h"
#include "../artwork/lcd_bmp_stream.h"
#include "../artwork/lcd_thumbnail_ram.h"
#include "../diagnostics/runtime_probe.h"
#include <esp_heap_caps.h>
#include <cstring>

// Own the descriptor directly: no shared File, stdio buffer or FILE mutex is
// retained by slow clients. The async server owns/deletes this response.
class StationArtworkResponse final : public AsyncAbstractResponse {
public:
  StationArtworkResponse(const char* mount, const char* path) : revisionAtOpen_(ArtworkRevision::value()), file_(mount, path),
      pathId_(ArtworkEtag::pathId(path ? path : "")) {
    uint8_t sr[8]{};
    if (!file_ || file_.read(sr, sizeof(sr)) != sizeof(sr) ||
        sr[0] != 'S' || sr[1] != 'R' || sr[2] != '5' || sr[3] != '6') return;
    const uint16_t width = sr[4] | (static_cast<uint16_t>(sr[5]) << 8);
    const uint16_t height = sr[6] | (static_cast<uint16_t>(sr[7]) << 8);
    const size_t pixels = static_cast<size_t>(width) * height * 2;
    if (!width || (width & 1) || !height || width > 512 || height > 512 || file_.size() != 8 + pixels) return;
    bmp_ = LcdBmp::header(width, height);
    _code = 200;
    _contentType = "image/bmp";
    _contentLength = bmp_.size() + pixels;
    _sendContentLength = true;
    valid_ = true;
  }
  ~StationArtworkResponse() override { heap_caps_free(data_); }
  bool prepare() {
    if (!valid_) return false;
    if (data_ || !_contentLength) return true;
    auto* prepared = static_cast<uint8_t*>(heap_caps_malloc(_contentLength, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (prepared) {
      while (offset_ < _contentLength) {
        const size_t remaining = _contentLength - offset_;
        const size_t wanted = remaining < 4096 ? remaining : 4096;
        if (!_fillBuffer(prepared + offset_, wanted)) break;
      }
      valid_ = offset_ == _contentLength;
    } else valid_ = false;
    file_.close();
    if (!valid_) { heap_caps_free(prepared); return false; }
    data_ = prepared;
    offset_ = 0;
    return true;
  }
  bool _sourceValid() const override { return valid_; }
  String entityTag() const {
    const uint32_t revision = ArtworkRevision::value();
    // A file opened across a concurrent replacement must never advertise the
    // new revision with the old pixels. Send a normal 200 without a validator.
    if (!valid_ || !revisionAtOpen_ || revision != revisionAtOpen_) return String();
    const auto tag = ArtworkEtag::value(ArtworkRevision::session(), revision, pathId_, file_.size());
    return String(tag.data());
  }
  void notModified() {
    _code = 304;
    _contentLength = 0;
    _sendContentLength = false; // A 304 has no body; omit its length header.
    file_.close();
  }
  size_t _fillBuffer(uint8_t* buffer, size_t maxLen) override {
    SR_PERF_SPAN(ImageFill);
    if (!valid_ || !buffer || offset_ >= _contentLength) return 0;
    if (data_) {
      const size_t remaining = _contentLength - offset_;
      const size_t count = maxLen < remaining ? maxLen : remaining;
      memcpy(buffer, data_ + offset_, count);
      offset_ += count;
      return count;
    }
    const size_t count = LcdBmp::read(file_, bmp_, buffer, maxLen, offset_, _contentLength);
    offset_ += count;
    // All pixels have been copied into the server's PSRAM send buffer. TCP
    // may still be retrying partial writes, so source validity must stay true.
    if (offset_ >= _contentLength) file_.close();
    else if (!count && maxLen) valid_ = false;
    return count;
  }
private:
  uint32_t revisionAtOpen_ = 0;
  LcdThumbnailRam::File file_;
  LcdBmp::Header bmp_{};
  size_t offset_ = 0;
  uint64_t pathId_ = 0;
  bool valid_ = false;
  uint8_t* data_ = nullptr;
};
