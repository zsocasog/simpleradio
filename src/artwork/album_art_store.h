#pragma once

#include <Arduino.h>
#include <array>
#include <freertos/FreeRTOS.h>
#include <memory>
#include "album_art_policy.h"

// The compressed web image and decoded LCD pixels share the same lifetime.
// Mutable only in the worker BEFORE publish(); readers receive const leases.
struct AlbumArtFrame {
  String key;
  String path;
  uint8_t* image = nullptr;
  size_t imageBytes = 0;
  uint16_t* pixels = nullptr;
  uint16_t side = 0;
  AlbumArtPolicy::Format format = AlbumArtPolicy::Format::Invalid;
  ~AlbumArtFrame();
  size_t read(uint8_t* out, size_t requested, size_t offset) const;

private:
  friend class AlbumArtStore;
  bool ready = false;
};

class AlbumArtStore {
public:
  using Lease = std::shared_ptr<const AlbumArtFrame>;
  using Preparation = std::shared_ptr<AlbumArtFrame>;
  static constexpr const char* ROUTE = "/api/artwork/album";
  static constexpr const char* PATH_PREFIX = "/api/artwork/album?id=";

  static AlbumArtStore& instance();
  static bool isPath(const String& path);
  Preparation reserve(const String& key, uint16_t side);
  bool publish(const Preparation& frame);
  Lease acquire(const String& path) const;
  Lease find(const String& key); // Reusing a cached track selects its slot as current.
  void retire(const String& path);

private:
  AlbumArtStore() = default;
  // Never free image payloads, allocate, decode, or draw while holding mux_.
  mutable portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
  std::array<Preparation, AlbumArtPolicy::SLOT_COUNT> slots_{};
  int published_ = -1;
  uint32_t sequence_ = 0;
};
