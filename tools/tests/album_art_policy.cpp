// Compile-time tests against the SAME bounds/parser/pool rules used on ESP32.
#include "../../src/artwork/album_art_policy.h"
#include <limits>

using namespace AlbumArtPolicy;
static_assert(SLOT_COUNT == 2);
static_assert(internalReady(Format::Jpeg, 30 * 1024, 8 * 1024));
static_assert(!internalReady(Format::Png, 30 * 1024, 8 * 1024));
static_assert(!internalReady(Format::Jpeg, 23 * 1024, 8 * 1024));
static_assert(!internalReady(Format::Jpeg, 30 * 1024, 3900));
static_assert(internalReady(Format::Png, 32 * 1024, 8 * 1024));
static_assert(internalHeadroom(Format::Jpeg) - 3900 > 20 * 1024);
static_assert(reusable(false, 1));
static_assert(!reusable(true, 1)); // Published pixels cannot be used as scratch.
static_assert(!reusable(false, 2)); // An HTTP or LCD reader still holds a lease.
static_assert(!reusable(false, 0));
static_assert(!reusable(true, 4));
static_assert(readableBytes(10, 0, 20) == 10);
static_assert(readableBytes(10, 8, 20) == 2);
static_assert(readableBytes(10, 10, 20) == 0);
static_assert(readableBytes(10, 11, 20) == 0);
static_assert(readableBytes(10, std::numeric_limits<size_t>::max(), 20) == 0);
static_assert(readableBytes(10, 0, 0) == 0);
static_assert(readableBytes(0, 0, 20) == 0);
static_assert(!inspect(nullptr, 100).valid());

constexpr uint8_t jpeg[] = {0xFF,0xD8, 0xFF,0xC0, 0,11, 8, 0,250, 1,44, 1, 1,0x11,0};
static_assert(inspect(jpeg, sizeof(jpeg)).format == Format::Jpeg);
static_assert(inspect(jpeg, sizeof(jpeg)).width == 300);
static_assert(inspect(jpeg, sizeof(jpeg)).height == 250);
constexpr uint8_t jpegApp[] = {0xFF,0xD8, 0xFF,0xE0, 0,4, 1,2, 0xFF,0xFF,0xC2, 0,11, 8, 0,250, 0,250, 1, 1,0x11,0};
static_assert(inspect(jpegApp, sizeof(jpegApp)).format == Format::Jpeg);
static_assert(inspect(jpegApp, sizeof(jpegApp)).width == 250);
constexpr uint8_t truncated[] = {0xFF,0xD8, 0xFF,0xC0, 0,11, 8, 0,250};
static_assert(!inspect(truncated, sizeof(truncated)).valid());
constexpr uint8_t badLength[] = {0xFF,0xD8, 0xFF,0xE0, 0,1};
static_assert(!inspect(badLength, sizeof(badLength)).valid());
constexpr uint8_t padding[] = {0xFF,0xD8, 0xFF,0xFF};
static_assert(!inspect(padding, sizeof(padding)).valid());
constexpr uint8_t scanBeforeSof[] = {0xFF,0xD8, 0xFF,0xDA, 0,2};
static_assert(!inspect(scanBeforeSof, sizeof(scanBeforeSof)).valid());
static_assert(!inspect(jpeg, MAX_IMAGE_BYTES + 1).valid());

constexpr uint8_t png[] = {0x89,'P','N','G',13,10,26,10, 0,0,0,13,'I','H','D','R',
                         0,0,0,250, 0,0,1,44, 8,2,0,0,0,0,0,0,0};
static_assert(inspect(png, sizeof(png)).format == Format::Png);
static_assert(inspect(png, sizeof(png)).width == 250);
static_assert(inspect(png, sizeof(png)).height == 300);
static_assert(!inspect(png, 24).valid());
static_assert(!dimensions(Format::Png, 0, 250).valid());
static_assert(!dimensions(Format::Jpeg, 250, 0).valid());
static_assert(!dimensions(Format::Jpeg, 2049, 250).valid());
static_assert(!dimensions(Format::Png, 250, 65536).valid());
static_assert(dimensions(Format::Jpeg, 2048, 2048).valid());
static_assert(SLOT_COUNT * (MAX_IMAGE_BYTES + 176 * 176 * 2) < 1024 * 1024);

constexpr bool truncatedHeadersAreRejected() {
  // Constant evaluation also rejects any out-of-bounds access by the parser.
  for (size_t n = 0; n < sizeof(jpeg); ++n) if (inspect(jpeg, n).valid()) return false;
  for (size_t n = 0; n < sizeof(png); ++n) if (inspect(png, n).valid()) return false;
  return true;
}
static_assert(truncatedHeadersAreRejected());

constexpr bool malformedSegmentsAreBounded() {
  for (unsigned value = 0; value < 256; ++value) {
    const uint8_t bytes[] = {0xFF,0xD8,0xFF,0xE0,0,static_cast<uint8_t>(value),0xFF,0xC0,0,11,8,0,250};
    if (inspect(bytes, sizeof(bytes)).valid()) return false;
  }
  return true;
}
static_assert(malformedSegmentsAreBounded());
