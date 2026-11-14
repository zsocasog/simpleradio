#pragma once

#include "artwork_title_match.h"

// Normalized metadata only. No film/artist aliases, allocation or network work.
namespace ArtworkSoundtrackMatch {
constexpr size_t MAX_TEXT = ArtworkTitleMatch::MAX_TITLE;
constexpr size_t MAX_WORDS = 16;

constexpr std::string_view nextWord(std::string_view text, size_t& at) {
  while (at < text.size() && !ArtworkTitleMatch::wordChar(text[at])) ++at;
  const size_t begin = at;
  while (at < text.size() && ArtworkTitleMatch::wordChar(text[at])) ++at;
  return text.substr(begin, at - begin);
}

constexpr bool genericWord(std::string_view value) {
  for (const char* ignored : {"a", "an", "the", "and", "of", "from", "for", "by", "to", "in",
                              "original", "motion", "picture", "soundtrack", "album", "music",
                              "inspired", "film", "movie", "ost"}) {
    if (value == ignored) return true;
  }
  return false;
}

struct Words {
  std::string_view values[MAX_WORDS] = {};
  std::string_view number;
  size_t count = 0;
  bool valid = false;
};

constexpr Words words(std::string_view text, bool annotation) {
  Words out;
  if (text.empty() || text.size() > MAX_TEXT) return out;
  char noNumbers[MAX_TEXT] = {};
  for (size_t i = 0; i < text.size(); ++i)
    noNumbers[i] = text[i] >= '0' && text[i] <= '9' ? ' ' : text[i];
  // Keep the existing live/remix/part/etc. protection, including a marker in
  // a second group. Only a movie's standalone trailing number may be evidence.
  if (annotation && ArtworkTitleMatch::protectedSubtitle(std::string_view(noNumbers, text.size()))) return out;
  size_t at = 0, total = 0;
  while (at < text.size()) {
    const auto value = nextWord(text, at);
    if (value.empty()) break;
    if (++total > MAX_WORDS) return out;
    bool digits = false, letters = false;
    for (char c : value) { if (c >= '0' && c <= '9') digits = true; else letters = true; }
    // Do not reinterpret a catalogue ID, 3D, or an arbitrary chain of numbers.
    if (digits) {
      if (letters || !out.number.empty() || value.size() > 4) return out;
      out.number = value;
      if (annotation && !ArtworkTitleMatch::trim(text.substr(at)).empty()) return out;
    } else if (!genericWord(value)) {
      out.values[out.count++] = value;
    }
  }
  out.valid = out.count > 0;
  return out;
}

// A regional movie title need not be spelled identically (Fast / Fate), but
// needs a distinctive shared word or two shared words, at least half of each
// title, and compatible explicit numbers. Generic soundtrack words prove none
// of this. An unrelated compilation or missing album data is never evidence.
constexpr bool relatedRelease(std::string_view annotation, std::string_view release) {
  const auto wanted = words(annotation, true), found = words(release, false);
  if (!wanted.valid || !found.valid) return false;
  if (!wanted.number.empty() && !found.number.empty() && wanted.number != found.number) return false;
  size_t common = 0;
  bool distinctive = false;
  for (size_t i = 0; i < wanted.count; ++i) {
    bool repeated = false;
    for (size_t k = 0; k < i; ++k) if (wanted.values[k] == wanted.values[i]) repeated = true;
    if (repeated) return false;
    for (size_t j = 0; j < found.count; ++j) {
      if (wanted.values[i] == found.values[j]) {
        ++common;
        if (wanted.values[i].size() >= 6) distinctive = true;
        break;
      }
    }
  }
  return (distinctive || common >= 2) && common * 2 >= wanted.count && common * 2 >= found.count;
}

constexpr bool soundtrackMetadata(std::string_view genre, std::string_view release) {
  return ArtworkTitleMatch::hasWord(genre, "soundtrack") || ArtworkTitleMatch::hasWord(genre, "soundtracks") ||
         ArtworkTitleMatch::hasWord(release, "soundtrack") || ArtworkTitleMatch::hasWord(release, "ost");
}
} // namespace ArtworkSoundtrackMatch
