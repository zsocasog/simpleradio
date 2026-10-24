#pragma once

#include <cstddef>

// RFC 3986 path resolution for the pinned decoder's HLS master playlists.
// Fixed bounds, no heap allocation, no HTTP requests, and testable at compile time.
namespace SimpleRadioHls {
constexpr std::size_t URL_CAPACITY = 2048;

struct Url {
  char text[URL_CAPACITY] = {};
  std::size_t size = 0;
  bool valid = false;
};

constexpr char lower(char c) { return c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c; }

constexpr bool starts(const char* text, const char* prefix, bool ignoreCase = false) {
  for (std::size_t i = 0; prefix[i]; ++i) {
    if (!text[i] || (ignoreCase ? lower(text[i]) != lower(prefix[i]) : text[i] != prefix[i])) return false;
  }
  return true;
}

constexpr std::size_t length(const char* text) {
  if (!text) return URL_CAPACITY;
  std::size_t n = 0;
  while (n < URL_CAPACITY && text[n]) ++n;
  return n;
}

constexpr std::size_t schemeSize(const char* text) {
  return starts(text, "https://", true) ? 8 : starts(text, "http://", true) ? 7 : 0;
}

constexpr bool append(Url& result, const char* text, std::size_t from, std::size_t end) {
  if (end < from || result.size + end - from >= URL_CAPACITY) return false;
  for (std::size_t i = from; i < end; ++i) result.text[result.size++] = text[i];
  result.text[result.size] = '\0';
  return true;
}

constexpr Url resolve(const char* base, const char* reference) {
  const std::size_t baseSize = length(base), refSize = length(reference);
  if (baseSize >= URL_CAPACITY || refSize >= URL_CAPACITY) return {};
  // Do not turn a foreign scheme, whitespace or a backslash into a relative URL.
  for (std::size_t i = 0; i < refSize; ++i) {
    if (static_cast<unsigned char>(reference[i]) <= 32 || reference[i] == '\\') return {};
  }
  Url merged;
  if (schemeSize(reference)) {
    if (!append(merged, reference, 0, refSize)) return {};
  } else {
    const std::size_t scheme = schemeSize(base);
    if (!scheme) return {};
    std::size_t originEnd = scheme;
    while (originEnd < baseSize && base[originEnd] != '/' && base[originEnd] != '?' && base[originEnd] != '#') ++originEnd;
    if (originEnd == scheme) return {};
    if (starts(reference, "//")) {
      if (!append(merged, base, 0, scheme - 2) || !append(merged, reference, 0, refSize)) return {};
    } else {
      for (std::size_t i = 0; i < refSize && reference[i] != '/' && reference[i] != '?' && reference[i] != '#'; ++i) {
        if (reference[i] == ':') return {};
      }
      std::size_t keep = baseSize;
      for (std::size_t i = originEnd; i < baseSize; ++i) {
        if (base[i] == '#' || (refSize && reference[0] != '#' && base[i] == '?')) { keep = i; break; }
      }
      if (reference[0] == '/') {
        keep = originEnd;
      } else if (refSize && reference[0] != '?' && reference[0] != '#') {
        while (keep > originEnd && base[keep - 1] != '/') --keep;
      }
      if (!append(merged, base, 0, keep)) return {};
      if (keep == originEnd && reference[0] != '/' && !append(merged, "/", 0, 1)) return {};
      if (!append(merged, reference, 0, refSize)) return {};
    }
  }

  const std::size_t scheme = schemeSize(merged.text);
  std::size_t originEnd = scheme;
  while (originEnd < merged.size && merged.text[originEnd] != '/' && merged.text[originEnd] != '?' && merged.text[originEnd] != '#') ++originEnd;
  if (!scheme || originEnd == scheme) return {};
  std::size_t pathEnd = originEnd;
  while (pathEnd < merged.size && merged.text[pathEnd] != '?' && merged.text[pathEnd] != '#') ++pathEnd;
  Url result;
  if (!append(result, merged.text, 0, originEnd)) return {};
  if (pathEnd == originEnd && !append(result, "/", 0, 1)) return {};
  for (std::size_t i = originEnd; i < pathEnd;) {
    const std::size_t remaining = pathEnd - i;
    const bool dot = remaining >= 2 && merged.text[i] == '/' && merged.text[i + 1] == '.';
    if (dot && (remaining == 2 || merged.text[i + 2] == '/')) {
      i += 2;
      if (i == pathEnd && !append(result, "/", 0, 1)) return {};
    } else if (dot && remaining >= 3 && merged.text[i + 2] == '.' &&
               (remaining == 3 || merged.text[i + 3] == '/')) {
      while (result.size > originEnd && result.text[result.size - 1] != '/') --result.size;
      if (result.size > originEnd) --result.size;
      result.text[result.size] = '\0';
      i += 3;
      if (i == pathEnd && !append(result, "/", 0, 1)) return {};
    } else {
      std::size_t end = i + 1;
      while (end < pathEnd && merged.text[end] != '/') ++end;
      if (!append(result, merged.text, i, end)) return {};
      i = end;
    }
  }
  std::size_t end = pathEnd;
  while (end < merged.size && merged.text[end] != '#') ++end;
  if (!append(result, merged.text, pathEnd, end)) return {};
  result.valid = true;
  return result;
}
} // namespace SimpleRadioHls
