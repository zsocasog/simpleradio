#pragma once
#include <errno.h>
#include <stdint.h>
namespace AtomicReplace {
// ESP LittleFS returns EBUSY for an open source OR destination. The caller
// has closed its writer; a short-lived reader may still be finishing.
template<class Rename, class Clock, class Pause>
bool retryBusy(Rename rename, Clock clock, Pause pause, uint32_t limitMs) {
  const uint32_t started = clock();
  for (;;) {
    errno = 0;
    if (rename()) return true;
    if (errno != EBUSY || static_cast<uint32_t>(clock() - started) >= limitMs) return false;
    pause(); // Never hold a filesystem mutex while waiting for a reader.
  }
}
}
