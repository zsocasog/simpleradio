#pragma once

#include <cstddef>
#include <cstdint>

namespace SpectrumLog {
// Latest complete report only. Logging is best effort, never a dependency of
// PCM capture, the FFT worker, or the LCD's release envelope.
struct Message { char text[512] = {}; };

bool begin();
bool post(const Message& message);
void printf(const char* format, ...) __attribute__((format(printf, 1, 2)));
uint32_t maxWriteUs();
uint32_t skippedWrites();
} // namespace SpectrumLog
