#include "../../src/artwork/artwork_memory_gate.h"
#include <cassert>

// Exercise the same atomic gate compiled for the ESP32. The host test controls
// equivalent interleavings; this target also verifies its C++ and atomic API.
int main() {
  ArtworkMemory::Gate gate;
  assert(gate.beginStationSave());
  assert(!gate.beginAlbumPrepare());
  gate.endStationSave();
  assert(!gate.beginStationSave());
  assert(gate.beginAlbumPrepare());
  assert(!gate.beginStationSave());
  gate.endAlbumPrepare();
  assert(gate.beginStationSave());
  assert(!gate.beginAlbumPrepare());
  gate.cancelAlbumWait();
  gate.endStationSave();
  assert(gate.beginStationSave());
  return 0;
}
