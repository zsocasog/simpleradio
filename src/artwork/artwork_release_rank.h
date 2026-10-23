#pragma once

#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <string_view>

// Metadata-only ranking: no extra requests and no artist-specific exceptions.
namespace ArtworkReleaseRank {

constexpr char lowerAscii(char ch) {
  return ch >= 'A' && ch <= 'Z' ? static_cast<char>(ch - 'A' + 'a') : ch;
}

constexpr bool contains(std::string_view text, std::string_view needle) {
  if (needle.empty() || needle.size() > text.size()) return false;
  for (size_t at = 0; at <= text.size() - needle.size(); ++at) {
    size_t i = 0;
    while (i < needle.size() && lowerAscii(text[at + i]) == lowerAscii(needle[i])) ++i;
    if (i == needle.size()) return true;
  }
  return false;
}

constexpr bool endsWith(std::string_view text, std::string_view suffix) {
  return text.size() >= suffix.size() && contains(text.substr(text.size() - suffix.size()), suffix);
}

constexpr bool wordCharacter(char ch) {
  ch = lowerAscii(ch);
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
}

constexpr bool containsWord(std::string_view text, std::string_view word) {
  for (size_t at = 0; at + word.size() <= text.size(); ++at) {
    if ((at && wordCharacter(text[at - 1])) ||
        (at + word.size() < text.size() && wordCharacter(text[at + word.size()]))) continue;
    if (contains(text.substr(at, word.size()), word)) return true;
  }
  return false;
}

constexpr bool collectionTitle(std::string_view title) {
  for (std::string_view marker : {"soundtrack", "motion picture", "music from ", "various artists",
                                  "compilation", "greatest hits", "best of ", "chart hits",
                                  "now that's what i call", "bravo hits", "hit mania", "box set"}) {
    if (contains(title, marker)) return true;
  }
  if (containsWord(title, "collection") || containsWord(title, "anthology")) return true;
  // E.g. "The O.C. Mix 5", not an original studio mix subtitle.
  for (size_t at = 0; at + 4 < title.size(); ++at) {
    if (contains(title.substr(at, 4), "mix ") && title[at + 4] >= '0' && title[at + 4] <= '9') return true;
  }
  return false;
}

constexpr bool collectionMetadata(std::string_view copyright, std::string_view genre,
                                  std::string_view releaseType = "") {
  // iTunes calls Iron Man 2 an AC/DC album with genre Hard Rock. The explicit
  // "Compilation" flag is in its copyright, not its title/artist/genre.
  // Only inspect the credit BEFORE the year, not a label called Compilation Records.
  size_t creditEnd = copyright.size();
  for (size_t i = 0; i < copyright.size(); ++i) {
    if (copyright[i] >= '0' && copyright[i] <= '9') {
      creditEnd = i;
      break;
    }
  }
  return containsWord(copyright.substr(0, creditEnd), "compilation") ||
         containsWord(genre, "soundtrack") || containsWord(genre, "soundtracks") ||
         releaseType == "compile" || releaseType == "compilation";
}

constexpr uint32_t dateKey(std::string_view date) {
  constexpr uint32_t unknown = UINT32_MAX;
  if (date.size() < 4) return unknown;
  uint32_t year = 0;
  for (size_t i = 0; i < 4; ++i) {
    if (date[i] < '0' || date[i] > '9') return unknown;
    year = year * 10 + static_cast<uint32_t>(date[i] - '0');
  }
  if (year < 1000) return unknown;
  uint32_t month = 0;
  uint32_t day = 0;
  if (date.size() > 4) {
    if (date.size() < 7 || date[4] != '-' || date[5] < '0' || date[5] > '9' ||
        date[6] < '0' || date[6] > '9') return unknown;
    month = (date[5] - '0') * 10 + date[6] - '0';
    if (!month || month > 12) return unknown;
  }
  if (date.size() > 7) {
    if (date.size() < 10 || date[7] != '-' || date[8] < '0' || date[8] > '9' ||
        date[9] < '0' || date[9] > '9') return unknown;
    day = (date[8] - '0') * 10 + date[9] - '0';
    if (!day || day > 31) return unknown;
  }
  return year * 10000 + month * 100 + day;
}

struct Release {
  std::string_view title;
  std::string_view date;
  int matchQuality;
  bool collection = false;
  bool single = false;
};

constexpr int priority(const Release& release) {
  if (release.collection || collectionTitle(release.title)) return 0;
  if (release.single || endsWith(release.title, " - single") || endsWith(release.title, " - ep")) return 1;
  for (std::string_view marker : {"expanded", "deluxe", "anniversary", "bonus"}) {
    if (contains(release.title, marker)) return 2;
  }
  return 3;
}

constexpr bool prefer(const Release& left, const Release& right) {
  if (priority(left) != priority(right)) return priority(left) > priority(right);
  if (left.matchQuality != right.matchQuality) return left.matchQuality > right.matchQuality;
  // Search relevance/popularity is not the original release order. Among
  // otherwise equal candidates prefer the older album; unknown dates go last.
  return dateKey(left.date) < dateKey(right.date);
}

} // namespace ArtworkReleaseRank
