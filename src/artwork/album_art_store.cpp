#include "album_art_store.h"

#include <esp_heap_caps.h>
#include <esp_system.h>
#include <new>
#include <string.h>

AlbumArtFrame::~AlbumArtFrame() {
  free(image);
  free(pixels);
}

size_t AlbumArtFrame::read(uint8_t* out, size_t requested, size_t offset) const {
  if (!out || !image) return 0;
  // A callback may be offered a large send buffer: keep every copy bounded.
  const size_t count = AlbumArtPolicy::readableBytes(imageBytes, offset, requested < 4096 ? requested : 4096);
  if (count) memcpy(out, image + offset, count);
  return count;
}

AlbumArtStore& AlbumArtStore::instance() {
  static AlbumArtStore store;
  return store;
}

bool AlbumArtStore::isPath(const String& path) {
  return path.startsWith(PATH_PREFIX);
}

const char* AlbumArtStore::failureName(ReserveFailure failure) {
  switch (failure) {
    case ReserveFailure::None: return "none";
    case ReserveFailure::Invalid: return "invalid image request";
    case ReserveFailure::InternalLow: return "internal reserve or contiguous block low";
    case ReserveFailure::SlotsBusy: return "both slots retained by display/web readers";
    case ReserveFailure::FrameAllocation: return "frame allocation failed";
    case ReserveFailure::PsramLow: return "PSRAM reserve low";
    case ReserveFailure::PixelAllocation: return "PSRAM pixel allocation failed";
  }
  return "unknown";
}

AlbumArtStore::Preparation AlbumArtStore::reserve(const String& key, uint16_t side, AlbumArtPolicy::Format format,
                                                  ReserveStatus* status) {
  ReserveStatus current;
  current.internalFree = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  current.internalLargest = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  current.psramFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  current.psramLargest = heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  portENTER_CRITICAL(&mux_);
  current.published = published_;
  for (size_t i = 0; i < slots_.size(); ++i) current.references[i] = slots_[i].use_count();
  portEXIT_CRITICAL(&mux_);
  auto reject = [&](ReserveFailure failure) -> Preparation {
    current.failure = failure;
    if (status) *status = current;
    return {};
  };
  if (!side || side > 512 || key.isEmpty()) return reject(ReserveFailure::Invalid);
  if (!AlbumArtPolicy::internalReady(format, current.internalFree, current.internalLargest)) return reject(ReserveFailure::InternalLow);
  Preparation next(new (std::nothrow) AlbumArtFrame);
  if (!next) return reject(ReserveFailure::FrameAllocation);
  next->key = key;
  next->side = side;
  Preparation old;
  uint32_t sequence = 0;
  portENTER_CRITICAL(&mux_);
  sequence = ++sequence_;
  portEXIT_CRITICAL(&mux_);
  char id[18];
  snprintf(id, sizeof(id), "%08lx-%08lx", static_cast<unsigned long>(esp_random()),
           static_cast<unsigned long>(sequence));
  next->path = String(PATH_PREFIX) + id;
  int chosen = -1;
  portENTER_CRITICAL(&mux_);
  for (size_t i = 0; i < slots_.size(); ++i) {
    if (!slots_[i] || AlbumArtPolicy::reusable(static_cast<int>(i) == published_, slots_[i].use_count())) {
      old = std::move(slots_[i]);
      slots_[i] = next;
      chosen = static_cast<int>(i);
      break;
    }
  }
  portEXIT_CRITICAL(&mux_);
  if (chosen < 0) return reject(ReserveFailure::SlotsBusy); // Never allocate a third slot.
  old.reset(); // May free a large old JPEG; always outside the critical section.
  const size_t pixelBytes = static_cast<size_t>(side) * side * sizeof(uint16_t);
  current.psramFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  current.psramLargest = heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  const bool psramReady = current.psramFree >= pixelBytes + AlbumArtPolicy::PSRAM_HEADROOM && current.psramLargest >= pixelBytes;
  if (psramReady) {
    next->pixels = static_cast<uint16_t*>(heap_caps_malloc(pixelBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  }
  if (!next->pixels) {
    const String failedPath = next->path;
    next.reset();
    retire(failedPath);
    return reject(psramReady ? ReserveFailure::PixelAllocation : ReserveFailure::PsramLow);
  }
  if (status) *status = current;
  return next;
}

bool AlbumArtStore::publish(const Preparation& frame) {
  if (!frame || !frame->pixels || !frame->image || !frame->imageBytes ||
      frame->imageBytes > AlbumArtPolicy::MAX_IMAGE_BYTES || frame->format == AlbumArtPolicy::Format::Invalid) return false;
  bool found = false;
  portENTER_CRITICAL(&mux_);
  for (size_t i = 0; i < slots_.size(); ++i) {
    if (slots_[i] != frame) continue;
    frame->ready = true;
    published_ = static_cast<int>(i);
    found = true;
    break;
  }
  portEXIT_CRITICAL(&mux_);
  return found;
}

AlbumArtStore::Lease AlbumArtStore::acquire(const String& path) const {
  if (!isPath(path)) return {};
  Lease result;
  portENTER_CRITICAL(&mux_);
  for (const auto& slot : slots_) {
    if (slot && slot->ready && slot->path == path) {
      result = slot;
      break;
    }
  }
  portEXIT_CRITICAL(&mux_);
  return result;
}

AlbumArtStore::Lease AlbumArtStore::find(const String& key) {
  Lease result;
  portENTER_CRITICAL(&mux_);
  for (size_t i = 0; i < slots_.size(); ++i) {
    const auto& slot = slots_[i];
    if (slot && slot->ready && slot->key == key) {
      result = slot;
      published_ = static_cast<int>(i);
      break;
    }
  }
  portEXIT_CRITICAL(&mux_);
  return result;
}

void AlbumArtStore::retire(const String& path) {
  Preparation old;
  portENTER_CRITICAL(&mux_);
  for (size_t i = 0; i < slots_.size(); ++i) {
    if (!slots_[i] || slots_[i]->path != path) continue;
    slots_[i]->ready = false;
    if (published_ == static_cast<int>(i)) published_ = -1;
    // Retain leased retired frames IN the pool until their readers finish;
    // otherwise a slow browser could keep unlimited orphan payloads alive.
    if (slots_[i].use_count() == 1) old = std::move(slots_[i]);
    break;
  }
  portEXIT_CRITICAL(&mux_);
}
