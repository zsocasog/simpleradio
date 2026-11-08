#pragma once

#include <stddef.h>
#include <stdint.h>

namespace PickerLogoMath {
constexpr int MAX_SOURCE_SIDE = 512;
constexpr int MAX_TARGET_SIDE = 96;

constexpr bool validGeometry(int sourceSide, int targetSide) {
  return sourceSide > 0 && sourceSide <= MAX_SOURCE_SIDE &&
         targetSide > 0 && targetSide <= MAX_TARGET_SIDE && targetSide <= sourceSide;
}

constexpr bool validHeader(const uint8_t* header, size_t bytes, int sourceSide, size_t fileBytes) {
  return header && bytes == 8 && sourceSide > 0 && sourceSide <= MAX_SOURCE_SIDE &&
         header[0] == 'S' && header[1] == 'R' && header[2] == '5' && header[3] == '6' &&
         (header[4] | (header[5] << 8)) == sourceSide &&
         (header[6] | (header[7] << 8)) == sourceSide &&
         fileBytes == 8 + static_cast<size_t>(sourceSide) * sourceSide * 2;
}

constexpr uint16_t thumbnailRgb565(const uint8_t* row, int column) {
  // SR56 is wire-order RGB565. Accumulate channels, not packed pixel values.
  return (static_cast<uint16_t>(row[column * 2]) << 8) | row[column * 2 + 1];
}

template<class Read> constexpr bool readRow(Read read, uint16_t* pixels, int y,
                                           int sourceSide, int targetSide) {
  if (!pixels || !validGeometry(sourceSide, targetSide) || y < 0 || y >= targetSide) return false;
  uint8_t sourceRow[MAX_SOURCE_SIDE * 2] = {};
  uint32_t red[MAX_TARGET_SIDE] = {}, green[MAX_TARGET_SIDE] = {}, blue[MAX_TARGET_SIDE] = {};
  const int y0 = y * sourceSide / targetSide;
  const int y1 = (y + 1) * sourceSide / targetSide;
  const size_t rowBytes = static_cast<size_t>(sourceSide) * 2;
  for (int sourceY = y0; sourceY < y1; ++sourceY) {
    if (read(sourceRow, rowBytes) != rowBytes) return false;
    for (int x = 0; x < targetSide; ++x) {
      for (int sourceX = x * sourceSide / targetSide; sourceX < (x + 1) * sourceSide / targetSide; ++sourceX) {
        const uint16_t pixel = thumbnailRgb565(sourceRow, sourceX);
        red[x] += pixel >> 11; green[x] += (pixel >> 5) & 63; blue[x] += pixel & 31;
      }
    }
  }
  for (int x = 0; x < targetSide; ++x) {
    const unsigned count = (y1 - y0) * ((x + 1) * sourceSide / targetSide - x * sourceSide / targetSide);
    pixels[y * targetSide + x] = ((red[x] / count) << 11) | ((green[x] / count) << 5) | (blue[x] / count);
  }
  return true;
}
} // namespace PickerLogoMath
