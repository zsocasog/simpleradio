#pragma once

#include <stdint.h>

namespace AlbumSearchPolicy {
constexpr uint32_t LOOKUP_BUDGET_MS = 35000;
constexpr uint32_t IMAGE_BUDGET_MS = 12000;
constexpr uint32_t PROVIDER_BUDGET_MS = 12000;
constexpr uint32_t MIN_PROVIDER_BUDGET_MS = 3000;
// Mirror discovery is optional: preserve the advertised file's download window.
constexpr uint32_t ARCHIVE_METADATA_MS = 2000;
constexpr uint32_t ARCHIVE_FILE_RESERVE_MS = 6000;
constexpr uint32_t archiveMetadataDeadline(uint32_t now, uint32_t imageDeadline) {
  if (!imageDeadline) return now + ARCHIVE_METADATA_MS;
  const int32_t left = static_cast<int32_t>(imageDeadline - now);
  if (left <= static_cast<int32_t>(ARCHIVE_FILE_RESERVE_MS)) return now;
  const uint32_t available = static_cast<uint32_t>(left) - ARCHIVE_FILE_RESERVE_MS;
  return now + (available < ARCHIVE_METADATA_MS ? available : ARCHIVE_METADATA_MS);
}
// Metadata cannot borrow the final image window, even inside one provider.
// A slow provider also leaves time for a different source. Unsigned elapsed
// time keeps both windows correct when millis() wraps.
class Budget {
public:
  constexpr explicit Budget(uint32_t started) : started_(started) {}
  constexpr uint32_t metadataRemaining(uint32_t now) const {
    return remaining(now, LOOKUP_BUDGET_MS - IMAGE_BUDGET_MS);
  }
  constexpr uint32_t imageRemaining(uint32_t now) const {
    return remaining(now, LOOKUP_BUDGET_MS);
  }
  constexpr uint32_t metadataDeadline(uint32_t now) const {
    return now + metadataRemaining(now);
  }
  constexpr bool canStartProvider(uint32_t now) const {
    return metadataRemaining(now) >= MIN_PROVIDER_BUDGET_MS;
  }
  constexpr uint32_t providerDeadline(uint32_t now) const {
    const uint32_t left = metadataRemaining(now);
    return now + (left < PROVIDER_BUDGET_MS ? left : PROVIDER_BUDGET_MS);
  }
private:
  constexpr uint32_t remaining(uint32_t now, uint32_t limit) const {
    const uint32_t elapsed = now - started_;
    return elapsed >= limit ? 0 : limit - elapsed;
  }
  uint32_t started_;
};

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
