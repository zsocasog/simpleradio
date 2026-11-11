#pragma once
#include <ESPAsyncWebServer.h>
#include "artwork_etag.h"
#include "../artwork/artwork_revision.h"
#include "../artwork/web_image.h"
#include "../storage/read_only_file.h"
#include "../diagnostics/runtime_probe.h"

// Stream existing PNG/JPEG bytes unchanged. No Arduino FILE, codec, full-frame
// allocation, conversion or flash write in the network task.
class StationWebImageResponse final : public AsyncAbstractResponse {
public:
  StationWebImageResponse(const char* mount, const char* path)
      : revisionAtOpen_(ArtworkRevision::value()), file_(mount, path),
        pathId_(ArtworkEtag::pathId(path ? path : "")) {
    const auto format = WebArtwork::inspect(file_);
    if (format == WebArtwork::Format::None) return;
    _code = 200;
    _contentType = format == WebArtwork::Format::Png ? "image/png" : "image/jpeg";
    _contentLength = file_.size();
    _sendContentLength = true;
    valid_ = true;
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
    const size_t count = file_.read(buffer, wanted);
    offset_ += count;
    if (offset_ >= _contentLength) file_.close();
    else if (count != wanted) { valid_ = false; file_.close(); }
    return count;
  }
private:
  uint32_t revisionAtOpen_ = 0;
  ReadOnlyStorage::File file_;
  uint64_t pathId_ = 0;
  size_t offset_ = 0;
  bool valid_ = false;
};
