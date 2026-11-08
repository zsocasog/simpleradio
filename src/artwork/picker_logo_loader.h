#pragma once

#include <Arduino.h>
#include <time.h>

namespace PickerLogoLoader {
struct Result {
  String path;
  time_t modified = 0;
  uint16_t* pixels = nullptr;
  Result() = default;
  ~Result();
  Result(const Result&) = delete;
  Result& operator=(const Result&) = delete;
  uint16_t* releasePixels() { uint16_t* value = pixels; pixels = nullptr; return value; }
};

// Only metadata crosses the drawing path. These calls never open files, resize
// pixels, wait for a worker, or access the LCD. Zero means retry on a later tick.
uint32_t request(const String& source, const String& knownPath, time_t knownModified,
                 bool knownReady, int sourceSide, int targetSide);
bool take(uint32_t ticket, Result& result);
void cancel();

// Called by ArtworkCache's existing serial background dispatcher. No second
// image task/stack competes with an active album lookup or station download.
bool pending();
void process();
} // namespace PickerLogoLoader
