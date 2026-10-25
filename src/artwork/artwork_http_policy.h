#pragma once

#include <stddef.h>

namespace ArtworkHttpPolicy {
constexpr size_t MAX_METADATA_BYTES = 256 * 1024;

// Content-Length counts payload bytes. Chunked framing must still be consumed
// by HTTPClient, even if a nonconforming server also sends Content-Length.
class BodyBoundary {
public:
  constexpr void begin(int length, bool chunked) {
    bounded_ = length > 0 && !chunked;
    remaining_ = bounded_ ? static_cast<size_t>(length) : 0;
  }
  constexpr bool consume(size_t bytes) {
    if (!bounded_ || !bytes || !remaining_) return false;
    if (bytes >= remaining_) { remaining_ = 0; return true; }
    remaining_ -= bytes;
    return false;
  }
private:
  size_t remaining_ = 0;
  bool bounded_ = false;
};
} // namespace ArtworkHttpPolicy
