#pragma once
#include "read_only_file.h"

namespace WriteOnlyStorage {
// Fail with an invalid descriptor on memory/I/O pressure. Arduino fopen can
// abort while allocating a newlib FILE mutex before its caller can check it.
// Writes are already batched by the caller; no stdio buffer or new task.
class File {
public:
  File(const char* mount, const char* path) {
    char absolute[320];
    if (ReadOnlyStorage::fullPath(absolute, mount, path))
      fd_ = ::open(absolute, O_WRONLY | O_CREAT | O_TRUNC, 0666);
  }
  ~File() { close(); }
  File(const File&) = delete;
  File& operator=(const File&) = delete;
  explicit operator bool() const { return fd_ >= 0; }
  size_t write(const uint8_t* data, size_t length) {
    if (fd_ < 0 || failed_ || (!data && length)) return 0;
    size_t done = 0;
    while (done < length) {
      const ssize_t count = ::write(fd_, data + done, length - done);
      if (count > 0) done += count;
      else if (count < 0 && errno == EINTR) continue;
      else { failed_ = true; break; }
    }
    return done;
  }
  bool flush() {
    if (fd_ < 0 || failed_) return false;
    int result;
    do { result = ::fsync(fd_); } while (result < 0 && errno == EINTR);
    if (result != 0) failed_ = true;
    return !failed_;
  }
  size_t size() const {
    struct stat info{};
    return fd_ >= 0 && ::fstat(fd_, &info) == 0 && info.st_size >= 0 ? static_cast<size_t>(info.st_size) : 0;
  }
  bool close() {
    if (fd_ >= 0) {
      if (::close(fd_) != 0) failed_ = true;
      fd_ = -1;
    }
    return !failed_;
  }
private:
  int fd_ = -1;
  bool failed_ = false;
};
}
