#pragma once
#include <stddef.h>
#include <string.h>
#include <esp_heap_caps.h>

// Immutable response ownership after assignment. A queued JSON reply must not
// pin a second multi-kilobyte copy in the same RAM needed by TCP and Wi-Fi.
// Allocation failure is visible to the server's existing invalid-source path.
class SimpleRadioResponseText {
public:
  ~SimpleRadioResponseText() { heap_caps_free(data_); }
  SimpleRadioResponseText() = default;
  SimpleRadioResponseText(const SimpleRadioResponseText&) = delete;
  SimpleRadioResponseText& operator=(const SimpleRadioResponseText&) = delete;
  SimpleRadioResponseText& operator=(const char* text) {
    if (text == data_) return *this;
    heap_caps_free(data_);
    data_ = nullptr;
    size_ = text ? strlen(text) : 0;
    valid_ = true;
    if (size_) {
      data_ = static_cast<char*>(heap_caps_malloc(size_ + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
      if (!data_) { size_ = 0; valid_ = false; }
      else memcpy(data_, text, size_ + 1);
    }
    return *this;
  }
  size_t length() const { return size_; }
  const char* c_str() const { return data_ ? data_ : ""; }
  bool valid() const { return valid_; }
private:
  char* data_ = nullptr;
  size_t size_ = 0;
  bool valid_ = true;
};
