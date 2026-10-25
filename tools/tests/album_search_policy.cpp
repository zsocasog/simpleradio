#include "../../src/artwork/album_search_policy.h"
using AlbumSearchPolicy::MusicBrainzRound;
constexpr bool oneRetryAfter503() {
  MusicBrainzRound round;
  if (!round.canRequest() || round.beginRetry()) return false;
  round.requestStarted();
  round.serviceUnavailable();
  if (round.canRequest() || !round.beginRetry() || !round.canRequest()) return false;
  round.requestStarted();
  round.serviceUnavailable();
  return !round.canRequest() && !round.beginRetry();
}
constexpr bool nextSongStartsFresh() {
  MusicBrainzRound previous;
  previous.serviceUnavailable();
  MusicBrainzRound next;
  return next.canRequest() && !next.deferred() && !next.beginRetry();
}
static_assert(oneRetryAfter503());
static_assert(nextSongStartsFresh());
