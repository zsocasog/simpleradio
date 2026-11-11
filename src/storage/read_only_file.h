#pragma once

#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>
#include "read_io_priority.h"

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
  SR_READ_IO_SCOPE();
  char absolute[320];
  struct stat info{};
  return fullPath(absolute, mount, path) && ::stat(absolute, &info) == 0 && S_ISREG(info.st_mode);
}

inline bool directoryExists(const char* mount, const char* path) {
  SR_READ_IO_SCOPE();
  char absolute[320];
  struct stat info{};
  return fullPath(absolute, mount, path) && ::stat(absolute, &info) == 0 && S_ISDIR(info.st_mode);
}

// Metadata only: Arduino openNextFile() opens every child with fopen(), which
// can abort in newlib's mutex allocation even for a system-status request.
template<class Visitor> bool visitFiles(const char* mount, const char* directory, Visitor visitor) {
  SR_READ_IO_SCOPE();
  char absolute[320];
  if (!fullPath(absolute, mount, directory)) return false;
  DIR* dir = ::opendir(absolute);
  if (!dir) return false;
  const size_t baseLength = strlen(absolute);
  while (const auto* entry = ::readdir(dir)) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    const int count = snprintf(absolute + baseLength, sizeof(absolute) - baseLength, "/%s", entry->d_name);
    if (count < 0 || static_cast<size_t>(count) >= sizeof(absolute) - baseLength) continue;
    struct stat info{};
    if (::stat(absolute, &info) == 0 && S_ISREG(info.st_mode) && info.st_size >= 0)
      visitor(entry->d_name, static_cast<size_t>(info.st_size), info.st_mtime);
  }
  ::closedir(dir);
  return true;
}

inline size_t directoryBytes(const char* mount, const char* directory) {
  size_t total = 0;
  visitFiles(mount, directory, [&](const char*, size_t bytes, time_t) { total += bytes; });
  return total;
}

class File {
public:
  File(const char* mount, const char* path) {
    char absolute[320];
    if (!fullPath(absolute, mount, path)) return;
    SR_READ_IO_SCOPE();
    fd_ = ::open(absolute, O_RDONLY);
    if (fd_ < 0) return;
    struct stat info{};
    if (::fstat(fd_, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size < 0) {
      close();
      return;
    }
    size_ = static_cast<size_t>(info.st_size);
    modified_ = info.st_mtime;
  }
  ~File() { close(); }
  File(const File&) = delete;
  File& operator=(const File&) = delete;
  explicit operator bool() const { return fd_ >= 0; }
  size_t size() const { return size_; }
  time_t modified() const { return modified_; }
  bool seek(size_t offset) {
    SR_READ_IO_SCOPE();
    return fd_ >= 0 && offset <= size_ &&
           ::lseek(fd_, static_cast<off_t>(offset), SEEK_SET) == static_cast<off_t>(offset);
  }
  size_t read(uint8_t* out, size_t length) {
    if (fd_ < 0 || !out) return 0;
    SR_READ_IO_SCOPE();
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
    SR_READ_IO_SCOPE();
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
  }
private:
  int fd_ = -1;
  size_t size_ = 0;
  time_t modified_ = 0;
};
} // namespace ReadOnlyStorage
