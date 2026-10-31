#pragma once
#include <array>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

// Expose existing SR56 pixels as a browser-readable BMP without a new image,
// decoder, network request, flash write or full-frame RAM buffer.
namespace LcdBmp {
using Header = std::array<uint8_t, 66>;
inline Header header(uint16_t width, uint16_t height) {
  Header out{};
  auto le32 = [&](size_t offset, uint32_t value) {
    for (unsigned i = 0; i < 4; ++i) out[offset + i] = static_cast<uint8_t>(value >> (8 * i));
  };
  out[0] = 'B'; out[1] = 'M';
  const uint32_t stride = (static_cast<uint32_t>(width) * 2 + 3) & ~3U;
  le32(2, 66 + stride * height);
  le32(10, 66); le32(14, 40);
  le32(18, width); le32(22, 0U - height); // Top-down rows, like SR56.
  out[26] = 1; out[28] = 16;
  le32(30, 3); // BI_BITFIELDS: RGB565, not BMP's implicit RGB555.
  le32(34, stride * height);
  le32(54, 0xf800); le32(58, 0x07e0); le32(62, 0x001f);
  return out;
}

// The LCD cache width is even (176 or 120), so RGB565 rows need no padding.
// Handle arbitrary HTTP callback offsets/sizes, including one-byte fragments.
template<class Source> size_t read(Source& source, const Header& bmp, uint8_t* out,
                                   size_t capacity, size_t index, size_t total) {
  if (!out || index >= total || !capacity) return 0;
  size_t count = capacity < total - index ? capacity : total - index;
  size_t done = 0;
  if (index < bmp.size()) {
    const size_t available = bmp.size() - index;
    const size_t n = count < available ? count : available;
    memcpy(out, bmp.data() + index, n);
    done += n; index += n;
  }
  if (done == count) return done;
  const size_t offset = index - bmp.size();
  if (!source.seek(8 + (offset & ~size_t(1)))) return done;
  uint8_t pair[2];
  if (offset & 1) {
    if (source.read(pair, 2) != 2) return done;
    out[done++] = pair[0]; // Second little-endian byte = SR56's first byte.
  }
  const size_t pairs = (count - done) & ~size_t(1);
  if (pairs) {
    const size_t got = source.read(out + done, pairs) & ~size_t(1);
    for (size_t i = 0; i < got; i += 2) {
      const uint8_t high = out[done + i];
      out[done + i] = out[done + i + 1]; out[done + i + 1] = high;
    }
    done += got;
    if (got != pairs) return done;
  }
  if (done < count && source.read(pair, 2) == 2) out[done++] = pair[1];
  return done;
}
} // namespace LcdBmp
