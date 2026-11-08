#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace OtaBackup {
constexpr size_t MAX_BYTES = 4 * 1024 * 1024;
constexpr size_t MAX_FILES = 128;
constexpr size_t MAX_PATH = 160;

// Binary-safe payloads use only the allocator supplied by the firmware (PSRAM).
// A failed capture must abort the update BEFORE the old filesystem is erased.
class Snapshot {
public:
  using Allocate = uint8_t* (*)(size_t);
  using Release = void (*)(void*);
  Snapshot(Allocate allocate, Release release) : allocate_(allocate), release_(release) {}
  ~Snapshot() { clear(); }
  Snapshot(const Snapshot&) = delete;
  Snapshot& operator=(const Snapshot&) = delete;

  template<class Reader>
  bool add(std::string_view path, size_t size, Reader read) {
    if (path.empty() || path.size() > MAX_PATH || entries_.size() >= MAX_FILES || size > MAX_BYTES - bytes_) return false;
    for (const auto& entry : entries_) if (std::string_view(entry.path) == path) return false;
    uint8_t* data = size ? allocate_(size) : nullptr;
    if (size && !data) return false;
    if (size && !read(data, size)) { release_(data); return false; }
    entries_.push_back({std::string(path), data, size});
    bytes_ += size;
    return true;
  }

  template<class Writer>
  bool restore(Writer write) const {
    for (const auto& entry : entries_) {
      if (!write(entry.path.c_str(), entry.data, entry.size)) return false;
    }
    return true;
  }

  void clear() {
    for (auto& entry : entries_) if (entry.data) release_(entry.data);
    entries_.clear();
    bytes_ = 0;
  }
  size_t bytes() const { return bytes_; }
  size_t count() const { return entries_.size(); }

private:
  struct Entry { std::string path; uint8_t* data; size_t size; };
  Allocate allocate_;
  Release release_;
  std::vector<Entry> entries_;
  size_t bytes_ = 0;
};
} // namespace OtaBackup
