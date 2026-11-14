#include "../../src/artwork/artwork_credit_policy.h"

using namespace ArtworkCreditPolicy;
constexpr auto sameName = [](string_view left, string_view right) { return left == right; };
constexpr Verdict match(string_view fm, string_view fg, string_view wm, string_view wg) {
  return compare(split(fm), split(fg), split(wm), split(wg), sameName);
}

// Actual supplied iTunes credits, already normalized by the common normalizer.
static_assert(match("geszti & lotfi begi", "presser gabor & kate",
                    "geszti peter & lotfi begi", "presser gabor").matched());
static_assert(match("geszti & lotfi begi", "presser gabor & kate",
                    "geszti peter & lotfi begi", "presser gabor").shortened);
static_assert(!match("geszti & other producer", "presser gabor & kate",
                     "geszti peter & lotfi begi", "presser gabor").matched());
static_assert(!match("geszti & lotfi begi", "other guest & kate",
                     "geszti peter & lotfi begi", "presser gabor").matched());
static_assert(!match("geszti", "presser gabor", "geszti peter", "presser gabor").matched());
static_assert(!match("geszti & lotfi", "presser gabor",
                     "geszti peter & lotfi begi", "presser gabor").matched());
static_assert(!match("geszti & lotfi begi", "", "geszti peter & lotfi begi", "").matched());
static_assert(!match("geszti & lotfi begi", "geszti", "geszti peter & lotfi begi", "geszti").matched());
static_assert(!match("geszti tribute & lotfi begi", "presser gabor",
                     "geszti peter & lotfi begi", "presser gabor").matched());
static_assert(!shortenedName("duran", "duran duran"));
static_assert(!shortenedName("smith", "the smith"));
static_assert(!shortenedName("artist", "artist karaoke"));
static_assert(!shortenedName("maroon", "maroon 5"));

// Co-artists can move to an explicit featured field, but cannot disappear.
static_assert(match("henri pfr", "carston", "henri pfr & carston", "").matched());
static_assert(!match("henri pfr", "", "henri pfr & carston", "").matched());
static_assert(match("henri pfr & carston", "", "henri pfr & carston", "").matched());
static_assert(!match("henri pfr & wrong artist", "", "henri pfr & carston", "").matched());
static_assert(match("main", "first guest & second guest", "main & first guest", "second guest").matched());
static_assert(match("main & first guest", "second guest", "main", "first guest & second guest").matched());
static_assert(match("main", "first guest & extra guest", "main", "first guest").matched());
static_assert(!match("main & extra artist", "first guest", "main", "first guest").matched());
static_assert(!match("ofenbach & nick waterhouse", "another guest", "ofenbach", "nick waterhouse").matched());
static_assert(match("main", "first guest", "main", "first guest & first guest").matched());
static_assert(split("first guest & first guest").size == 1);
static_assert(!split("a,b,c,d,e,f,g,h,i,j,k,l,m").valid);
static_assert(!match("a,b,c,d,e,f,g,h,i,j,k,l,m", "", "a", "").matched());
static_assert(match("artist", "guest", "artist", "wrong guest").reason == Reason::Guest);
static_assert(match("other", "guest", "artist", "guest").reason == Reason::Primary);

// No name is a global alias: the same abbreviation without this recording's
// independent co-artist AND guest evidence remains rejected.
static_assert(!match("geszti", "", "geszti peter", "").matched());
static_assert(match("a touch of class", "guest", "atc", "guest").reason == Reason::Primary);
constexpr auto alias = [](string_view a, string_view b) {
  return a == b || (a == "a touch of class" && b == "atc");
};
static_assert(compare(split("a touch of class"), split("guest"), split("atc"), split("guest"), alias).matched());
