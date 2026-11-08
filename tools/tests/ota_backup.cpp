#include "../../src/storage/ota_backup.h"
#include <cstdlib>
#include <cstring>

// Instantiate the exact template used by the firmware with binary payloads.
bool exerciseOtaBackup() {
  OtaBackup::Snapshot backup([](size_t n) { return static_cast<uint8_t*>(std::malloc(n)); }, std::free);
  const uint8_t png[] = {137, 80, 78, 71, 0, 255, 0, 128};
  if (!backup.add("/logos/station-6-radio-1.png", sizeof(png), [&](uint8_t* out, size_t n) {
    std::memcpy(out, png, n); return true;
  })) return false;
  return backup.restore([&](const char*, const uint8_t* data, size_t n) {
    return n == sizeof(png) && std::memcmp(data, png, n) == 0;
  });
}
