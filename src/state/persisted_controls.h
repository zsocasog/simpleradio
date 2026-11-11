#pragma once

namespace PersistedControls {
struct Value {
  int stationId, volume;
  bool playing;
  int eqLow, eqMid, eqHigh, balance;
  bool operator==(const Value& other) const {
    return stationId == other.stationId && volume == other.volume && playing == other.playing &&
           eqLow == other.eqLow && eqMid == other.eqMid && eqHigh == other.eqHigh && balance == other.balance;
  }
};
// The main task owns state persistence. Remember only a successful durable
// write, never a requested/UI state. Missing files and failed writes retry.
class Cache {
public:
  template<class Writer> bool save(const Value& value, bool filePresent, Writer write) {
    if (known_ && filePresent && last_ == value) return true;
    if (!write()) return false;
    last_ = value;
    known_ = true;
    return true;
  }
  void invalidate() { known_ = false; }
private:
  Value last_{};
  bool known_ = false;
};
}
