#pragma once
#include <stddef.h>
#include <stdint.h>
#include <time.h>
#include "../storage/read_only_file.h"

// Only derived SR56 station pixels live here. Original uploads stay on disk.
// Eight slots INCLUDING retired readers: slow clients cannot retain orphans.
namespace LcdThumbnailRam {
constexpr size_t Slots = 8;
constexpr size_t MaxSide = 176;
struct Stats { size_t slots = 0, bytes = 0, readers = 0; uint32_t published = 0; };
Stats stats();
class Lease {
public:
  Lease() = default;
  ~Lease();
  Lease(Lease&& other) noexcept;
  Lease& operator=(Lease&& other) noexcept;
  Lease(const Lease&) = delete;
  Lease& operator=(const Lease&) = delete;
  explicit operator bool() const { return slot_ >= 0; }
  size_t size() const { return bytes_; }
  time_t modified() const { return modified_; }
  size_t read(uint8_t* out, size_t count, size_t offset) const;
private:
  friend Lease acquire(const char* path);
  int slot_ = -1;
  const uint8_t* data_ = nullptr;
  size_t bytes_ = 0;
  time_t modified_ = 0;
};
Lease acquire(const char* path);
bool contains(const char* path);
bool publish(const char* path, const uint8_t* pixels, size_t side);
void retire(const char* path);

// Same bounded file interface for LCD, picker and the legacy BMP endpoint.
// A lease pins immutable pixels across replacement and cache eviction.
class File {
public:
  File(const char* mount, const char* path) : ram_(acquire(path)), file_(ram_ ? nullptr : mount, path) {}
  explicit operator bool() const { return static_cast<bool>(ram_) || static_cast<bool>(file_); }
  size_t size() const { return ram_ ? ram_.size() : file_.size(); }
  time_t getLastWrite() const { return ram_ ? ram_.modified() : file_.modified(); }
  bool seek(size_t offset) {
    if (!ram_) return file_.seek(offset);
    if (offset > ram_.size()) return false;
    offset_ = offset; return true;
  }
  size_t read(uint8_t* out, size_t count) {
    if (!ram_) return file_.read(out, count);
    const size_t done = ram_.read(out, count, offset_); offset_ += done; return done;
  }
  void close() { ram_ = Lease(); file_.close(); }
private:
  Lease ram_;
  ReadOnlyStorage::File file_;
  size_t offset_ = 0;
};
}
