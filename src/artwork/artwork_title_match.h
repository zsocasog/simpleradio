#pragma once

#include <stddef.h>
#include <stdint.h>
#include <initializer_list>
#include <string_view>

namespace ArtworkTitleMatch {
constexpr size_t MAX_TITLE = 192;

constexpr bool wordChar(char c) {
  return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
}

constexpr bool hasWord(std::string_view text, std::string_view word) {
  for (size_t i = 0; i + word.size() <= text.size(); ++i) {
    if (i && wordChar(text[i - 1])) continue;
    if (text.substr(i, word.size()) == word &&
        (i + word.size() == text.size() || !wordChar(text[i + word.size()]))) return true;
  }
  return false;
}

constexpr std::string_view trim(std::string_view text) {
  while (!text.empty() && (text.front() == ' ' || text.front() == '\t' || text.front() == '\r' || text.front() == '\n')) text.remove_prefix(1);
  while (!text.empty() && (text.back() == ' ' || text.back() == '\t' || text.back() == '\r' || text.back() == '\n')) text.remove_suffix(1);
  return text;
}

struct TitleParts {
  std::string_view main;
  std::string_view subtitle;
  bool valid = true;
};

// Radio metadata can append a release year. Strip ONLY a separate final
// [1900..2099] group, never plain title numbers, remixes, or descriptive groups.
// Store titles and the displayed/original metadata keep their own identities.
constexpr std::string_view withoutBroadcastYear(std::string_view text) {
  text = trim(text);
  if (text.size() < 8 || text.back() != ']') return text;
  const size_t at = text.size() - 6;
  if (text[at] != '[' || (text[at - 1] != ' ' && text[at - 1] != '\t')) return text;
  const auto year = text.substr(at + 1, 4);
  if (!((year[0] == '1' && year[1] == '9') || (year[0] == '2' && year[1] == '0'))) return text;
  for (char c : year) if (c < '0' || c > '9') return text;
  const auto main = trim(text.substr(0, at));
  return main.empty() ? text : main;
}

constexpr bool standardVersion(std::string_view text) {
  text = trim(text);
  for (const char* version : {"radio version", "radio edit", "album version", "album edit",
                             "single version", "single edit", "original mix",
                             "clean version", "explicit version"}) {
    const std::string_view expected(version);
    if (text.size() != expected.size()) continue;
    bool equal = true;
    for (size_t i = 0; i < text.size(); ++i) {
      const char lower = text[i] >= 'A' && text[i] <= 'Z' ? text[i] + ('a' - 'A') : text[i];
      if (lower != expected[i]) { equal = false; break; }
    }
    if (equal) return true;
  }
  return false;
}

// A store can append [Radio Version] AFTER the actual subtitle. Ignore only
// complete, explicitly safe trailing groups; never erase a live/remix marker
// hidden in an earlier group, or an arbitrary annotation containing "version".
constexpr std::string_view withoutStandardVersions(std::string_view text) {
  text = trim(text);
  for (size_t count = 0; count < 4 && !text.empty(); ++count) {
    const char close = text.back();
    if (close != ')' && close != ']') break;
    const char open = close == ')' ? '(' : '[';
    const size_t at = text.find_last_of(open);
    if (at == std::string_view::npos || !at || text[at - 1] != ' ' ||
        !standardVersion(text.substr(at + 1, text.size() - at - 2))) break;
    text = trim(text.substr(0, at));
  }
  return text;
}

// Only trailing balanced (...) / [...] groups can be optional. Never truncate
// unbracketed words ("Diamond Eyes Theme") or text after a closing bracket.
constexpr TitleParts splitSubtitle(std::string_view text) {
  text = withoutStandardVersions(text);
  size_t first = text.size();
  for (size_t i = 1; i < text.size(); ++i) {
    if ((text[i] == '(' || text[i] == '[') && (text[i - 1] == ' ' || text[i - 1] == '\t')) { first = i; break; }
  }
  if (first == text.size()) return {text, {}, true};
  char stack[8] = {};
  size_t depth = 0;
  for (size_t i = first; i < text.size(); ++i) {
    const char c = text[i];
    if (c == '(' || c == '[') {
      if (depth == sizeof(stack)) return {{}, {}, false};
      stack[depth++] = c;
    } else if (c == ')' || c == ']') {
      if (!depth || (c == ')' ? stack[depth - 1] != '(' : stack[depth - 1] != '[')) return {{}, {}, false};
      --depth;
    } else if (!depth && c != ' ' && c != '\t' && c != '\r' && c != '\n') return {{}, {}, false};
  }
  return depth ? TitleParts{{}, {}, false} : TitleParts{trim(text.substr(0, first)), text.substr(first), true};
}

// Inspect the COMPLETE normalized annotation before dropping any groups.
// A live marker in a second/nested group must not disappear behind an innocent
// first subtitle. Numbers/parts can identify a different composition/version.
constexpr bool protectedSubtitle(std::string_view normalized) {
  for (char c : normalized) if (c >= '0' && c <= '9') return true;
  for (const char* marker : {"live", "remix", "acoustic", "demo", "karaoke", "tribute",
                             "instrumental", "extended", "cover", "commentary", "alternate",
                             "alternative", "version", "edit", "mix", "sped", "slowed",
                             "remaster", "remastered", "mono", "stereo", "dub", "session",
                             "rehearsal", "unplugged", "part", "pt", "volume", "vol"}) {
    if (hasWord(normalized, marker)) return true;
  }
  return false;
}

// These inputs are normalized text. Preserve version markers after a featured
// credit: "feat guest remix" must never become a plain studio title.
constexpr std::string_view featureCredit(std::string_view text) {
  size_t first = text.size();
  size_t creditAt = 0;
  for (const char* marker : {" feat ", " ft ", " featuring ", " with "}) {
    const std::string_view separator(marker);
    const size_t at = text.find(separator);
    if (at != std::string_view::npos && at && at < first) {
      first = at;
      creditAt = at + separator.size();
    }
  }
  if (first == text.size()) return {};
  const auto credit = trim(text.substr(creditAt));
  return !credit.empty() && !protectedSubtitle(credit) ? credit : std::string_view{};
}

constexpr std::string_view withoutFeatureCredit(std::string_view text) {
  const auto credit = featureCredit(text);
  if (credit.empty()) return text;
  size_t first = text.size();
  for (const char* marker : {" feat ", " ft ", " featuring ", " with "}) {
    const auto at = text.find(marker);
    if (at != std::string_view::npos && at && at < first) first = at;
  }
  return trim(text.substr(0, first));
}

// Inputs have already passed the existing accent/case/feature normalization.
// Never fuzzy-match artists, version markers, numbers, or very short titles.
constexpr bool minorTypo(std::string_view expected, std::string_view actual) {
  if (expected.empty() || actual.empty()) return false;
  for (const char* marker : {"live", "remix", "acoustic", "demo", "karaoke", "tribute",
                             "instrumental", "extended", "cover", "commentary", "sped",
                             "slowed", "mix", "edit", "version", "remaster", "remastered",
                             "mono", "stereo", "dub"}) {
    if (hasWord(expected, marker) != hasWord(actual, marker)) return false;
  }
  char left[MAX_TITLE] = {}, right[MAX_TITLE] = {};
  size_t n = 0, m = 0;
  for (char c : expected) {
    if (static_cast<unsigned char>(c) >= 128) return false;
    if (wordChar(c)) { if (n == MAX_TITLE) return false; left[n++] = c; }
  }
  for (char c : actual) {
    if (static_cast<unsigned char>(c) >= 128) return false;
    if (wordChar(c)) { if (m == MAX_TITLE) return false; right[m++] = c; }
  }
  if (!n || !m) return false;
  size_t i = 0, j = 0;
  while (i < n || j < m) {
    while (i < n && (left[i] < '0' || left[i] > '9')) ++i;
    while (j < m && (right[j] < '0' || right[j] > '9')) ++j;
    if (i == n || j == m) { if (i != n || j != m) return false; break; }
    if (left[i++] != right[j++]) return false;
  }
  const size_t shortest = n < m ? n : m;
  const uint8_t limit = shortest >= 12 ? 2 : (shortest >= 6 ? 1 : 0);
  if (n > m + limit || m > n + limit) return false;

  // Banded Damerau-Levenshtein: insertion, deletion, substitution, adjacent
  // transposition. Bounded stack storage, no heap allocation or extra requests.
  uint8_t previousPrevious[MAX_TITLE + 1] = {};
  uint8_t previous[MAX_TITLE + 1] = {};
  uint8_t current[MAX_TITLE + 1] = {};
  constexpr uint8_t outside = 3;
  for (size_t column = 0; column <= m; ++column) previous[column] = column < outside ? column : outside;
  for (size_t row = 1; row <= n; ++row) {
    current[0] = row < outside ? row : outside;
    uint8_t best = outside;
    for (size_t column = 1; column <= m; ++column) {
      uint8_t value = outside;
      if (row <= column + limit && column <= row + limit) {
        value = previous[column - 1] + (left[row - 1] == right[column - 1] ? 0 : 1);
        if (previous[column] + 1 < value) value = previous[column] + 1;
        if (current[column - 1] + 1 < value) value = current[column - 1] + 1;
        if (row > 1 && column > 1 && left[row - 1] == right[column - 2] &&
            left[row - 2] == right[column - 1] && previousPrevious[column - 2] + 1 < value) {
          value = previousPrevious[column - 2] + 1;
        }
      }
      current[column] = value < outside ? value : outside;
      if (current[column] < best) best = current[column];
    }
    if (best > limit) return false;
    for (size_t column = 0; column <= m; ++column) {
      previousPrevious[column] = previous[column]; previous[column] = current[column];
    }
  }
  return previous[m] <= limit;
}
} // namespace ArtworkTitleMatch
