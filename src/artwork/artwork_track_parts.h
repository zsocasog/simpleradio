#pragma once

#include "artwork_title_match.h"

// Views into the ORIGINAL title. Parse before normalization erases brackets,
// dots and dashes. No allocation, network work or list of special artist names.
namespace ArtworkTrackParts {
using std::string_view;
using ArtworkTitleMatch::trim;

struct Parts {
  string_view main;
  string_view guest;
  string_view version;
  string_view tail;
  bool feature = false;
  bool valid = true;
  bool explicitCredit = false;
};

constexpr char lower(char c) { return c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c; }
constexpr bool space(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; }
constexpr bool equalAt(string_view text, size_t at, string_view token) {
  if (at + token.size() > text.size()) return false;
  for (size_t j = 0; j < token.size(); ++j) if (lower(text[at + j]) != token[j]) return false;
  return true;
}

constexpr bool versionText(string_view text) {
  for (const char* marker : {"remix", "mix", "edit", "version", "live", "acoustic", "demo",
       "instrumental", "karaoke", "cover", "tribute", "extended", "remaster", "remastered",
       "sped", "slowed", "dub", "mono", "stereo", "session", "unplugged"}) {
    const string_view token(marker);
    for (size_t i = 0; i + token.size() <= text.size(); ++i) {
      if (i && ArtworkTitleMatch::wordChar(lower(text[i - 1]))) continue;
      if (equalAt(text, i, token) && (i + token.size() == text.size() ||
          !ArtworkTitleMatch::wordChar(lower(text[i + token.size()])))) return true;
    }
  }
  return false;
}

constexpr size_t closingGroup(string_view text, size_t at) {
  char stack[8] = {};
  size_t depth = 0;
  for (size_t i = at; i < text.size(); ++i) {
    const char c = text[i];
    if (c == '(' || c == '[') {
      if (depth == sizeof(stack)) return string_view::npos;
      stack[depth++] = c;
    } else if (c == ')' || c == ']') {
      if (!depth || (c == ')' ? stack[depth - 1] != '(' : stack[depth - 1] != '[')) return string_view::npos;
      if (!--depth) return i;
    }
  }
  return string_view::npos;
}

constexpr Parts parse(string_view text) {
  text = trim(text);
  // An explicit feat/ft credit wins over the ordinary word "with" in a song
  // title ("Stay With Me feat. Sam Smith"). Use "with" only as a fallback.
  for (size_t pass = 0; pass < 2; ++pass) {
    for (size_t i = 1; i < text.size(); ++i) {
      if (!space(text[i - 1]) && text[i - 1] != '(' && text[i - 1] != '[') continue;
      size_t after = i;
      for (const char* marker : {"featuring", "feat.", "feat", "ft.", "ft", "with"}) {
        const string_view token(marker);
        if ((pass == 0 && token == "with") || (pass == 1 && token != "with")) continue;
        if (equalAt(text, i, token) && (i + token.size() == text.size() || space(text[i + token.size()]))) {
          after = i + token.size();
          break;
        }
      }
      if (after == i) continue;
      auto main = trim(text.substr(0, i));
      size_t end = text.size();
      string_view tail;
      if (!main.empty() && (main.back() == '(' || main.back() == '[')) {
        const size_t open = main.size() - 1;
        end = closingGroup(text, open);
        if (end == string_view::npos) return {text, {}, {}, {}, true, false, pass == 0};
        tail = trim(text.substr(end + 1));
        main = trim(text.substr(0, open));
      }
      auto rest = trim(text.substr(after, end - after));
      size_t stop = rest.size();
      for (size_t j = 0; j < rest.size(); ++j) {
        if (rest[j] == '(' || rest[j] == '[') { stop = j; break; }
        for (const char* dash : {" - ", " \xe2\x80\x93 ", " \xe2\x80\x94 "}) {
          const string_view separator(dash);
          if (equalAt(rest, j, separator) && versionText(rest.substr(j + separator.size()))) {
            stop = j;
            break;
          }
        }
        if (stop != rest.size()) break;
      }
      const auto guest = trim(rest.substr(0, stop));
      auto version = trim(rest.substr(stop));
      // A dash is a boundary, not part of the version's identity.
      for (const char* dash : {"- ", "\xe2\x80\x93 ", "\xe2\x80\x94 "}) {
        const string_view separator(dash);
        if (equalAt(version, 0, separator)) version = trim(version.substr(separator.size()));
      }
      return {main, guest, version, tail, true, !main.empty() && !guest.empty(), pass == 0};
    }
  }
  return {text, {}, {}, {}, false, true};
}
}
