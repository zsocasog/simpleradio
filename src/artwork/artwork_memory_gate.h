#pragma once
#include <atomic>
#include <stdint.h>

namespace ArtworkMemory {
// One allocation-free word coordinates station-file I/O scratch and
// album decoding. A waiting album goes before the next station/PNG save.
class Gate {
public:
  bool beginStationSave() {
    uint32_t expected = 0;
    return state_.compare_exchange_strong(expected, StationSave);
  }
  void endStationSave() { state_.fetch_and(~StationSave); }
  bool beginAlbumPrepare() {
    state_.fetch_or(AlbumPending);
    uint32_t expected = AlbumPending;
    return state_.compare_exchange_strong(expected, AlbumActive);
  }
  void endAlbumPrepare() { state_.fetch_and(~AlbumActive); }
  void cancelAlbumWait() { state_.fetch_and(~AlbumPending); }
private:
  static constexpr uint32_t StationSave = 1;
  static constexpr uint32_t AlbumPending = 2;
  static constexpr uint32_t AlbumActive = 4;
  std::atomic<uint32_t> state_{0};
};

inline Gate& gate() { static Gate instance; return instance; }

class AlbumPreparation {
public:
  AlbumPreparation() = default;
  AlbumPreparation(const AlbumPreparation&) = delete;
  AlbumPreparation& operator=(const AlbumPreparation&) = delete;
  ~AlbumPreparation() {
    if (held_) gate().endAlbumPrepare();
    else if (requested_) gate().cancelAlbumWait();
  }
  bool tryAcquire() {
    if (held_) return true;
    requested_ = true;
    held_ = gate().beginAlbumPrepare();
    return held_;
  }
private:
  bool requested_ = false;
  bool held_ = false;
};
} // namespace ArtworkMemory
