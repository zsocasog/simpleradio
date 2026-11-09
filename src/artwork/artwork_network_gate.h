#pragma once
#include <atomic>

namespace ArtworkHttp {
// Register a background request BEFORE checking audio's reservation. An audio
// reservation made at the same time either sees the registered request, or
// prevents it from opening its socket. No other task closes a live TLS object.
class NetworkGate {
public:
  void reserveAudio() { audio_.store(true); }
  void releaseAudio() { audio_.store(false); }
  bool audioReserved() const { return audio_.load(); }
  void reserveSettingsSave() { settingsSave_.store(true); }
  void releaseSettingsSave() { settingsSave_.store(false); }
  bool settingsSaveReserved() const { return settingsSave_.load(); }
  bool backgroundActive() const { return background_.load(); }
  bool beginBackground() {
    bool expected = false;
    if (!background_.compare_exchange_strong(expected, true)) return false;
    if (audioReserved() || settingsSaveReserved()) { endBackground(); return false; }
    return true;
  }
  void endBackground() { background_.store(false); }
private:
  std::atomic<bool> audio_{false};
  std::atomic<bool> background_{false};
  std::atomic<bool> settingsSave_{false};
};
} // namespace ArtworkHttp
