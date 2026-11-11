#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

// Batch ArduinoJson's byte-sized writes without changing the atomic file
// replacement protocol. A short write latches failure until destruction.
template<class Sink> class BufferedWriter {
public:
  explicit BufferedWriter(Sink& sink, void (*cooperate)() = nullptr) : sink_(sink), cooperate_(cooperate) {}
  size_t write(uint8_t byte) { return write(&byte, 1); }
  size_t write(const uint8_t* data, size_t size) {
    size_t accepted = 0;
    while (accepted < size && !failed_) {
      const size_t space = sizeof(buffer_) - used_;
      const size_t count = size - accepted < space ? size - accepted : space;
      memcpy(buffer_ + used_, data + accepted, count);
      used_ += count;
      accepted += count;
      if (used_ == sizeof(buffer_) && !flush()) break;
    }
    return failed_ ? 0 : accepted;
  }
  bool flush() {
    if (failed_) return false;
    if (used_) {
      if (sink_.write(buffer_, used_) != used_) {
        failed_ = true;
        return false;
      }
      // The sink has released its filesystem lock. Let audio/control tasks run
      // before the next batch instead of chaining filesystem transactions.
      if (cooperate_) cooperate_();
    }
    used_ = 0;
    return true;
  }
private:
  Sink& sink_;
  void (*cooperate_)() = nullptr;
  uint8_t buffer_[512]{};
  size_t used_ = 0;
  bool failed_ = false;
};
