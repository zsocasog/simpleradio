#define word(...) arduino_word_macro_must_not_expand
#include "../../src/artwork/artwork_track_parts.h"
#undef word
using ArtworkTrackParts::parse;
using ArtworkTrackParts::versionText;

static_assert(parse("Reggaeton Lento (Remix) feat. Little Mix").main == "Reggaeton Lento (Remix)");
static_assert(parse("Reggaeton Lento (Remix) feat. Little Mix").guest == "Little Mix");
static_assert(parse("Song feat. Little Mix (Remix)").guest == "Little Mix");
static_assert(parse("Song feat. Little Mix (Remix)").version == "(Remix)");
static_assert(parse("Song (feat. Little Mix) [Remix]").main == "Song");
static_assert(parse("Song (feat. Little Mix) [Remix]").guest == "Little Mix");
static_assert(parse("Song (feat. Little Mix) [Remix]").tail == "[Remix]");
static_assert(parse("Song FEATURING Mix Master Mike - Extended Mix").guest == "Mix Master Mike");
static_assert(parse("Song FEATURING Mix Master Mike - Extended Mix").version == "Extended Mix");
static_assert(parse("Song feat. Little Mix \xe2\x80\x93 Radio Edit").version == "Radio Edit");
static_assert(parse("Song feat. Little Mix Remix").guest == "Little Mix Remix"); // Needs provider proof.
static_assert(!parse("Song (feat. Little Mix").valid);
static_assert(!parse("Song feat. ").valid);
static_assert(!parse("With or Without You").feature);
static_assert(parse("Stay With Me feat. Sam Smith").main == "Stay With Me");
static_assert(parse("Stay With Me feat. Sam Smith").guest == "Sam Smith");
static_assert(!parse("M\xc3\xa1jusi, m\xc3\xa1jusi").feature);
static_assert(versionText("Purple Disco Machine Remix"));
static_assert(!versionText("Remixers"));
