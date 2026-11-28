#include "../../src/display/player_layout_motion.h"

using namespace PlayerLayout;

constexpr bool pacedMotion(int growth, uint32_t start) {
  Motion m(growth);
  m.start(growth, start);
  uint32_t now = start;
  for (int i = 1; i <= Steps; ++i) {
    // Even a decoder stall must deliver the next frame without jumping ahead.
    if (i > 1) now += i == Steps / 2 ? 4 * FrameMs : FrameMs;
    const int previous = m.position;
    if (!m.advance(now) || m.position <= previous || m.position != growthAt(i, growth)) return false;
    if (m.advance(now + FrameMs - 1)) return false;
  }
  if (m.active() || m.position != growth) return false;
  m.start(0, now);
  for (int i = Steps - 1; i >= Steps / 2; --i) {
    now += FrameMs;
    if (!m.advance(now) || m.position != growthAt(i, growth)) return false;
  }
  const int middle = m.step;
  m.start(growth, now);
  now += FrameMs;
  if (!m.advance(now) || m.step != middle + 1) return false;
  m.snap(m.position);
  if (m.active()) return false;
  m.start(0, now);
  for (int i = middle; i >= 0; --i) {
    now += FrameMs;
    if (!m.advance(now) || m.position != growthAt(i, growth)) return false;
  }
  return !m.active() && m.position == 0;
}
static_assert(pacedMotion(28, 0));
static_assert(pacedMotion(19, UINT32_MAX - 40));

constexpr bool scaleBounds(int size, int extra, int border) {
  for (int grow = 0; grow <= extra; ++grow) {
    const int end = size + grow + 2 * border;
    int previous = -1;
    for (int x = 0; x < end; ++x) {
      int index = sourcePixel(x, size, grow, border);
      if (index < previous || index > previous + 1 || index >= size + 2 * border) return false;
      previous = index;
    }
    if (previous != size + 2 * border - 1) return false;
  }
  return true;
}
static_assert(scaleBounds(176, 28, 3));
static_assert(scaleBounds(117, 19, 2));

template<int Size, int Extra, int Border>
constexpr bool scaledSpansMatchEveryPixel() {
  constexpr ScaleTable<Size, Extra, Border> table;
  for (int step = 0; step <= Steps; ++step) {
    const int growth = growthAt(step, Extra);
    const int width = Size + growth + 2 * Border;
    const auto& map = table.steps[step];
    if (map.spanCount != growth + 1) return false;
    int x = 0;
    for (int i = 0; i < map.spanCount; ++i) {
      const RowSpan& run = map.spans[i];
      if (run.dest != x) return false;
      for (int j = 0; j < run.length; ++j, ++x) {
        if (run.source + j != map.source[x] || map.source[x] != sourcePixel(x, Size, growth, Border)) return false;
      }
    }
    if (x != width) return false;
  }
  return true;
}
static_assert(scaledSpansMatchEveryPixel<176,28,3>());
static_assert(scaledSpansMatchEveryPixel<117,19,2>());

constexpr bool contains(Rect r, int x, int y) {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}
constexpr bool eraseOnlyExposedPixels(Rect old, Rect next) {
  int writes[8][8]{};
  clearUncovered(old, next, [&](int left, int top, int w, int h) {
    for (int y = top; y < top + h; ++y) for (int x = left; x < left + w; ++x) ++writes[y][x];
  });
  for (int y = 0; y < 8; ++y) for (int x = 0; x < 8; ++x) {
    if (writes[y][x] != int(contains(old, x, y) && !contains(next, x, y))) return false;
  }
  return true;
}
constexpr Rect old{1,1,5,5};
static_assert(eraseOnlyExposedPixels(old, old));
static_assert(eraseOnlyExposedPixels(old, {1,1,4,4}));
static_assert(eraseOnlyExposedPixels(old, {0,0,8,8}));
static_assert(eraseOnlyExposedPixels(old, {2,2,3,2}));
static_assert(eraseOnlyExposedPixels(old, {0,2,4,4}));
static_assert(eraseOnlyExposedPixels(old, {5,0,2,3}));
static_assert(eraseOnlyExposedPixels(old, {7,7,1,1}));
static_assert(eraseOnlyExposedPixels({}, old));
