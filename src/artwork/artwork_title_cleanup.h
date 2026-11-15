#pragma once

#include "artwork_track_parts.h"

namespace ArtworkTitleCleanup {
using std::string_view;
constexpr size_t MAX_BYTES = ArtworkTitleMatch::MAX_TITLE;

struct Text {
  char bytes[MAX_BYTES + 1] = {};
  size_t length = 0;
  bool changed = false;
  constexpr string_view view() const { return string_view(bytes, length); }
};

constexpr bool balanced(string_view text) {
  char stack[8] = {};
  size_t depth = 0;
  for (char c : text) {
    if (c == '(' || c == '[') {
      if (depth == sizeof(stack)) return false;
      stack[depth++] = c;
    } else if (c == ')' || c == ']') {
      if (!depth || (c == ')' ? stack[depth - 1] != '(' : stack[depth - 1] != '[')) return false;
      --depth;
    }
  }
  return !depth;
}

constexpr bool sameAnnotation(string_view left, string_view right) {
  left = ArtworkTitleMatch::trim(left);
  right = ArtworkTitleMatch::trim(right);
  size_t i = 0, j = 0;
  while (i < left.size() && j < right.size()) {
    if (ArtworkTrackParts::space(left[i]) && ArtworkTrackParts::space(right[j])) {
      while (i < left.size() && ArtworkTrackParts::space(left[i])) ++i;
      while (j < right.size() && ArtworkTrackParts::space(right[j])) ++j;
    } else if (ArtworkTrackParts::lower(left[i++]) != ArtworkTrackParts::lower(right[j++])) {
      return false;
    }
  }
  return i == left.size() && j == right.size();
}

constexpr bool recordingAnnotation(string_view note) {
  note = ArtworkTitleMatch::trim(note);
  // A guest named Little Mix is a credit, not a recording-version label.
  for (const char* marker : {"feat.", "feat", "ft.", "ft", "featuring", "with"}) {
    const string_view token(marker);
    if (ArtworkTrackParts::equalAt(note, 0, token) &&
        (note.size() == token.size() || ArtworkTrackParts::space(note[token.size()]))) return false;
  }
  return ArtworkTrackParts::versionText(note);
}

constexpr bool radioIntro(string_view note) {
  // Exact broadcaster labels only. Extra words such as Remix/Live/Extended,
  // names, numbers or nested groups must keep their recording identity.
  char token[20] = {};
  size_t n = 0;
  for (char c : note) {
    if (ArtworkTrackParts::space(c) || c == '!' || c == '-') continue;
    if (n == sizeof(token)) return false;
    token[n++] = ArtworkTrackParts::lower(c);
  }
  const string_view label(token, n);
  return label == "powerintro" || label == "powerintroval";
}

constexpr void erase(Text& out, size_t first, size_t after) {
  for (size_t i = after; i < out.length; ++i) out.bytes[first + i - after] = out.bytes[i];
  out.length -= after - first;
  out.bytes[out.length] = 0;
  out.changed = true;
}

// One bounded local pass, no allocations or provider requests. Collapse only
// adjacent identical recording labels; preserve different remix/live versions,
// composition subtitles, feature credits, years and malformed metadata.
// For over-limit input changed stays false: the caller retains its original.
constexpr Text normalize(string_view text, bool removeRadioIntro = true) {
  Text out;
  if (text.size() > MAX_BYTES) return out;
  out.length = text.size();
  for (size_t i = 0; i < text.size(); ++i) out.bytes[i] = text[i];
  if (!balanced(text)) return out;
  size_t previousStart = 0, previousEnd = 0;
  bool adjacent = false;
  for (size_t i = 0; i < out.length;) {
    const char c = out.bytes[i];
    if ((c == '(' || c == '[') && i && ArtworkTrackParts::space(out.bytes[i - 1])) {
      const size_t end = ArtworkTrackParts::closingGroup(out.view(), i);
      if (end == string_view::npos) return out;
      const auto note = out.view().substr(i + 1, end - i - 1);
      if (removeRadioIntro && radioIntro(note)) {
        size_t first = i;
        while (first && ArtworkTrackParts::space(out.bytes[first - 1])) --first;
        if (first) { erase(out, first, end + 1); i = first; continue; }
      }
      if (adjacent && recordingAnnotation(note) &&
          sameAnnotation(out.view().substr(previousStart + 1, previousEnd - previousStart - 1), note)) {
        erase(out, previousEnd + 1, end + 1);
        i = previousEnd + 1;
        continue;
      }
      previousStart = i;
      previousEnd = end;
      adjacent = true;
      i = end + 1;
    } else if (c == '(' || c == '[') {
      // A bracketed opening phrase is part of the composition, not a label.
      const size_t end = ArtworkTrackParts::closingGroup(out.view(), i);
      if (end == string_view::npos) return out;
      adjacent = false;
      i = end + 1;
    } else {
      if (!ArtworkTrackParts::space(c)) adjacent = false;
      ++i;
    }
  }
  return out;
}
} // namespace ArtworkTitleCleanup
