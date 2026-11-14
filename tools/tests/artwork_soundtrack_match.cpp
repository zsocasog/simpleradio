#include "../../src/artwork/artwork_soundtrack_match.h"
using namespace ArtworkSoundtrackMatch;
static_assert(relatedRelease("fast & furious 8", "the fate of the furious the album"));
static_assert(relatedRelease("fast & furious 8", "fast & furious 8 the album"));
static_assert(relatedRelease("from iron man 2", "iron man 2 original motion picture soundtrack"));
static_assert(relatedRelease("titanic", "titanic music from the motion picture"));
static_assert(soundtrackMetadata("soundtrack", "the fate of the furious the album"));
static_assert(soundtrackMetadata("soundtracks", "titanic"));
static_assert(soundtrackMetadata("pop", "titanic original motion picture soundtrack"));
static_assert(!soundtrackMetadata("hip hop rap", "the fate of the furious the album"));
static_assert(!relatedRelease("fast & furious 8", "fast & furious 7 the album"));
static_assert(!relatedRelease("fast & furious 8 remix", "fast & furious 8"));
static_assert(!relatedRelease("fast & furious 8 live", "fast & furious 8"));
static_assert(!relatedRelease("fast & furious part 8", "fast & furious part 8"));
static_assert(!relatedRelease("dj 2 remix", "dj 2 remix soundtrack"));
static_assert(!relatedRelease("part 2", "part 2 soundtrack"));
static_assert(!relatedRelease("2017", "2017 soundtrack"));
static_assert(!relatedRelease("fast furious 8 9", "fast furious 8 9"));
static_assert(!relatedRelease("fast furious8", "fast furious8"));
static_assert(!relatedRelease("motion picture soundtrack", "motion picture soundtrack"));
static_assert(!relatedRelease("fast furious", "top dance hits"));
static_assert(!relatedRelease("summer summer summer", "summer soundtrack"));
static_assert(!relatedRelease("iron", "iron soundtrack"));
static_assert(!relatedRelease("fast furious", "furious planet ocean summer winter"));
static_assert(!relatedRelease("fast furious acoustic", "fast furious acoustic"));
static_assert(!relatedRelease("", "titanic"));
static_assert(!relatedRelease("titanic", ""));
constexpr bool oversized() {
  char longText[193] = {};
  for (auto& c : longText) c = 'a';
  return !relatedRelease(std::string_view(longText, 193), "titanic");
}
static_assert(oversized());

using ArtworkTitleMatch::withoutBiographicalNote;
static_assert(withoutBiographicalNote("Lost On You (eredeti neve: Laura Pergolizzi)") == "Lost On You");
static_assert(withoutBiographicalNote(ArtworkTitleMatch::withoutBroadcastYear("Lost On You (eredeti neve: Laura Pergolizzi) [2016]")) == "Lost On You");
static_assert(withoutBiographicalNote("Lost On You [Real name: Laura Pergolizzi]") == "Lost On You");
static_assert(withoutBiographicalNote("Song (DJ A Remix) (eredeti neve: Laura Pergolizzi)") == "Song (DJ A Remix)");
static_assert(withoutBiographicalNote("Song (Live) (Birth name: Laura Pergolizzi)") == "Song (Live)");
static_assert(withoutBiographicalNote("Song (Fast & Furious 8)") == "Song (Fast & Furious 8)");
static_assert(withoutBiographicalNote("Song (eredeti neve:)") == "Song (eredeti neve:)");
static_assert(withoutBiographicalNote("Song (eredeti neve: Laura Pergolizzi Remix)") == "Song (eredeti neve: Laura Pergolizzi Remix)");
// Even when a biography contains descriptive words, an OUTSIDE version survives.
static_assert(withoutBiographicalNote("Song (eredeti neve: Laura Pergolizzi) (Remix)") == "Song (eredeti neve: Laura Pergolizzi) (Remix)");
static_assert(withoutBiographicalNote("Song (eredeti neve: Laura Pergolizzi (Live))") == "Song (eredeti neve: Laura Pergolizzi (Live))");
static_assert(withoutBiographicalNote("Song (eredeti neve: Laura Pergolizzi]") == "Song (eredeti neve: Laura Pergolizzi]");
static_assert(withoutBiographicalNote("Song (eredeti neve: https://example.com)") == "Song (eredeti neve: https://example.com)");
static_assert(withoutBiographicalNote("Song (eredeti neve: Part 2)") == "Song (eredeti neve: Part 2)");
