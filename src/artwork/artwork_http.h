#pragma once

#include <Arduino.h>
#include <functional>

// The network phase owns a bounded PSRAM buffer. Filesystem work must happen
// after it returns, with the HTTP/TLS connection already closed.
namespace ArtworkHttp {
struct Response {
  uint8_t* data = nullptr;
  size_t size = 0;
  int status = 0;
  String contentType;
  String location;
  String error;

  Response() = default;
  ~Response();
  Response(const Response&) = delete;
  Response& operator=(const Response&) = delete;
};

struct Options {
  uint32_t deadlineMs = 0;
  bool followRedirects = true;
  bool allowHttps = true;
  String range;
  std::function<bool()> cancelled;
};

bool get(const String& url, size_t limit, Response& response, const Options& options = {});
void reserveAudioConnection();
bool backgroundNetworkActive();
uint32_t settingsYieldCount();
void releaseAudioConnection();
// Ask the owning worker to close/retry its request cooperatively. The main
// loop never touches its TLS object and releases the reservation after save.
void reserveSettingsSave();
void releaseSettingsSave();
String publicImageUrl(const String& url);
String host(const String& url);
} // namespace ArtworkHttp
