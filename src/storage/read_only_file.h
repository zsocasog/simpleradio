#pragma once

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

// Arduino File/exists() call fopen(). Newlib lazily creates FILE mutexes there
// and aborts, rather than returning an error, if internal RAM is exhausted.
// Read-only cache probes and HTTP readers must use fallible VFS descriptors.
namespace ReadOnlyStorage {
inline bool fullPath(char (&out)[320], const char* mount, const char* path) {
  if (!mount || !*mount || !path || path[0] != '/') return false;
  const int count = snprintf(out, sizeof(out), "%s%s", mount, path);
  return count > 0 && static_cast<size_t>(count) < sizeof(out);
}

inline bool exists(const char* mount, const char* path) {
  char absolute[320];
  struct stat info{};
  return fullPath(absolute, mount, path) && ::stat(absolute, &info) == 0 && S_ISREG(info.st_mode);
}

class File {
public:
  File(const char* mount, const char* path) {
    char absolute[320];
    if (!fullPath(absolute, mount, path)) return;
    fd_ = ::open(absolute, O_RDONLY);
    if (fd_ < 0) return;
    struct stat info{};
    if (::fstat(fd_, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size < 0) {
      close();
      return;
    }
    size_ = static_cast<size_t>(info.st_size);
  }
  ~File() { close(); }
  File(const File&) = delete;
  File& operator=(const File&) = delete;
  explicit operator bool() const { return fd_ >= 0; }
  size_t size() const { return size_; }
  bool seek(size_t offset) {
    return fd_ >= 0 && offset <= size_ &&
           ::lseek(fd_, static_cast<off_t>(offset), SEEK_SET) == static_cast<off_t>(offset);
  }
  size_t read(uint8_t* out, size_t length) {
    if (fd_ < 0 || !out) return 0;
    size_t done = 0;
    while (done < length) {
      const ssize_t count = ::read(fd_, out + done, length - done);
      if (count > 0) done += static_cast<size_t>(count);
      else if (count < 0 && errno == EINTR) continue;
      else break;
    }
    return done;
  }
  void close() {
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
  }
private:
  int fd_ = -1;
  size_t size_ = 0;
};
} // namespace ReadOnlyStorage
