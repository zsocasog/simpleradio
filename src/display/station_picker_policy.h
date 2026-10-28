#pragma once

#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace StationPickerPolicy {
constexpr uint32_t INPUT_SETTLE_MS = 120;
constexpr uint32_t LOGO_STEP_US = 2000;
constexpr int LOGO_ROWS_PER_STEP = 2;
constexpr uint32_t READY_LOGO_RECHECK_MS = 5000;
constexpr uint32_t MISSING_LOGO_RECHECK_MS = 1000;

inline int windowStart(int current, int selected, int count, int visible) {
  if (count <= visible) return 0;
  const int last = count - visible;
  int start = current < 0 ? 0 : (current > last ? last : current);
  if (selected < start) start = selected;
  if (selected >= start + visible) start = selected - visible + 1;
  return start < 0 ? 0 : (start > last ? last : start);
}

struct Rect { int x, y, w, h; };

// Four disjoint areas around the stationary logo tile, in row coordinates.
inline void rowParts(int x, int width, int height, int logoX, int logoY,
                     int logoSize, Rect* parts) {
  parts[0] = {x, 0, width, logoY};
  parts[1] = {x, logoY, logoX - x, logoSize};
  parts[2] = {logoX + logoSize, logoY, x + width - logoX - logoSize, logoSize};
  parts[3] = {x, logoY + logoSize, width, height - logoY - logoSize};
}

// Keep overlapping rasterized rows in PSRAM; no LCD readback or file IO.
inline bool shiftRows(uint16_t* pixels, int width, int height, int rows, int delta) {
  const int moved = delta < 0 ? -delta : delta;
  if (!pixels || width <= 0 || height <= 0 || moved == 0 || moved >= rows) return false;
  const size_t stride = static_cast<size_t>(width) * height;
  const size_t offset = moved * stride;
  const size_t count = (rows - moved) * stride;
  const size_t dst = delta < 0 ? offset : 0;
  const size_t src = delta > 0 ? offset : 0;
  memmove(pixels + dst, pixels + src, count * sizeof(uint16_t));
  return true;
}

inline bool elapsedAtLeast(uint32_t now, uint32_t since, uint32_t delay) {
  return static_cast<uint32_t>(now - since) >= delay;
}

inline bool autoPlayReady(uint32_t now, uint32_t opened, uint32_t changed,
                          uint32_t presented, uint32_t openGuard, uint32_t delay) {
  return changed != 0 && elapsedAtLeast(now, opened, openGuard) &&
         elapsedAtLeast(now, changed, delay) && elapsedAtLeast(now, presented, delay);
}
}
