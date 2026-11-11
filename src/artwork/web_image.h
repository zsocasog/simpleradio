#pragma once
#include <stddef.h>
#include <stdint.h>

// Retain bounded compressed originals, including the full 120 KiB browser
// upload range. Streaming still reads a fixed header/tail and bounded chunks;
// increasing this disk-file limit allocates no full image buffer or internal RAM.
// It also lets playback keep LCD pixels in its existing bounded PSRAM pool.
namespace WebArtwork {
constexpr size_t MaxBytes = 128 * 1024;
enum class Format { None, Png, Jpeg };
template<class File> Format inspect(File& file) {
  if (!file || file.size() < 12 || file.size() > MaxBytes) return Format::None;
  uint8_t header[8]{};
  if (!file.seek(0) || file.read(header, sizeof(header)) != sizeof(header)) return Format::None;
  const uint8_t png[8] = {137, 80, 78, 71, 13, 10, 26, 10};
  bool isPng = true;
  for (size_t i = 0; i < sizeof(png); ++i) if (header[i] != png[i]) isPng = false;
  uint8_t tail[8]{};
  if (!file.seek(file.size() - sizeof(tail)) || file.read(tail, sizeof(tail)) != sizeof(tail) || !file.seek(0)) return Format::None;
  if (isPng && tail[0] == 'I' && tail[1] == 'E' && tail[2] == 'N' && tail[3] == 'D') return Format::Png;
  if (header[0] == 0xff && header[1] == 0xd8 && tail[6] == 0xff && tail[7] == 0xd9) return Format::Jpeg;
  return Format::None;
}
}
