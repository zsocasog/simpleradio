#include "../../src/artwork/artwork_json_reader.h"
#include "../../src/config/diagnostics.h"

struct StopAfterCheck {
  unsigned checks = 0;
  unsigned allowed;
  constexpr bool operator()() { return ++checks > allowed; }
};
constexpr bool boundedParseInput() {
  uint8_t data[512] = {};
  StopAfterCheck stop{0, 1};
  ArtworkJson::BoundedReader<StopAfterCheck> reader(data, sizeof(data), stop);
  for (unsigned i = 0; i < 128; ++i) if (reader.read() != 0) return false;
  return reader.read() == -1 && reader.stopped() && stop.checks == 2;
}
constexpr bool immutableBulkRead() {
  const uint8_t data[] = {1, 0, 254, 255};
  StopAfterCheck stop{0, 100};
  ArtworkJson::BoundedReader<StopAfterCheck> reader(data, sizeof(data), stop);
  char buffer[8] = {};
  return reader.readBytes(buffer, sizeof(buffer)) == 4 && !reader.stopped() &&
         static_cast<uint8_t>(buffer[3]) == 255 && reader.read() == -1;
}
constexpr bool cancelledBeforeFirstByte() {
  const uint8_t data[] = {123};
  StopAfterCheck stop{0, 0};
  ArtworkJson::BoundedReader<StopAfterCheck> reader(data, sizeof(data), stop);
  return reader.read() == -1 && reader.stopped();
}
static_assert(boundedParseInput() && immutableBulkRead() && cancelledBeforeFirstByte());
static_assert(SIMPLE_RADIO_SPECTRUM_DIAGNOSTICS == 0);
static_assert(RadioDiagnostics::ALBUM_ART_DETAILS);
static_assert(RadioDiagnostics::basicAlbumArtEvent("image ready: %s"));
static_assert(RadioDiagnostics::basicAlbumArtEvent("search cancelled: track changed"));
static_assert(!RadioDiagnostics::basicAlbumArtEvent("MusicBrainz exact match: %s"));
static_assert(!RadioDiagnostics::basicAlbumArtEvent("timing RAM-decode: %lums"));
