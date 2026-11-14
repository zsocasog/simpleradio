#pragma once

#include <stddef.h>
#include <string_view>
#include "artwork_title_match.h"

// A bounded, per-recording fallback. Inputs are already accent/case normalized.
// No artist dictionary, learned global aliases, heap allocation or network work.
namespace ArtworkCreditPolicy {
using std::string_view;
constexpr size_t MAX_CREDITS = 12;
constexpr size_t MAX_CREDIT_BYTES = 384;

struct Credits {
  string_view names[MAX_CREDITS] = {};
  size_t size = 0;
  bool valid = true;

  constexpr void add(string_view name) {
    name = ArtworkTitleMatch::trim(name);
    if (name.empty()) return;
    for (size_t i = 0; i < size; ++i) if (names[i] == name) return;
    if (size == MAX_CREDITS) { valid = false; return; }
    names[size++] = name;
  }
};

constexpr Credits split(string_view text) {
  Credits result;
  if (text.size() > MAX_CREDIT_BYTES) { result.valid = false; return result; }
  size_t start = 0;
  for (size_t i = 0; i < text.size();) {
    size_t separator = 0;
    if (text[i] == '&' || text[i] == ',') separator = 1;
    else for (const auto token : {string_view(" feat "), string_view(" ft "),
              string_view(" featuring "), string_view(" with "), string_view(" vs "),
              string_view(" versus "), string_view(" and ")}) {
      if (text.substr(i, token.size()) == token) { separator = token.size(); break; }
    }
    if (!separator) { ++i; continue; }
    result.add(text.substr(start, i - start));
    i += separator;
    start = i;
  }
  result.add(text.substr(start));
  return result;
}

enum class Reason { Match, Bounds, Primary, Guest, ExtraPrimary, ShortNameEvidence };
struct Verdict {
  Reason reason = Reason::Primary;
  bool shortened = false;
  constexpr bool matched() const { return reason == Reason::Match; }
};

constexpr const char* label(Reason reason) {
  switch (reason) {
    case Reason::Match: return "recording credits verified";
    case Reason::Bounds: return "credit list too long";
    case Reason::Primary: return "requested main artist missing";
    case Reason::Guest: return "requested guest missing";
    case Reason::ExtraPrimary: return "different main artist credit";
    case Reason::ShortNameEvidence: return "short artist name lacks independent credit evidence";
  }
  return "artist mismatch";
}

// A shortened name is only a RECORDING candidate, never proof of artist identity.
// It needs both another exact main artist AND an exact requested guest below.
constexpr bool shortenedName(string_view left, string_view right) {
  if (left.size() > right.size()) { const auto temp = left; left = right; right = temp; }
  if (left.size() < 5 || left.find(' ') != string_view::npos || left == right) return false;
  for (char c : left) if (c < 'a' || c > 'z') return false;
  if (ArtworkTitleMatch::protectedSubtitle(left) || ArtworkTitleMatch::protectedSubtitle(right)) return false;
  size_t words = 1;
  for (char c : right) if (c == ' ') ++words;
  if (words < 2 || words > 3) return false;
  const auto at = right.find(left);
  if (at == string_view::npos || (at && right[at - 1] != ' ') ||
      (at + left.size() < right.size() && right[at + left.size()] != ' ')) return false;
  // Never abbreviate repeated band names or a generic definite article.
  return right.substr(0, 4) != "the " &&
         !(right.size() == left.size() * 2 + 1 && right.substr(0, left.size()) == left &&
           right.substr(left.size() + 1) == left);
}

template <class SameName>
constexpr Verdict compare(const Credits& foundMain, const Credits& foundGuests,
                          const Credits& wantedMain, const Credits& wantedGuests,
                          SameName sameName) {
  if (!foundMain.valid || !foundGuests.valid || !wantedMain.valid || !wantedGuests.valid ||
      foundMain.size + foundGuests.size > MAX_CREDITS || wantedMain.size + wantedGuests.size > MAX_CREDITS)
    return {Reason::Bounds, false};
  if (!foundMain.size || !wantedMain.size) return {Reason::Primary, false};
  bool usedMain[MAX_CREDITS] = {};
  size_t exactMain = 0, exactGuest = 0, shortened = 0, shortenedAt = MAX_CREDITS;
  auto findExact = [&](string_view name, bool mainOnly) {
    for (size_t i = 0; i < foundMain.size; ++i) if (sameName(foundMain.names[i], name)) {
      usedMain[i] = true; return true;
    }
    if (!mainOnly) for (size_t i = 0; i < foundGuests.size; ++i) if (sameName(foundGuests.names[i], name)) {
      return true;
    }
    return false;
  };
  for (size_t i = 0; i < wantedMain.size; ++i) {
    const auto name = wantedMain.names[i];
    if (findExact(name, true)) { ++exactMain; continue; }
    if (findExact(name, false)) continue;
    size_t candidate = MAX_CREDITS;
    for (size_t j = 0; j < foundMain.size; ++j) {
      if (!usedMain[j] && shortenedName(foundMain.names[j], name)) {
        if (candidate != MAX_CREDITS) return {Reason::ShortNameEvidence, false};
        candidate = j;
      }
    }
    if (candidate == MAX_CREDITS) return {Reason::Primary, false};
    usedMain[candidate] = true;
    shortenedAt = candidate;
    ++shortened;
  }
  for (size_t i = 0; i < wantedGuests.size; ++i) {
    const auto name = wantedGuests.names[i];
    if (!findExact(name, false)) return {Reason::Guest, false};
    bool duplicateMain = false;
    for (size_t j = 0; j < wantedMain.size; ++j) if (sameName(name, wantedMain.names[j])) duplicateMain = true;
    if (shortened && sameName(name, foundMain.names[shortenedAt])) duplicateMain = true;
    if (!duplicateMain) ++exactGuest;
  }
  for (size_t i = 0; i < foundMain.size; ++i) if (!usedMain[i]) return {Reason::ExtraPrimary, false};
  if (foundGuests.size && wantedGuests.size) {
    bool sharedFeature = false;
    for (size_t i = 0; i < foundGuests.size; ++i)
      for (size_t j = 0; j < wantedGuests.size; ++j)
        if (sameName(foundGuests.names[i], wantedGuests.names[j])) sharedFeature = true;
    if (!sharedFeature) return {Reason::Guest, false};
  }
  if (!exactMain || (shortened && (shortened > 1 || exactMain < 1 || exactGuest < 1)))
    return {Reason::ShortNameEvidence, false};
  // Extra names are allowed only in an explicit FEATURED field, while every
  // requested participant is present. Primary credits never gain a wildcard.
  return {Reason::Match, shortened != 0};
}
} // namespace ArtworkCreditPolicy
