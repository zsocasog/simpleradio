#pragma once

#include <stddef.h>
#include <stdint.h>

namespace ArtworkJson {
// ArduinoJson reader for an immutable PSRAM body. Parsing owns its strings,
// but must obey the SAME deadline/cancellation as the network phase. Checking
// every 128 input bytes bounds the work without a millis()/snapshot per byte.
template<class Stop>
class BoundedReader {
public:
  constexpr BoundedReader(const uint8_t* data, size_t size, Stop& stop)
      : data_(data), size_(size), stop_(stop) {}
  constexpr int read() {
    if (position_ >= size_ || stopped_) return -1;
    if (!(position_ % 128) && stop_()) { stopped_ = true; return -1; }
    return data_[position_++];
  }
  constexpr size_t readBytes(char* buffer, size_t count) {
    size_t copied = 0;
    while (copied < count) {
      const int value = read();
      if (value < 0) break;
      buffer[copied++] = static_cast<char>(value);
    }
    return copied;
  }
  constexpr bool stopped() const { return stopped_; }
private:
  const uint8_t* data_;
  size_t size_;
  Stop& stop_;
  size_t position_ = 0;
  bool stopped_ = false;
};
} // namespace ArtworkJson
