#include "artwork_http.h"
#include "artwork_http_policy.h"

#include <HTTPClient.h>
#include <NetworkClient.h>
#include <NetworkClientSecure.h>
#include <WiFi.h>
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

namespace ArtworkHttp {
namespace {
constexpr uint32_t CONNECT_MS = 3500;
constexpr uint16_t READ_MS = 6000;
constexpr uint32_t REQUEST_MS = 12000;

bool expired(uint32_t deadline) {
  return deadline && static_cast<int32_t>(millis() - deadline) >= 0;
}

uint32_t remaining(uint32_t deadline, uint32_t normal) {
  if (!deadline) return normal;
  if (expired(deadline)) return 1;
  return min<uint32_t>(normal, deadline - millis());
}

struct Transfer {
  const Options& options;
  uint32_t lastYieldMs = 0;
  uint32_t lastCancelCheckMs = 0;
  bool stopped = false;

  bool service() {
    if (stopped) return false;
    const uint32_t now = millis();
    if (expired(options.deadlineMs) || WiFi.status() != WL_CONNECTED) stopped = true;
    if (!stopped && options.cancelled &&
        (!lastCancelCheckMs || now - lastCancelCheckMs >= 100)) {
      lastCancelCheckMs = now;
      stopped = options.cancelled();
    }
    if (now - lastYieldMs >= 20) {
      lastYieldMs = now;
      vTaskDelay(1);
    }
    return !stopped;
  }
};

// HTTPClient also polls while reading headers and chunk sizes. Service the
// watchdog/cancellation there, not only in the image-body loop.
template<class Base> class CooperativeClient : public Base {
public:
  explicit CooperativeClient(Transfer& transfer) : transfer(transfer) {}

  void expectBody(int length, bool chunked) { bodyBoundary.begin(length, chunked); }
  const String& connectionFailure() const { return connectionFailure_; }

  int connect(IPAddress ip, uint16_t port, int32_t timeout) override {
    if (!service()) return 0;
    return Base::connect(ip, port, boundedConnect(timeout));
  }
  int connect(const char* name, uint16_t port, int32_t timeout) override {
    if (!service()) return 0;
    return Base::connect(name, port, boundedConnect(timeout));
  }
  int available() override {
    return service() ? Base::available() : 0;
  }
  int read() override {
    uint8_t byte = 0;
    const int result = read(&byte, 1);
    return result == 1 ? byte : -1;
  }
  int read(uint8_t* buffer, size_t size) override {
    if (!service()) return -1;
    const int received = Base::read(buffer, size);
    // HTTPClient polls available()/connected() again after its last body
    // block and while disconnecting. On a Connection: close TLS response that
    // can read past the complete payload and produce a spurious -76. We never
    // reuse this connection; close as soon as the declared payload is read.
    if (received > 0 && bodyBoundary.consume(static_cast<size_t>(received))) Base::stop();
    return received;
  }
  uint8_t connected() override {
    return service() ? Base::connected() : 0;
  }

protected:
  bool service() {
    if (transfer.service()) return true;
    Base::stop();
    return false;
  }
  int32_t boundedConnect(int32_t requested) {
    const uint32_t normal = requested > 0 ? min<uint32_t>(requested, CONNECT_MS) : CONNECT_MS;
    return remaining(transfer.options.deadlineMs, normal);
  }
  Transfer& transfer;
  String connectionFailure_;
  ArtworkHttpPolicy::BodyBoundary bodyBoundary;
};

// A continuously scheduled FFT/LCD can starve an idle-priority TLS handshake.
// Share their priority ONLY while establishing a connection. Audio remains at
// priority 2; body downloads, image decoding and flash work stay at the caller's
// original background priority. No scheduler/core/library global is changed.
class TlsPriorityScope {
public:
  TlsPriorityScope() : original_(uxTaskPriorityGet(nullptr)) {
    if (original_ == tskIDLE_PRIORITY) vTaskPrioritySet(nullptr, tskIDLE_PRIORITY + 1);
  }
  ~TlsPriorityScope() {
    if (original_ == tskIDLE_PRIORITY) vTaskPrioritySet(nullptr, original_);
  }
private:
  UBaseType_t original_;
};

class SecureArtworkClient : public CooperativeClient<NetworkClientSecure> {
public:
  explicit SecureArtworkClient(Transfer& transfer) : CooperativeClient(transfer) {}
  int connect(const char* name, uint16_t port, int32_t timeout) override {
    return establish([&]() { return NetworkClientSecure::connect(name, port, boundedConnect(timeout)); });
  }
  int connect(IPAddress ip, uint16_t port, int32_t timeout) override {
    return establish([&]() { return NetworkClientSecure::connect(ip, port, boundedConnect(timeout)); });
  }
private:
  template<class Connect> int establish(Connect connectSocket) {
    connectionFailure_ = "";
    if (!transfer.service()) return 0;
    TlsPriorityScope priority;
    // PlainStart prepares TCP and TLS state but sends NO application data.
    // HTTPClient only receives success after the encrypted handshake below.
    setPlainStart();
    const uint32_t setupStarted = millis();
    if (!connectSocket()) {
      failure("TCP/TLS setup", millis() - setupStarted, sslclient->last_error);
      return 0;
    }
    const uint32_t setupMs = millis() - setupStarted;
    if (!transfer.service()) { NetworkClientSecure::stop(); return 0; }
    setHandshakeTimeout(max<uint32_t>(1, (remaining(transfer.options.deadlineMs, 6000) + 999) / 1000));
    const uint32_t tlsStarted = millis();
    // The core's startTLS() discards the handshake return code. Use its same
    // pinned native helper so cancellation boundaries and the real error stay
    // visible, without changing the crypto implementation or trust settings.
    const int result = ssl_starttls_handshake(sslclient.get());
    sslclient->last_error = result;
    if (result < 0) {
      failure("TLS handshake", millis() - tlsStarted, result);
      connectionFailure_ += "; setup=" + String(setupMs) + "ms";
      NetworkClientSecure::stop();
      return 0;
    }
    _stillinPlainStart = false;
    if (!transfer.service()) { NetworkClientSecure::stop(); return 0; }
    return 1;
  }
  void failure(const char* phase, uint32_t elapsedMs, int code) {
    connectionFailure_ = String(phase) + " failed: code=" + String(code) + " elapsed=" + String(elapsedMs) +
        "ms internal=" + String(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)) +
        " largest=" + String(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  }
};

class BufferSink : public Stream {
public:
  BufferSink(size_t capacity, Transfer& transfer) : capacity(capacity), transfer(transfer) {
    data = static_cast<uint8_t*>(heap_caps_malloc(capacity, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    // Small metadata responses can still work on a board without PSRAM.
    if (!data && capacity <= 32768) data = static_cast<uint8_t*>(malloc(capacity));
  }
  ~BufferSink() override { free(data); }
  size_t write(uint8_t byte) override { return write(&byte, 1); }
  size_t write(const uint8_t* bytes, size_t length) override {
    if (!data || !transfer.service()) return 0;
    if (length > capacity - size) { limitExceeded = true; return 0; }
    memcpy(data + size, bytes, length);
    size += length;
    return length;
  }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
  uint8_t* release() { uint8_t* result = data; data = nullptr; return result; }
  uint8_t* data = nullptr;
  size_t size = 0;
  bool limitExceeded = false;
private:
  size_t capacity;
  Transfer& transfer;
};

bool redirectStatus(int status) {
  return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
}

String redirectUrl(const String& current, const String& location) {
  if (location.startsWith("http://") || location.startsWith("https://")) return location;
  const int scheme = current.indexOf("://");
  if (scheme < 0) return "";
  if (location.startsWith("//")) return current.substring(0, scheme + 1) + location;
  const int path = current.indexOf('/', scheme + 3);
  const String origin = path < 0 ? current : current.substring(0, path);
  if (location.startsWith("/")) return origin + location;
  const int slash = current.lastIndexOf('/');
  return (slash > scheme + 2 ? current.substring(0, slash + 1) : origin + "/") + location;
}

template<class Client> bool request(Client& client, const String& url, size_t limit,
                                    Response& response, Transfer& transfer) {
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(remaining(transfer.options.deadlineMs, CONNECT_MS));
  http.setTimeout(remaining(transfer.options.deadlineMs, READ_MS));
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  http.setUserAgent("SimpleRadio/1.0.27 (https://github.com/zsocasog/simpleradio)");
  const char* headers[] = {"Content-Type", "Transfer-Encoding"};
  http.collectHeaders(headers, 2);
  auto finish = [&]() {
    // This is a one-shot request. Do not drain/poll a socket that the server
    // may already have closed after a complete response or a rejected status.
    client.stop();
    http.end();
  };
  if (!http.begin(client, url)) {
    response.error = "HTTP begin failed";
    return false;
  }
  if (transfer.options.range.length()) http.addHeader("Range", transfer.options.range);
  response.status = http.GET();
  response.location = http.getLocation();
  response.contentType = http.header("Content-Type");
  if (redirectStatus(response.status)) {
    finish();
    return true;
  }
  const int expectedStatus = transfer.options.range.length() ? HTTP_CODE_PARTIAL_CONTENT : HTTP_CODE_OK;
  if (response.status != expectedStatus) {
    response.error = "HTTP " + String(response.status);
    if (response.status < 0 && client.connectionFailure().length()) response.error += "; " + client.connectionFailure();
    finish();
    return false;
  }
  const int length = http.getSize();
  if (length == 0 || (length > 0 && static_cast<size_t>(length) > limit)) {
    response.error = "invalid/oversized body: " + String(length) + " limit=" + String(limit);
    finish();
    return false;
  }
  BufferSink sink(length > 0 ? static_cast<size_t>(length) : limit, transfer);
  if (!sink.data) {
    response.error = "response buffer allocation failed";
    finish();
    return false;
  }
  // writeToStream decodes Transfer-Encoding: chunked. getStream() does not;
  // passing that raw socket to ArduinoJson caused Invalid/IncompleteInput.
  String encoding = http.header("Transfer-Encoding");
  encoding.toLowerCase();
  client.expectBody(length, encoding.indexOf("chunked") >= 0);
  const int written = http.writeToStream(&sink);
  finish();
  if (sink.limitExceeded) {
    response.error = "response size limit reached: limit=" + String(limit) + " bytes=" + String(sink.size);
    return false;
  }
  if (!transfer.service() || written < 0 || !sink.size ||
      (length > 0 && sink.size != static_cast<size_t>(length))) {
    response.error = "body read failed: code=" + String(written) + " bytes=" + String(sink.size) +
                     " expected=" + String(length);
    return false;
  }
  response.size = sink.size;
  response.data = sink.release();
  return true;
}
} // namespace

Response::~Response() { free(data); }

String host(const String& url) {
  const int scheme = url.indexOf("://");
  if (scheme < 0) return "";
  int end = url.indexOf('/', scheme + 3);
  if (end < 0) end = url.length();
  String result = url.substring(scheme + 3, end);
  result.toLowerCase();
  return result;
}

String publicImageUrl(const String& url) {
  if (!url.startsWith("https://")) return url;
  const String server = host(url);
  // Only public artwork hosts verified to serve HTTP. Keep API keys, signed
  // URLs and arbitrary station endpoints on their advertised transport.
  if (url.indexOf('?') >= 0 || url.indexOf('@') >= 0) return url;
  if (server == "lastfm-img.freetls.fastly.net" || server == "cdn-images.dzcdn.net" ||
      server.endsWith(".mzstatic.com") || server == "i.imgur.com" ||
      server == "coverartarchive.org" || server == "archive.org" ||
      server.endsWith(".archive.org")) return "http://" + url.substring(8);
  return url;
}

bool get(const String& url, size_t limit, Response& response, const Options& supplied) {
  Options options = supplied;
  if (!options.deadlineMs || (!expired(options.deadlineMs) &&
                             options.deadlineMs - millis() > REQUEST_MS)) {
    options.deadlineMs = millis() + REQUEST_MS;
  }
  Transfer transfer{options};
  String current = url;
  for (unsigned redirects = 0; redirects <= 4; ++redirects) {
    if (!transfer.service()) break;
    bool ok = false;
    if (current.startsWith("https://")) {
      if (!options.allowHttps) {
        response.error = "HTTPS deferred during audio connection";
        return false;
      }
      SecureArtworkClient client(transfer);
      client.setInsecure();
      client.setHandshakeTimeout(max<uint32_t>(1, (remaining(options.deadlineMs, 6000) + 999) / 1000));
      ok = request(client, current, limit, response, transfer);
    } else if (current.startsWith("http://")) {
      CooperativeClient<NetworkClient> client(transfer);
      ok = request(client, current, limit, response, transfer);
    } else {
      response.error = "unsupported URL scheme";
      return false;
    }
    if (!ok) break;
    if (!redirectStatus(response.status) || !options.followRedirects) return true;
    if (!response.location.length()) break;
    current = redirectUrl(current, response.location);
  }
  if (expired(options.deadlineMs)) response.error = "network deadline reached; " + response.error;
  else if (transfer.stopped) response.error = "network cancelled; " + response.error;
  else if (!response.error.length()) response.error = "redirect limit reached";
  return false;
}
} // namespace ArtworkHttp
