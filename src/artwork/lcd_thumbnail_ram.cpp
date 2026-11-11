#include "lcd_thumbnail_ram.h"
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <stdlib.h>
#include <string.h>
#include <utility>

namespace LcdThumbnailRam {
namespace {
struct Block {
  char path[96];
  size_t bytes;
  time_t modified;
  uint8_t data[1];
};
struct Slot {
  Block* block = nullptr;
  uint32_t used = 0;
  unsigned readers = 0;
  bool visible = false;
};
Slot slots[Slots];
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
uint32_t sequence = 0;
uint32_t clock = 0;
bool matches(const Slot& slot, const char* path) {
  return slot.block && path && strcmp(slot.block->path, path) == 0;
}
void release(int index) {
  if (index < 0) return;
  Block* old = nullptr;
  portENTER_CRITICAL(&mux);
  auto& slot = slots[index];
  if (slot.readers && --slot.readers == 0 && !slot.visible) {
    old = slot.block; slot = Slot();
  }
  portEXIT_CRITICAL(&mux);
  free(old);
}
}
Lease::~Lease() { release(slot_); }
Lease::Lease(Lease&& other) noexcept { *this = std::move(other); }
Lease& Lease::operator=(Lease&& other) noexcept {
  if (this == &other) return *this;
  release(slot_);
  slot_ = other.slot_; data_ = other.data_; bytes_ = other.bytes_; modified_ = other.modified_;
  other.slot_ = -1; other.data_ = nullptr; other.bytes_ = 0; other.modified_ = 0;
  return *this;
}
size_t Lease::read(uint8_t* out, size_t count, size_t offset) const {
  if (!out || !data_ || offset >= bytes_) return 0;
  if (count > bytes_ - offset) count = bytes_ - offset;
  memcpy(out, data_ + offset, count); return count;
}
Lease acquire(const char* path) {
  Lease result;
  if (!path || !*path) return result;
  portENTER_CRITICAL(&mux);
  for (size_t i = 0; i < Slots; ++i) {
    auto& slot = slots[i];
    if (!slot.visible || !matches(slot, path)) continue;
    ++slot.readers; slot.used = ++clock;
    result.slot_ = static_cast<int>(i); result.data_ = slot.block->data;
    result.bytes_ = slot.block->bytes; result.modified_ = slot.block->modified;
    break;
  }
  portEXIT_CRITICAL(&mux);
  return result;
}
bool contains(const char* path) { return static_cast<bool>(acquire(path)); }
Stats stats() {
  Stats result;
  portENTER_CRITICAL(&mux);
  result.published = sequence;
  for (const auto& slot : slots) {
    if (!slot.block) continue;
    ++result.slots; result.bytes += offsetof(Block, data) + slot.block->bytes;
    result.readers += slot.readers;
  }
  portEXIT_CRITICAL(&mux);
  return result;
}
void retire(const char* path) {
  Block* old[Slots]{};
  portENTER_CRITICAL(&mux);
  for (size_t i = 0; i < Slots; ++i) {
    auto& slot = slots[i];
    if (!matches(slot, path)) continue;
    slot.visible = false;
    if (!slot.readers) { old[i] = slot.block; slot = Slot(); }
  }
  portEXIT_CRITICAL(&mux);
  for (auto* block : old) free(block);
}
bool publish(const char* path, const uint8_t* pixels, size_t side) {
  if (!path || !*path || strlen(path) >= sizeof(Block::path) || !pixels || !side || side > MaxSide) return false;
  const size_t bytes = 8 + side * side * 2;
  const size_t allocation = offsetof(Block, data) + bytes;
  // No fallback to scarce internal RAM. Preserve room for network/album work.
  if (heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) < allocation + 512 * 1024) return false;
  auto* next = static_cast<Block*>(heap_caps_malloc(allocation, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!next) return false;
  strcpy(next->path, path); next->bytes = bytes;
  const uint8_t header[8] = {'S','R','5','6',uint8_t(side),uint8_t(side >> 8),uint8_t(side),uint8_t(side >> 8)};
  memcpy(next->data, header, sizeof(header)); memcpy(next->data + 8, pixels, bytes - 8);
  Block* old = nullptr;
  int chosen = -1;
  portENTER_CRITICAL(&mux);
  // Prefer replacing the same path when no reader still owns its old pixels.
  for (size_t i = 0; i < Slots; ++i)
    if (!slots[i].readers && matches(slots[i], path)) { chosen = int(i); break; }
  if (chosen < 0) {
    for (size_t i = 0; i < Slots; ++i) {
      if (slots[i].readers) continue;
      if (!slots[i].block) { chosen = int(i); break; }
      if (chosen < 0 || slots[i].used < slots[chosen].used) chosen = int(i);
    }
  }
  if (chosen >= 0) {
    for (auto& slot : slots) if (matches(slot, path)) slot.visible = false;
    if (++sequence == 0) ++sequence;
    next->modified = -static_cast<time_t>(sequence); // Distinct from disk mtimes.
    old = slots[chosen].block;
    slots[chosen] = Slot{next, ++clock, 0, true};
  }
  portEXIT_CRITICAL(&mux);
  free(old);
  if (chosen < 0) free(next);
  return chosen >= 0;
}
}
