#pragma once

#include "../artwork/artwork_title_match.h"

namespace BroadcastMetadata {
struct Title {
  std::string_view main;
  std::string_view year;
};

// Bounded, allocation-free folding for recognizing broadcaster prose only.
// Artist identities and recording-version matching keep their existing rules.
constexpr size_t foldNote(std::string_view text, char* out) {
  size_t n = 0;
  for (size_t i = 0; i < text.size(); ++i) {
    unsigned char c = static_cast<unsigned char>(text[i]);
    if ((c == 0xc3 || c == 0xc5) && i + 1 < text.size()) {
      const unsigned char next = static_cast<unsigned char>(text[i + 1]);
      char folded = 0;
      if (c == 0xc3) {
        switch (next) {
          case 0x81: case 0xa1: folded = 'a'; break;
          case 0x89: case 0xa9: folded = 'e'; break;
          case 0x8d: case 0xad: folded = 'i'; break;
          case 0x93: case 0xb3: case 0x96: case 0xb6: folded = 'o'; break;
          case 0x9a: case 0xba: case 0x9c: case 0xbc: folded = 'u'; break;
        }
      } else {
        if (next == 0x90 || next == 0x91) folded = 'o';
        if (next == 0xb0 || next == 0xb1) folded = 'u';
      }
      if (folded) { out[n++] = folded; ++i; continue; }
    }
    out[n++] = c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c;
  }
  return n;
}

constexpr bool hasRole(std::string_view note) {
  for (const char* role : {"duo", "egyuttes", "zenekar", "enekes", "enekesno",
                           "zenesz", "eloado", "dj", "producer", "rapper"})
    if (ArtworkTitleMatch::hasWord(note, role)) return true;
  return false;
}

constexpr bool initialsBiography(std::string_view note) {
  // For example: R.S. - német dj, F.Y. - fiatal kanadai énekes.
  size_t definitions = 0;
  while (!note.empty()) {
    const auto comma = note.find(',');
    auto clause = ArtworkTitleMatch::trim(note.substr(0, comma));
    const auto dash = clause.find(" - ");
    if (dash == std::string_view::npos || dash < 2 || dash > 9) return false;
    const auto initials = clause.substr(0, dash);
    size_t letters = 0;
    for (size_t i = 0; i < initials.size(); ++i) {
      if (i % 2 == 0) { if (initials[i] < 'a' || initials[i] > 'z') return false; ++letters; }
      else if (initials[i] != '.') return false;
    }
    if (letters < 1 || letters > 4 || !hasRole(clause.substr(dash + 3))) return false;
    ++definitions;
    if (comma == std::string_view::npos) break;
    note = ArtworkTitleMatch::trim(note.substr(comma + 1));
    if (note.empty()) return false;
  }
  return definitions >= 2;
}

constexpr std::string_view withoutProse(std::string_view text) {
  using namespace ArtworkTitleMatch;
  const auto named = withoutBiographicalNote(text);
  if (named != text) return named;
  if (text.size() > 384 || text.empty() || (text.back() != ')' && text.back() != ']') ||
      !splitSubtitle(text).valid) return text;
  const auto at = text.find_last_of(text.back() == ')' ? '(' : '[');
  if (at == std::string_view::npos || !at || text[at - 1] != ' ') return text;
  const auto note = trim(text.substr(at + 1, text.size() - at - 2));
  char folded[384] = {};
  const auto lower = std::string_view(folded, foldNote(note, folded));
  // Never hide an actual recording variant, including nested annotations.
  if (note.size() < 12 || protectedSubtitle(lower)) return text;
  const bool explanation = (lower.substr(0, 7) == "ok egy " || lower.substr(0, 6) == "o egy ") && hasRole(lower);
  if (!explanation && !initialsBiography(lower)) return text;
  return trim(text.substr(0, at));
}

constexpr Title cleanTitle(std::string_view text) {
  using namespace ArtworkTitleMatch;
  text = trim(text);
  auto main = withoutBroadcastYear(text);
  const auto year = text.substr(main.size());
  for (size_t count = 0; count < 4; ++count) {
    const auto next = withoutProse(main);
    if (next == main) break;
    main = next;
  }
  return {main, year};
}
} // namespace BroadcastMetadata
