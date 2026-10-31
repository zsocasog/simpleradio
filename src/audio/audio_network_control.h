#pragma once
#include <Arduino.h>

// Used only by the stream connection/header path, never by the decoder or PCM
// callback. The application remains the sole owner of the Audio instance.
namespace SimpleRadioAudio {
using ContinueNetwork = bool (*)(void*);
inline ContinueNetwork continueNetwork = nullptr;
inline void* networkOwner = nullptr;
inline uint32_t lastNetworkYieldMs = 0;

inline bool serviceNetwork(bool forceCheck = false) {
  const uint32_t now = millis();
  if (!forceCheck && now - lastNetworkYieldMs < 10) return true;
  lastNetworkYieldMs = now;
  // Header polling in the pinned library otherwise spins at priority 2 and
  // starves the main loop which applies stop/station commands at priority 1.
  vTaskDelay(1);
  return !continueNetwork || continueNetwork(networkOwner);
}
} // namespace SimpleRadioAudio
