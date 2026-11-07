#pragma once

// Independent of general Serial logging. The async writer remains bounded
// and optional; neither audio nor display waits for a connected monitor.
#ifndef SIMPLE_RADIO_SPECTRUM_DIAGNOSTICS
#define SIMPLE_RADIO_SPECTRUM_DIAGNOSTICS 0
#endif
#ifndef SIMPLE_RADIO_ALBUM_ART_DETAILS
#define SIMPLE_RADIO_ALBUM_ART_DETAILS 1
#endif

namespace RadioDiagnostics {
constexpr bool ALBUM_ART_DETAILS = SIMPLE_RADIO_ALBUM_ART_DETAILS != 0;
// With details disabled later, retain only the start, result or reason for
// stopping a search. No provider lists, per-candidate traces or phase timings.
constexpr bool basicAlbumArtEvent(const char* format) {
  const char* prefixes[] = {"search start:", "image ready:", "no cover found",
                            "search cancelled:", "search stopped:", "search budget reached",
                            "metadata budget reached"};
  for (const char* prefix : prefixes) {
    unsigned i = 0;
    while (prefix[i] && format[i] == prefix[i]) ++i;
    if (!prefix[i]) return true;
  }
  return false;
}
} // namespace RadioDiagnostics
