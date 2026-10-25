#pragma once

namespace AlbumSearchPolicy {
// One song owns one round. A 503 postpones every further MusicBrainz API
// request until the other providers finish; the final pass gets ONE request.
class MusicBrainzRound {
public:
  constexpr bool canRequest() const { return !deferred_ || (retrying_ && !retryConsumed_); }
  constexpr bool deferred() const { return deferred_; }
  constexpr bool retrying() const { return retrying_; }
  constexpr void requestStarted() { if (retrying_) retryConsumed_ = true; }
  constexpr void serviceUnavailable() { deferred_ = true; }
  constexpr bool beginRetry() {
    if (!deferred_ || retrying_) return false;
    retrying_ = true;
    return true;
  }
private:
  bool deferred_ = false;
  bool retrying_ = false;
  bool retryConsumed_ = false;
};
} // namespace AlbumSearchPolicy
