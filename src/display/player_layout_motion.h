#pragma once
#include <stdint.h>

namespace PlayerLayout {
constexpr int Steps = 8;
constexpr uint32_t FrameMs = 32;

// Sample smoothstep at fixed sizes so a busy audio decoder cannot skip the
// middle of the zoom. A reversal takes the next step from the displayed size.
constexpr int growthAt(int step, int full) {
  constexpr int cube = Steps * Steps * Steps;
  return (full * step * step * (3 * Steps - 2 * step) + cube / 2) / cube;
}

struct Motion {
  const int full;
  int position = 0, target = 0, step = 0;
  uint32_t started = 0, lastFrame = 0;
  constexpr explicit Motion(int growth) : full(growth) {}
  constexpr bool active() const { return position != target; }
  constexpr void snap(int value) {
    if (value == 0) step = 0;
    else if (value == full) step = Steps;
    position = target = value;
  }
  constexpr void start(int value, uint32_t now) {
    target = value;
    started = now;
    lastFrame = now - FrameMs; // draw the first step immediately, also on reversal
  }
  constexpr bool advance(uint32_t now) {
    if (!active() || now - lastFrame < FrameMs) return false;
    step += target > position ? 1 : -1;
    position = growthAt(step, full);
    lastFrame = now;
    return true;
  }
};

struct Rect { int x, y, w, h; };

// Clear only the parts of the previous rectangle left behind by the move.
// Both layers are erased before the new picture and caption are overlaid.
template <typename Clear>
constexpr void clearUncovered(Rect old, Rect next, Clear clear) {
  if (old.w <= 0 || old.h <= 0) return;
  const int left = old.x > next.x ? old.x : next.x;
  const int top = old.y > next.y ? old.y : next.y;
  const int right = old.x + old.w < next.x + next.w ? old.x + old.w : next.x + next.w;
  const int bottom = old.y + old.h < next.y + next.h ? old.y + old.h : next.y + next.h;
  if (left >= right || top >= bottom) { clear(old.x, old.y, old.w, old.h); return; }
  if (top > old.y) clear(old.x, old.y, old.w, top - old.y);
  if (bottom < old.y + old.h) clear(old.x, bottom, old.w, old.y + old.h - bottom);
  if (left > old.x) clear(old.x, top, left - old.x, bottom - top);
  if (right < old.x + old.w) clear(right, top, old.x + old.w - right, bottom - top);
}

constexpr int sourcePixel(int offset, int size, int growth, int border) {
  if (offset < border) return offset;
  if (offset >= border + size + growth) return offset - growth;
  return border + (offset - border) * size / (size + growth);
}

// In nearest-neighbour enlargement, pixels remain consecutive except at
// repeats. There are exactly growth + 1 spans for a complete picture row.
struct RowSpan { uint16_t dest, source, length; };
constexpr int makeRowSpans(const uint16_t* source, int width, RowSpan* spans) {
  int count = 0;
  for (int x = 0; x < width; ++x) {
    if (x && source[x] == source[x - 1] + 1) ++spans[count - 1].length;
    else spans[count++] = {static_cast<uint16_t>(x), source[x], 1};
  }
  return count;
}

// Artwork changes, but the mapping for each physical display size is fixed.
template<int Size, int Extra, int Border>
struct ScaleTable {
  struct Step {
    uint16_t source[Size + Extra + 2 * Border]{};
    RowSpan spans[Extra + 1]{};
    int spanCount = 0;
  };
  Step steps[Steps + 1]{};

  constexpr ScaleTable() {
    for (int i = 0; i <= Steps; ++i) {
      Step& s = steps[i];
      const int growth = growthAt(i, Extra);
      const int width = Size + growth + 2 * Border;
      for (int x = 0; x < width; ++x) s.source[x] = sourcePixel(x, Size, growth, Border);
      s.spanCount = makeRowSpans(s.source, width, s.spans);
    }
  }
};
}
