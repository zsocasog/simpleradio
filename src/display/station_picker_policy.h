#pragma once

#include <stdint.h>

namespace StationPickerPolicy {
constexpr uint32_t INPUT_SETTLE_MS = 120;
constexpr uint32_t LOGO_STEP_US = 2000;
constexpr int LOGO_ROWS_PER_STEP = 2;
constexpr uint32_t READY_LOGO_RECHECK_MS = 5000;
constexpr uint32_t MISSING_LOGO_RECHECK_MS = 1000;

inline bool elapsedAtLeast(uint32_t now, uint32_t since, uint32_t delay) {
  return static_cast<uint32_t>(now - since) >= delay;
}

inline bool autoPlayReady(uint32_t now, uint32_t opened, uint32_t changed,
                          uint32_t presented, uint32_t openGuard, uint32_t delay) {
  return changed != 0 && elapsedAtLeast(now, opened, openGuard) &&
         elapsedAtLeast(now, changed, delay) && elapsedAtLeast(now, presented, delay);
}
}
