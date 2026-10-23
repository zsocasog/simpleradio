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
String publicImageUrl(const String& url);
String host(const String& url);
} // namespace ArtworkHttp
