#include "../../src/audio/hls_url.h"

using SimpleRadioHls::resolve;

constexpr bool is(const char* base, const char* ref, const char* expected) {
  const auto actual = resolve(base, ref);
  if (!actual.valid) return false;
  for (std::size_t i = 0; i < SimpleRadioHls::URL_CAPACITY; ++i) {
    if (actual.text[i] != expected[i]) return false;
    if (!expected[i]) return true;
  }
  return false;
}

constexpr const char* RADIO = "https://radioitaliasmi.akamaized.net/hls/live/2093120/RISMI/master.m3u8";
static_assert(is(RADIO, "../../2093120/RISMI/stream01/streamPlaylist.m3u8",
                "https://radioitaliasmi.akamaized.net/hls/live/2093120/RISMI/stream01/streamPlaylist.m3u8"));
static_assert(is(RADIO, "../../2093120-b/RISMI/stream01/streamPlaylist.m3u8",
                "https://radioitaliasmi.akamaized.net/hls/live/2093120-b/RISMI/stream01/streamPlaylist.m3u8"));
static_assert(is(RADIO, "stream01/streamPlaylist.m3u8",
                "https://radioitaliasmi.akamaized.net/hls/live/2093120/RISMI/stream01/streamPlaylist.m3u8"));
static_assert(is("http://a/b/c/d;p?q", "g", "http://a/b/c/g"));
static_assert(is("http://a/b/c/d;p?q", "./g", "http://a/b/c/g"));
static_assert(is("http://a/b/c/d;p?q", "g/", "http://a/b/c/g/"));
static_assert(is("http://a/b/c/d;p?q", "/g", "http://a/g"));
static_assert(is("http://a/b/c/d;p?q", "//g/stream.m3u8", "http://g/stream.m3u8"));
static_assert(is("http://a/b/c/d;p?q", "?y", "http://a/b/c/d;p?y"));
static_assert(is("http://a/b/c/d;p?q", "#s", "http://a/b/c/d;p?q"));
static_assert(is("http://a/b/c/d;p?q", "", "http://a/b/c/d;p?q"));
static_assert(is("http://a/b/c/d;p?q", ".", "http://a/b/c/"));
static_assert(is("http://a/b/c/d;p?q", "..", "http://a/b/"));
static_assert(is("http://a/b/c/d;p?q", "../g", "http://a/b/g"));
static_assert(is("http://a/b/c/d;p?q", "../../g", "http://a/g"));
static_assert(is("http://a/b/c/d;p?q", "../../../g", "http://a/g"));
static_assert(is("http://a/b/c/d;p?q", "g/./h", "http://a/b/c/g/h"));
static_assert(is("http://a/b/c/d;p?q", "g/../h", "http://a/b/c/h"));
static_assert(is("https://a:8443/old/master.m3u8?key=abc", "/live/new.m3u8?key=x/../y#z",
                "https://a:8443/live/new.m3u8?key=x/../y"));
static_assert(is("https://a", "live.m3u8", "https://a/live.m3u8"));
static_assert(is("https://a?key=old", "live.m3u8", "https://a/live.m3u8"));
static_assert(is("https://a/master.m3u8", "https://b/a/../live.m3u8", "https://b/live.m3u8"));
static_assert(is("https://a/master.m3u8", "%2e%2e/live%2F1.m3u8", "https://a/%2e%2e/live%2F1.m3u8"));
static_assert(is("https://a/master.m3u8", "dir//stream.m3u8", "https://a/dir//stream.m3u8"));
static_assert(!resolve("https://a/master.m3u8", "ftp://b/x").valid);
static_assert(!resolve("https://a/master.m3u8", "javascript:x").valid);
static_assert(!resolve("https://a/master.m3u8", "bad\npath").valid);
static_assert(!resolve("https://a/master.m3u8", "bad\\path").valid);
static_assert(!resolve("https:///empty", "x").valid);
static_assert(!resolve(nullptr, "x").valid);
static_assert(!resolve("https://a/master.m3u8", nullptr).valid);

constexpr auto oversized() {
  SimpleRadioHls::Url ref;
  for (std::size_t i = 0; i < SimpleRadioHls::URL_CAPACITY - 1; ++i) ref.text[i] = 'a';
  return ref;
}
constexpr auto oversizedRef = oversized();
static_assert(!resolve(RADIO, oversizedRef.text).valid);
