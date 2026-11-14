#pragma once
#include <stddef.h>
#include <initializer_list>
#include <string_view>

namespace StationImportPolicy {
constexpr size_t MAX_BYTES = 128 * 1024;
constexpr size_t MAX_STATIONS = 500;
constexpr size_t MAX_NAME_BYTES = 160;
constexpr size_t MAX_URL_BYTES = 2048;

constexpr std::string_view trim(std::string_view text) {
  while (!text.empty() && (text.front() == ' ' || text.front() == '\t' || text.front() == '\r' || text.front() == '\n')) text.remove_prefix(1);
  while (!text.empty() && (text.back() == ' ' || text.back() == '\t' || text.back() == '\r' || text.back() == '\n')) text.remove_suffix(1);
  return text;
}
constexpr bool validName(std::string_view text) {
  if (text.empty() || text.size() > MAX_NAME_BYTES) return false;
  for (unsigned char c : text) if (c < 32 || c == 127) return false;
  return true;
}
constexpr bool validUrl(std::string_view text) {
  if (text.empty() || text.size() > MAX_URL_BYTES) return false;
  size_t scheme = 0;
  for (const char* candidate : {"http://", "https://"}) {
    const std::string_view prefix(candidate);
    bool same = text.size() > prefix.size();
    for (size_t i = 0; same && i < prefix.size(); ++i) {
      const char lower = text[i] >= 'A' && text[i] <= 'Z' ? text[i] + ('a' - 'A') : text[i];
      if (lower != prefix[i]) same = false;
    }
    if (same) scheme = prefix.size();
  }
  if (!scheme || text[scheme] == '/' || text[scheme] == '?' || text[scheme] == '#') return false;
  for (unsigned char c : text) if (c <= 32 || c == 127 || c == '"' || c == '<' || c == '>') return false;
  return true;
}
constexpr bool sameUrl(std::string_view a, std::string_view b) { return trim(a) == trim(b); }
} // namespace StationImportPolicy
