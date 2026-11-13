#pragma once
#include <stdint.h>

namespace HandshakeSlices {
// The pinned native TLS helper returns -1 on its WANT_READ/WRITE timeout,
// retaining the handshake context. Resume that SAME context in short slices;
// never recreate TLS state or close it from another task.
template<class Step, class Continue, class Clock>
int run(Step step, Continue keepGoing, Clock clock, uint32_t limitMs) {
  const uint32_t started = clock();
  while (keepGoing()) {
    const uint32_t elapsed = static_cast<uint32_t>(clock() - started);
    if (elapsed >= limitMs) break;
    const uint32_t left = limitMs - elapsed;
    const int result = step(left < 100U ? left : 100U);
    if (result != -1) return result;
  }
  return -1;
}
}
