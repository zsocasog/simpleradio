#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

// Batch ArduinoJson's byte-sized writes without changing the atomic file
// replacement protocol. A short write latches failure until destruction.
template<class Sink> class BufferedWriter {
public:
  explicit BufferedWriter(Sink& sink) : sink_(sink) {}
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
    if (used_ && sink_.write(buffer_, used_) != used_) {
      failed_ = true;
      return false;
    }
    used_ = 0;
    return true;
  }
private:
  Sink& sink_;
  uint8_t buffer_[512]{};
  size_t used_ = 0;
  bool failed_ = false;
};
