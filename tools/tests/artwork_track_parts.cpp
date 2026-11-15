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

#include "../../src/state/broadcast_metadata.h"
using BroadcastMetadata::cleanTitle;
static_assert(cleanTitle("Stolen Dance (Ok egy német alternatív pop duó) [2014]").main == "Stolen Dance");
static_assert(cleanTitle("Stolen Dance (Ők egy német alternatív pop duó) [2014]").main == "Stolen Dance");
static_assert(cleanTitle("Stolen Dance (ők egy német alternatív pop duó) [2014]").year == " [2014]");
static_assert(cleanTitle("Sugar (R.S. - német dj, F.Y. - fiatal kanadai énekes) [2015]").main == "Sugar");
static_assert(cleanTitle("Sugar (R.S. - német dj, F.Y. - fiatal kanadai énekes) [2015]").year == " [2015]");
static_assert(cleanTitle("Lost On You (eredeti neve: Laura Pergolizzi) [2016]").main == "Lost On You");
static_assert(cleanTitle("Stolen Dance (Remix) (Ők egy német pop duó) [2014]").main == "Stolen Dance (Remix)");
static_assert(cleanTitle("Sugar (Radio Edit) (R.S. - német dj, F.Y. - kanadai énekes)").main == "Sugar (Radio Edit)");
static_assert(cleanTitle("The Weekend [2004]").main == "The Weekend");
static_assert(cleanTitle("The Weekend [2004]").year == " [2004]");
static_assert(cleanTitle("Reggaeton Lento (Remix) feat. Little Mix").main == "Reggaeton Lento (Remix) feat. Little Mix");
static_assert(cleanTitle("Song (Live)").main == "Song (Live)");
static_assert(cleanTitle("Song (Acoustic)").main == "Song (Acoustic)");
static_assert(cleanTitle("Song (Ők egy német duó - Live)").main == "Song (Ők egy német duó - Live)");
static_assert(cleanTitle("Song (R.S. - DJ Mix, F.Y. - énekes)").main == "Song (R.S. - DJ Mix, F.Y. - énekes)");
static_assert(cleanTitle("Song (R.S. - német dj)").main == "Song (R.S. - német dj)");
static_assert(cleanTitle("Song (német alternatív pop duó)").main == "Song (német alternatív pop duó)");
static_assert(cleanTitle("Song (Ok egy német duó) extra").main == "Song (Ok egy német duó) extra");
static_assert(cleanTitle("Song (Ok egy német duó").main == "Song (Ok egy német duó");
static_assert(cleanTitle("Song (Ok egy (német) duó)").main == "Song (Ok egy (német) duó)");
static_assert(cleanTitle("(Ok egy német duó)").main == "(Ok egy német duó)");
static_assert(cleanTitle("(Don't Fear) The Reaper").main == "(Don't Fear) The Reaper");
static_assert(cleanTitle("Song [Remix]").main == "Song [Remix]");

#include "../../src/artwork/artwork_title_cleanup.h"
using ArtworkTitleCleanup::normalize;
static_assert(normalize("The Door (Cyril remix) (Cyril remix)").view() == "The Door (Cyril remix)");
static_assert(normalize("The Door (Cyril remix) (CYRIL  Remix) [2024]", false).view() == "The Door (Cyril remix) [2024]");
static_assert(normalize("The Door (CYRIL Remix) [cyril remix] (CYRIL Remix)").view() == "The Door (CYRIL Remix)");
static_assert(normalize("Song (Live) (LIVE)").view() == "Song (Live)");
static_assert(normalize("Song (Acoustic) (acoustic)").view() == "Song (Acoustic)");
static_assert(normalize("Song (Radio Edit) [RADIO EDIT]").view() == "Song (Radio Edit)");
static_assert(normalize("Song (DJ A Remix) (DJ B Remix)").view() == "Song (DJ A Remix) (DJ B Remix)");
static_assert(normalize("Song (Remix) (Live)").view() == "Song (Remix) (Live)");
static_assert(normalize("Song (Live 2024) (Live 2025)").view() == "Song (Live 2024) (Live 2025)");
static_assert(normalize("Song (La La) (La La)").view() == "Song (La La) (La La)");
static_assert(normalize("Song (2) (2)").view() == "Song (2) (2)");
static_assert(normalize("Song (feat. Little Mix) (feat. Little Mix)").view() == "Song (feat. Little Mix) (feat. Little Mix)");
static_assert(normalize("Song (Remix) feat. Guest (Remix)").view() == "Song (Remix) feat. Guest (Remix)");
static_assert(normalize("Song (Remix) (Remix) feat. Little Mix").view() == "Song (Remix) feat. Little Mix");
static_assert(normalize("Song (Remix (Extended)) (remix (extended))").view() == "Song (Remix (Extended))");
static_assert(normalize("Goodbye (Power Introval !!)").view() == "Goodbye");
static_assert(normalize("Goodbye (POWER INTRO !!)").view() == "Goodbye");
static_assert(normalize("Goodbye [Power Intro-val !!]").view() == "Goodbye");
static_assert(normalize("Goodbye (Power Introval !!)", false).view() == "Goodbye (Power Introval !!)");
static_assert(normalize("Song (Power Introval !!) (CYRIL Remix)").view() == "Song (CYRIL Remix)");
static_assert(normalize("Song (CYRIL Remix) (Power Introval !!)").view() == "Song (CYRIL Remix)");
static_assert(normalize("Song (Power Intro !!) feat. Little Mix").view() == "Song feat. Little Mix");
static_assert(normalize("Song (Power Intro !!) (Power Introval !!)").view() == "Song");
static_assert(normalize("Song (Power Intro Remix)").view() == "Song (Power Intro Remix)");
static_assert(normalize("Song (Power Intro Live)").view() == "Song (Power Intro Live)");
static_assert(normalize("Song (Power Intro Extended)").view() == "Song (Power Intro Extended)");
static_assert(normalize("Song (Power Intro 2024)").view() == "Song (Power Intro 2024)");
static_assert(normalize("Song (Intro)").view() == "Song (Intro)");
static_assert(normalize("Power Intro").view() == "Power Intro");
static_assert(normalize("(Power Intro) Theme").view() == "(Power Intro) Theme");
static_assert(normalize("(Don't Fear) The Reaper").view() == "(Don't Fear) The Reaper");
static_assert(normalize("Song (Remix) (Remix] (Power Intro !!)").view() == "Song (Remix) (Remix] (Power Intro !!)");
static_assert(normalize("Song (Remix) (Remix) (Broken").view() == "Song (Remix) (Remix) (Broken");
static_assert(!normalize("The Door (CYRIL Remix)").changed);
static_assert(normalize(ArtworkTitleMatch::withoutBroadcastYear("The Door (Cyril remix) (Cyril remix) [2024]")).view() == "The Door (Cyril remix)");
static_assert(normalize(ArtworkTitleMatch::withoutBroadcastYear("Goodbye (Power Introval !!) [2020]")).view() == "Goodbye");
constexpr bool oversizedCleanup() {
  char title[193] = {};
  for (auto& c : title) c = 'a';
  return !normalize(std::string_view(title, sizeof(title))).changed;
}
static_assert(oversizedCleanup());
