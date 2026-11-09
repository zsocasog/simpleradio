#pragma once

#include <ESPAsyncWebServer.h>
#include "../storage/read_only_file.h"
#include "../artwork/lcd_bmp_stream.h"

// Own the descriptor directly: no shared File, stdio buffer or FILE mutex is
// retained by slow clients. The async server owns/deletes this response.
class StationArtworkResponse final : public AsyncAbstractResponse {
public:
  StationArtworkResponse(const char* mount, const char* path) : file_(mount, path) {
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
  bool _sourceValid() const override { return valid_; }
  size_t _fillBuffer(uint8_t* buffer, size_t maxLen) override {
    if (!valid_) return 0;
    const size_t count = LcdBmp::read(file_, bmp_, buffer, maxLen, offset_, _contentLength);
    offset_ += count;
    // All pixels have been copied into the server's PSRAM send buffer. TCP
    // may still be retrying partial writes, so source validity must stay true.
    if (offset_ >= _contentLength) file_.close();
    else if (!count && maxLen) valid_ = false;
    return count;
  }
private:
  ReadOnlyStorage::File file_;
  LcdBmp::Header bmp_{};
  size_t offset_ = 0;
  bool valid_ = false;
};
