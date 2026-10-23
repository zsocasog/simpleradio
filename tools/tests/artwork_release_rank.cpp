// Compile with -std=c++17 -Wall -Wextra -Werror -fsyntax-only.
#include "../../src/artwork/artwork_release_rank.h"

using namespace ArtworkReleaseRank;

// Real iTunes metadata from AC DC - T.N.T. The first/popular song result is
// Iron Man 2, while the proper studio album is also present in that response.
constexpr Release highVoltage{"High Voltage", "1976-04-30T07:00:00Z", 2};
// Song search supplies the TRACK date (1975) for both releases, not their
// album dates. Date-only sorting cannot identify the compilation at this stage.
constexpr Release highVoltageSearch{"High Voltage", "1975-12-01T08:00:00Z", 2};
constexpr Release ironManSearch{"Iron Man 2", "1975-12-01T08:00:00Z", 2};
constexpr Release ironManAlbum{"Iron Man 2", "2010-04-19T07:00:00Z", 2,
    collectionMetadata("℗ Compilation 2010 Australian Music Corporation Pty Ltd.", "Hard Rock")};
constexpr Release collectionBox{"The Complete Collection", "2012-11-19T08:00:00Z", 2};
static_assert(!prefer(highVoltageSearch, ironManSearch)); // Search order ties.
static_assert(!prefer(ironManSearch, highVoltageSearch));
static_assert(prefer(highVoltage, ironManAlbum)); // After ownership/metadata checks.
static_assert(!prefer(ironManAlbum, highVoltage));
static_assert(prefer(highVoltage, collectionBox));
// Even a recent reissue of the artist album beats a known older compilation.
static_assert(prefer({"High Voltage", "2026-01-01", 2}, ironManAlbum));
static_assert(!collectionTitle("Iron Man 2")); // This title alone is insufficient.
static_assert(collectionMetadata("COMPILATION 2010 Example", "Hard Rock"));
static_assert(!collectionMetadata("1976 Example", "Hard Rock"));
static_assert(!collectionMetadata("2010 Compilation Records", "Rock"));
static_assert(collectionMetadata("2010 Example", "Soundtracks"));
static_assert(collectionMetadata("", "", "compile")); // Deezer record_type.
static_assert(!collectionMetadata("", "Rock", "album"));

static_assert(collectionTitle("The O.C. Mix 5"));
static_assert(collectionTitle("THE COLLECTION"));
static_assert(collectionTitle("Anthology"));
static_assert(collectionTitle("Best Of The Eighties"));
static_assert(!collectionTitle("The Guest"));
static_assert(!collectionTitle("California (Tchad Blake Mix)"));
static_assert(!collectionTitle("Recollection"));
static_assert(!containsWord("Live", "collection")); // Short title, no underflow.
static_assert(!containsWord("", "compilation"));
static_assert(priority({"The Guest - Episode One", "2002", 2}) == 3);
static_assert(priority({"California - EP", "2002", 2}) == 1);

static_assert(dateKey("1976-04-30T07:00:00Z") == 19760430);
static_assert(dateKey("1976") == 19760000);
static_assert(dateKey("1976-04") == 19760400);
static_assert(dateKey("") == UINT32_MAX);
static_assert(dateKey("unknown") == UINT32_MAX);
static_assert(dateKey("0000-01-01") == UINT32_MAX);
static_assert(dateKey("1976-13-01") == UINT32_MAX);
static_assert(dateKey("1976-04-99") == UINT32_MAX);
static_assert(dateKey("1976-04-") == UINT32_MAX);
static_assert(prefer(highVoltage, {"High Voltage", "", 2}));
static_assert(!prefer(highVoltage, highVoltage)); // Stable sort retains true ties.
static_assert(prefer({"The Guest", "2002-02-26", 2}, {"The Guest (Deluxe)", "2001", 2}));
static_assert(prefer({"The Guest", "2002", 2}, {"California - Single", "2001", 2}));
static_assert(prefer({"The Guest", "2002", 2}, {"The O.C. Mix 5", "2005", 2}));
static_assert(prefer({"The Guest", "2002", 2}, {"The Guest", "2001", 1}));

constexpr size_t bestTntAlbum() {
  // Keep the API's original (wrong for our purpose) popularity order.
  const Release candidates[] = {ironManAlbum, highVoltage, collectionBox};
  size_t best = 0;
  for (size_t i = 1; i < 3; ++i) {
    if (prefer(candidates[i], candidates[best])) best = i;
  }
  return best;
}
static_assert(bestTntAlbum() == 1);
