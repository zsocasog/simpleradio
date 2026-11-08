#include "../../src/artwork/picker_logo_mailbox.h"
#include "../../src/artwork/picker_logo_math.h"

struct Job { uint32_t ticket = 0; int pixels = 0; };

constexpr bool queuedCancellation() {
  PickerLogo::Mailbox<Job> box;
  Job old{}, fresh{};
  const auto oldTicket = box.enqueue(&old);
  if (!oldTicket || !box.pending() || box.enqueue(&fresh)) return false;
  const auto retired = box.cancel();
  if (retired.pending != &old || retired.completed || box.claim() || box.busy()) return false;
  const auto ticket = box.enqueue(&fresh);
  return ticket && ticket != oldTicket && !box.current(oldTicket) && box.claim() == &fresh;
}
static_assert(queuedCancellation());

constexpr bool runningCancellation() {
  PickerLogo::Mailbox<Job> box;
  Job old{}, fresh{};
  const auto oldTicket = box.enqueue(&old);
  if (box.claim() != &old || box.claim()) return false;
  const auto retired = box.cancel();
  // The worker, not the cancelling UI, owns its in-progress image.
  if (retired.pending || retired.completed || box.current(oldTicket) || box.enqueue(&fresh)) return false;
  if (box.finish(&old) != &old || box.busy() || box.take(oldTicket)) return false;
  const auto ticket = box.enqueue(&fresh);
  if (!ticket || box.claim() != &fresh) return false;
  fresh.pixels = 123;
  if (box.finish(&fresh) || box.take(oldTicket)) return false;
  return box.take(ticket) == &fresh && fresh.pixels == 123 && !box.busy();
}
static_assert(runningCancellation());

constexpr bool publishedOwnership() {
  PickerLogo::Mailbox<Job> box;
  Job first{}, second{};
  const auto ticket = box.enqueue(&first);
  if (box.claim() != &first || box.take(ticket)) return false;
  first.pixels = 789;
  if (box.finish(&first) || box.enqueue(&second)) return false;
  const auto retired = box.cancel();
  if (retired.pending || retired.completed != &first || first.pixels != 789 || box.take(ticket)) return false;
  const auto next = box.enqueue(&second);
  if (box.claim() != &second || box.finish(&first) != &first || !box.busy()) return false;
  return !box.finish(&second) && box.take(next) == &second && !box.busy();
}
static_assert(publishedOwnership());

constexpr bool primaryColors() {
  const uint16_t source[] = {
    0xf800,0xf800,0x07e0,0x07e0, 0xf800,0xf800,0x07e0,0x07e0,
    0x001f,0x001f,0xffff,0xffff, 0x001f,0x001f,0xffff,0xffff};
  size_t position = 0;
  auto read = [&](uint8_t* out, size_t bytes) constexpr {
    for (size_t i = 0; i < bytes; ++i) {
      const uint16_t pixel = source[position / 2];
      out[i] = position++ % 2 ? pixel & 255 : pixel >> 8;
    }
    return bytes;
  };
  uint16_t pixels[4] = {};
  for (int y = 0; y < 2; ++y) if (!PickerLogoMath::readRow(read, pixels, y, 4, 2)) return false;
  return position == 32 && pixels[0] == 0xf800 && pixels[1] == 0x07e0 &&
         pixels[2] == 0x001f && pixels[3] == 0xffff;
}
static_assert(primaryColors());

constexpr bool nonDivisibleGeometry(int source, int target) {
  size_t position = 0;
  auto read = [&](uint8_t* out, size_t bytes) constexpr {
    for (size_t i = 0; i < bytes; ++i) out[i] = position++ % 2 ? 0xe0 : 0x07;
    return bytes;
  };
  uint16_t pixels[32 * 32] = {};
  for (int y = 0; y < target; ++y)
    if (!PickerLogoMath::readRow(read, pixels, y, source, target)) return false;
  for (int i = 0; i < target * target; ++i) if (pixels[i] != 0x07e0) return false;
  return position == static_cast<size_t>(source) * source * 2;
}
static_assert(nonDivisibleGeometry(176, 32));
static_assert(nonDivisibleGeometry(117, 21)); // Compact LCD, same area averaging.

constexpr uint8_t header[] = {'S','R','5','6',176,0,176,0};
static_assert(PickerLogoMath::validHeader(header, 8, 176, 8 + 176 * 176 * 2));
static_assert(!PickerLogoMath::validHeader(header, 7, 176, 8 + 176 * 176 * 2));
static_assert(!PickerLogoMath::validHeader(header, 8, 117, 8 + 176 * 176 * 2));
static_assert(!PickerLogoMath::validHeader(header, 8, 176, 8 + 176 * 176 * 2 - 1));
static_assert(!PickerLogoMath::validGeometry(0, 32));
static_assert(!PickerLogoMath::validGeometry(32, 64));
static_assert(!PickerLogoMath::validGeometry(513, 32));

constexpr bool shortReadFails() {
  uint16_t pixels[4] = {};
  auto read = [](uint8_t*, size_t bytes) constexpr { return bytes - 1; };
  return !PickerLogoMath::readRow(read, pixels, 0, 4, 2) &&
         !PickerLogoMath::readRow(read, pixels, 2, 4, 2);
}
static_assert(shortReadFails());
