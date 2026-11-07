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

using AlbumSearchPolicy::Budget;
constexpr Budget budget(1000);
static_assert(budget.providerDeadline(1000) == 13000);
static_assert(budget.providerDeadline(22000) == 24000);
static_assert(budget.metadataRemaining(24000) == 0);
static_assert(budget.imageRemaining(24000) == 12000);
static_assert(budget.imageRemaining(36000) == 0);
constexpr Budget wrapped(0xfffff000u);
static_assert(wrapped.metadataRemaining(0xfffff000u + 23000u) == 0);
static_assert(wrapped.imageRemaining(0xfffff000u + 23000u) == 12000);

// Requests stop after a provider cap; an already received result can still
// rank the late own-album entries before the common metadata deadline.
static_assert(budget.providerDeadline(1000) == 13000);
static_assert(budget.metadataDeadline(1000) == 24000);
static_assert(budget.metadataRemaining(12500) > 16 * 300);
static_assert(budget.canStartProvider(21000));
static_assert(!budget.canStartProvider(21001));
static_assert(wrapped.metadataDeadline(0xfffff000u + 11000u) == 0xfffff000u + 23000u);
