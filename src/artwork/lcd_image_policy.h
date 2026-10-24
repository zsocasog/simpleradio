#pragma once
#include <stddef.h>
#include <stdint.h>

namespace LcdImagePolicy {
enum class Jpeg { NotJpeg, Baseline, Unsupported, Malformed };
constexpr bool needsConversion(Jpeg kind) {
  return kind == Jpeg::Unsupported || kind == Jpeg::Malformed;
}

// Inspect markers, not pixels. The same bounded parser works on received RAM
// buffers and cached files, without allocating a decoder or a second image.
template<class Input> constexpr Jpeg inspect(Input& input) {
  uint8_t pair[2]{};
  if (input.read(pair, 2) != 2 || pair[0] != 0xFF || pair[1] != 0xD8) return Jpeg::NotJpeg;
  for (size_t count = 0; count < 128; ++count) {
    if (input.read(pair, 1) != 1 || pair[0] != 0xFF) return Jpeg::Malformed;
    uint8_t marker = 0;
    do {
      if (input.read(&marker, 1) != 1) return Jpeg::Malformed;
    } while (marker == 0xFF);
    if (marker == 0 || marker == 0xDA || marker == 0xD9) return Jpeg::Malformed;
    if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD8)) continue;
    if (input.read(pair, 2) != 2) return Jpeg::Malformed;
    const size_t length = (static_cast<size_t>(pair[0]) << 8) | pair[1];
    if (length < 2) return Jpeg::Malformed;
    const bool sof = marker >= 0xC0 && marker <= 0xCF &&
                     marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
    if (sof) {
      uint8_t frame[6]{};
      if (length < 8 || input.read(frame, 6) != 6) return Jpeg::Malformed;
      if (length != 8 + static_cast<size_t>(frame[5]) * 3 || !input.skip(length - 8)) return Jpeg::Malformed;
      if (!(frame[1] || frame[2]) || !(frame[3] || frame[4])) return Jpeg::Malformed;
      return marker == 0xC0 && frame[0] == 8 && (frame[5] == 1 || frame[5] == 3)
          ? Jpeg::Baseline : Jpeg::Unsupported;
    }
    if (!input.skip(length - 2)) return Jpeg::Malformed;
  }
  return Jpeg::Malformed;
}

struct MemoryInput {
  const uint8_t* data;
  size_t size;
  size_t offset = 0;
  constexpr size_t read(uint8_t* out, size_t length) {
    if (!data || length > size - offset) return 0;
    for (size_t i = 0; i < length; ++i) out[i] = data[offset++];
    return length;
  }
  constexpr bool skip(size_t length) {
    if (length > size - offset) return false;
    offset += length;
    return true;
  }
};
constexpr Jpeg inspect(const uint8_t* data, size_t size) {
  MemoryInput input{data, size};
  return inspect(input);
}
} // namespace LcdImagePolicy
