#include "../../src/artwork/artwork_title_match.h"

using ArtworkTitleMatch::minorTypo;
static_assert(minorTypo("this ain t a scene, it an arms race", "this ain t a scene, it s an arms race"));
static_assert(minorTypo("blinding lights", "blindig lights"));
static_assert(minorTypo("blinding lights", "blidnig lights"));
static_assert(minorTypo("california", "californa"));
static_assert(minorTypo("california", "califronia"));
static_assert(!minorTypo("california", "kaliforna")); // Two edits on a short title.
static_assert(!minorTypo("believe", "relieva"));
static_assert(!minorTypo("one", "on"));
static_assert(!minorTypo("tnt", "tnx"));
static_assert(minorTypo("t n t", "tnt")); // Punctuation/spacing alone is harmless.
static_assert(!minorTypo("blinding lights", "blinding lights live"));
static_assert(!minorTypo("blinding lights", "blinding lights dj mix"));
static_assert(!minorTypo("blinding lights", "blinding lights dub"));
static_assert(!minorTypo("california 1", "california 2"));
static_assert(!minorTypo("song 2024 remix", "song 2025 remix"));
static_assert(!minorTypo("", "believe"));
static_assert(!minorTypo("money for nothing", "walk of life"));
static_assert(!minorTypo("blinding lights", "blzzdig lights"));
static_assert(minorTypo("when the rain begins to fall", "when the rian begins to fal"));
static_assert(minorTypo("this ain t a scene it s an arms race", "this ain t a scene its an arms race"));
static_assert(!minorTypo("nocturne op 9", "nocturne op 19"));

// Long metadata is bounded rather than allocating another heap buffer.
constexpr bool longTitle() {
  char text[193] = {};
  for (auto& c : text) c = 'a';
  return !minorTypo(std::string_view(text, 193), std::string_view(text, 193));
}
static_assert(longTitle());

using ArtworkTitleMatch::splitSubtitle;
using ArtworkTitleMatch::protectedSubtitle;
static_assert(splitSubtitle("Diamond Eyes (Boom-Lay Boom-Lay Boom)").main == "Diamond Eyes");
static_assert(splitSubtitle(" Diamond Eyes (Boom-Lay...) ").subtitle == "(Boom-Lay...)");
static_assert(splitSubtitle("Diamond Eyes Theme").main == "Diamond Eyes Theme");
static_assert(splitSubtitle("Diamond Eyes (Boom) [Live from Washington State]").subtitle == "(Boom) [Live from Washington State]");
static_assert(splitSubtitle("Diamond Eyes (Boom (nested))").valid);
static_assert(!splitSubtitle("Diamond Eyes (Boom) Live").valid);
static_assert(!splitSubtitle("Diamond Eyes (Boom]").valid);
static_assert(!splitSubtitle("Diamond Eyes (Boom").valid);
static_assert(!protectedSubtitle("boom lay boom lay boom"));
static_assert(protectedSubtitle("boom lay boom lay boom live from washington state"));
static_assert(protectedSubtitle("boom remix"));
static_assert(protectedSubtitle("boom instrumental demo"));
static_assert(protectedSubtitle("part ii"));
static_assert(protectedSubtitle("take 2"));
