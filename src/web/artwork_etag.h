#pragma once
#include <array>
#include <stdint.h>
#include <string_view>

namespace ArtworkEtag {
constexpr uint64_t pathId(std::string_view path) {
  uint64_t id = 14695981039346656037ULL;
  for (const char byte : path) id = (id ^ static_cast<uint8_t>(byte)) * 1099511628211ULL;
  return id;
}
constexpr std::array<char, 80> value(uint64_t session, uint32_t revision, uint64_t source, size_t bytes) {
  std::array<char, 80> out{};
  size_t index = 0;
  for (const char ch : std::string_view("W/\"sr565-bmp1-")) out[index++] = ch;
  auto hex = [&](uint64_t number, unsigned digits) {
    for (unsigned i = digits; i; --i) out[index++] = "0123456789abcdef"[(number >> ((i - 1) * 4)) & 15];
  };
  hex(session, 16); out[index++] = '-'; hex(revision, 8); out[index++] = '-';
  hex(source, 16); out[index++] = '-'; hex(bytes, 8); out[index++] = '"';
  return out;
}
constexpr std::string_view trim(std::string_view text) {
  while (!text.empty() && (text.front() == ' ' || text.front() == '\t')) text.remove_prefix(1);
  while (!text.empty() && (text.back() == ' ' || text.back() == '\t')) text.remove_suffix(1);
  return text;
}
// GET uses weak comparison. Generated tags contain only a fixed prefix and
// hex digits, so a comma cannot occur inside one of our quoted tags.
constexpr bool matches(std::string_view field, std::string_view tag) {
  if (tag.empty()) return false;
  field = trim(field);
  if (field == "*") return true;
  if (tag.substr(0, 2) == "W/") tag.remove_prefix(2);
  while (!field.empty()) {
    const size_t comma = field.find(',');
    auto item = trim(field.substr(0, comma));
    if (item.substr(0, 2) == "W/") item.remove_prefix(2);
    if (item == tag) return true;
    if (comma == std::string_view::npos) break;
    field.remove_prefix(comma + 1);
  }
  return false;
}
} // namespace ArtworkEtag
