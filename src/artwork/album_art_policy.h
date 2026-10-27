#pragma once

#include <stddef.h>
#include <stdint.h>

namespace AlbumArtPolicy {
constexpr size_t SLOT_COUNT = 2;
constexpr size_t MAX_IMAGE_BYTES = 384 * 1024;
constexpr size_t PSRAM_HEADROOM = 512 * 1024;
constexpr size_t INTERNAL_HEADROOM = 32 * 1024;
constexpr size_t JPEG_INTERNAL_HEADROOM = 24 * 1024;

// The pinned LovyanGFX JPEG decoder allocates a 3900-byte work pool. Pixels
// and compressed data are already in PSRAM; preserve 24 KiB before decoding,
// rather than applying the PNG reserve to every JPEG. Keep a contiguous margin.

// A displayed image is never a scratch buffer. An HTTP/LCD reader retains a
// shared reference; only the pool's sole reference permits recycling a slot.
constexpr bool reusable(bool published, long references) {
  return !published && references == 1;
}

constexpr size_t readableBytes(size_t size, size_t offset, size_t requested) {
  return offset >= size ? 0 : (requested < size - offset ? requested : size - offset);
}

enum class Format { Invalid, Jpeg, Png };
constexpr size_t internalHeadroom(Format format) {
  return format == Format::Jpeg ? JPEG_INTERNAL_HEADROOM : INTERNAL_HEADROOM;
}
constexpr size_t internalBlock(Format format) {
  return format == Format::Jpeg ? 6 * 1024 : 8 * 1024;
}
constexpr bool internalReady(Format format, size_t freeBytes, size_t largestBlock) {
  return freeBytes >= internalHeadroom(format) && largestBlock >= internalBlock(format);
}
struct ImageInfo {
  Format format = Format::Invalid;
  uint16_t width = 0;
  uint16_t height = 0;
  constexpr bool valid() const { return format != Format::Invalid && width && height; }
};

constexpr uint16_t be16(const uint8_t* p) {
  return (static_cast<uint16_t>(p[0]) << 8) | p[1];
}
constexpr uint32_t be32(const uint8_t* p) {
  return (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) |
         (static_cast<uint32_t>(p[2]) << 8) | p[3];
}
constexpr ImageInfo dimensions(Format format, uint32_t width, uint32_t height) {
  // Artwork providers supply thumbnails, not huge decoded images. Bound both
  // axes before handing untrusted compressed data to the image decoder.
  return width && height && width <= 2048 && height <= 2048
             ? ImageInfo{format, static_cast<uint16_t>(width), static_cast<uint16_t>(height)}
             : ImageInfo{};
}

constexpr ImageInfo inspect(const uint8_t* data, size_t size) {
  if (!data || size > MAX_IMAGE_BYTES) return {};
  if (size >= 33 && data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G' &&
      data[4] == 13 && data[5] == 10 && data[6] == 26 && data[7] == 10 &&
      be32(data + 8) == 13 && data[12] == 'I' && data[13] == 'H' && data[14] == 'D' && data[15] == 'R') {
    return dimensions(Format::Png, be32(data + 16), be32(data + 20));
  }
  if (size < 4 || data[0] != 0xFF || data[1] != 0xD8) return {};
  size_t at = 2;
  while (at < size) {
    if (data[at++] != 0xFF) return {};
    while (at < size && data[at] == 0xFF) ++at;
    if (at >= size) return {};
    const uint8_t marker = data[at++];
    if (marker == 0xD9 || marker == 0xDA || marker == 0) return {};
    if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD8)) continue;
    if (size - at < 2) return {};
    const size_t length = be16(data + at);
    if (length < 2 || length > size - at) return {};
    const bool sof = marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
    if (sof) {
      if (length < 8) return {};
      return dimensions(Format::Jpeg, be16(data + at + 5), be16(data + at + 3));
    }
    at += length;
  }
  return {};
}
} // namespace AlbumArtPolicy
