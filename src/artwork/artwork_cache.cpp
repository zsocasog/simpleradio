#include "artwork_cache.h"
#include "artwork_http.h"
#include "artwork_release_rank.h"
#include "album_art_store.h"
#include "station_logo_policy.h"
#include "lcd_image_policy.h"
#include "artwork_title_match.h"
#include "artwork_http_policy.h"
#include "artwork_json.h"

#include <Arduino.h>
static auto& artworkTraceSerial = Serial;
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <LovyanGFX.hpp>
#include <esp_heap_caps.h>
#include <mbedtls/base64.h>
#include <algorithm>
#include <ctype.h>
#include <math.h>
#include <WiFi.h>
#include <new>
#include <stdarg.h>
#include <stdio.h>

#include "../display/display.h"
#include "../display/display_presenter.h"
#include "../state/player_state.h"
#include "../stations/station_manager.h"
#include "../config/app_config.h"
#include "../config/hardware_config.h"
#include "../config/logging.h"
#include "../web/web_server.h"

static constexpr size_t MAX_ARTWORK_BYTES = 384 * 1024;
static constexpr size_t MAX_EMBEDDED_SEGMENTS = 8;
static constexpr size_t MAX_CACHE_BYTES = 5632 * 1024;
static constexpr size_t TARGET_CACHE_BYTES = 5120 * 1024;
static constexpr size_t MIN_FS_FREE_BYTES = 384 * 1024;
static constexpr unsigned long RETRY_MS = 60000;
static constexpr unsigned long MISSING_ARTWORK_RETRY_MS = 30000;
static constexpr unsigned long THUMBNAIL_RETRY_MS = 60000;
static constexpr unsigned long PREWARM_IDLE_SPACING_MS = 3000;
static constexpr unsigned long ARTWORK_STARTUP_GRACE_MS = 20000;
static constexpr unsigned long PREWARM_FAILURE_RETRY_MS = 30000;
static constexpr unsigned long PENDING_PLAYBACK_TIMEOUT_MS = 5000;
static constexpr unsigned long CURRENT_ARTWORK_TLS_GRACE_MS = 5000;
static constexpr unsigned long ALBUM_ART_LOOKUP_BUDGET_MS = 35000;
static constexpr unsigned long ALBUM_ART_IMAGE_BUDGET_MS = 12000;
static constexpr unsigned long ALBUM_ART_MISSING_RETRY_MS = 120000;
static constexpr const char* ALBUM_ART_CACHE_PREFIX = "album:v5:";
static constexpr size_t PREWARM_QUEUE_LIMIT = 160;
static constexpr uint32_t MIN_BUDGETED_HTTP_MS = 500;
static constexpr BaseType_t ARTWORK_TASK_CORE = 1;
static constexpr UBaseType_t ARTWORK_TASK_PRIORITY = 0;
static constexpr uint16_t LCD_THUMB_BASE_SIZE = 176;
static constexpr uint16_t LCD_THUMB_SIZE_X =
    (LCD_THUMB_BASE_SIZE * DISPLAY_WIDTH + 480 / 2) / 480;
static constexpr uint16_t LCD_THUMB_SIZE_Y =
    (LCD_THUMB_BASE_SIZE * DISPLAY_HEIGHT + 320 / 2) / 320;
static constexpr uint16_t LCD_THUMB_SIZE = LCD_THUMB_SIZE_X < LCD_THUMB_SIZE_Y ? LCD_THUMB_SIZE_X : LCD_THUMB_SIZE_Y;
static constexpr size_t LCD_THUMB_BYTES = 8 + static_cast<size_t>(LCD_THUMB_SIZE) * LCD_THUMB_SIZE * 2;
static constexpr const char* LCD_THUMB_EXT = ".sr565";

static void albumArtTrace(const char* format, ...) {
  char message[240];
  va_list args;
  va_start(args, format);
  vsnprintf(message, sizeof(message), format, args);
  va_end(args);
  artworkTraceSerial.printf("[album-art] %s\n", message);
}

// Wall-clock timings include preemption by audio: never raise artwork priority
// or remove cooperative yields to make these numbers look smaller. Each scope
// emits just one line, including on failures/cancellation, not one per chunk.
class ArtworkPhaseTrace {
public:
  explicit ArtworkPhaseTrace(const char* phase, bool enabled = true)
      : phase_(phase), enabled_(enabled), startedMs_(millis()) {}
  ~ArtworkPhaseTrace() {
    if (enabled_) albumArtTrace("timing %s: %lums", phase_,
                               static_cast<unsigned long>(millis() - startedMs_));
  }
  ArtworkPhaseTrace(const ArtworkPhaseTrace&) = delete;
  ArtworkPhaseTrace& operator=(const ArtworkPhaseTrace&) = delete;

private:
  const char* phase_;
  bool enabled_;
  unsigned long startedMs_;
};

enum class ArtworkJobKind {
  Url,
  AlbumSearch,
  Embedded,
  Thumbnail,
  BrowserImport
};

struct ArtworkDownloadJob {
  ArtworkCache* cache = nullptr;
  ArtworkJobKind kind = ArtworkJobKind::Url;
  bool idlePrewarm = false;
  bool allowSecureFallback = true;
  bool fillFrame = false;
  String key;
  String url;
  String artist;
  String title;
  std::vector<uint32_t> segments;
};

struct CacheEntry {
  String path;
  size_t size = 0;
  time_t modified = 0;
};

struct CacheFamily {
  String stem;
  std::vector<CacheEntry> entries;
  size_t size = 0;
  time_t modified = 0;
};

struct IcoEntry {
  uint16_t width = 0;
  uint16_t height = 0;
  uint16_t bitCount = 0;
  uint32_t bytes = 0;
  uint32_t offset = 0;
  bool compressed = false;
};

struct ArtworkImageSize {
  uint16_t width = 0;
  uint16_t height = 0;
};

static uint32_t fnv1a(const String& value) {
  uint32_t hash = 2166136261UL;
  for (size_t i = 0; i < value.length(); ++i) {
    hash ^= static_cast<uint8_t>(value[i]);
    hash *= 16777619UL;
  }
  return hash;
}

static String imgurThumbnailFallbackUrl(const String& url) {
  String lower = url;
  lower.toLowerCase();

  int schemeEnd = lower.indexOf("://");
  if (schemeEnd < 0) return "";

  int hostStart = schemeEnd + 3;
  int pathStart = lower.indexOf('/', hostStart);
  if (pathStart < 0) return "";

  String host = lower.substring(hostStart, pathStart);
  if (host != "i.imgur.com") return "";

  int end = url.length();
  int queryStart = lower.indexOf('?', pathStart);
  if (queryStart >= 0 && queryStart < end) end = queryStart;
  int fragmentStart = lower.indexOf('#', pathStart);
  if (fragmentStart >= 0 && fragmentStart < end) end = fragmentStart;

  String path = url.substring(pathStart, end);
  int slash = path.lastIndexOf('/');
  int dot = path.lastIndexOf('.');
  if (dot <= slash) return "";

  String extension = path.substring(dot + 1);
  extension.toLowerCase();
  if (extension != "png" && extension != "jpg" && extension != "jpeg") return "";

  String stem = path.substring(slash + 1, dot);
  if (stem.length() < 5) return "";

  String normalizedPath = path;
  normalizedPath.toLowerCase();
  if (normalizedPath.endsWith("m.jpg") || normalizedPath.endsWith("m.jpeg")) return "";

  return url.substring(0, pathStart) + "/" + stem + "m.jpg";
}

ArtworkCache& ArtworkCache::instance() {
  static ArtworkCache cache;
  return cache;
}

void ArtworkCache::begin() {
  artworkTraceSerial.begin(115200);
  artworkStartedMs = millis();
  lastArtworkPlaying = false;
  audioConnectionReady = false;
  audioConnectionReadyMs = 0;
  if (!LittleFS.exists("/cache")) {
    LittleFS.mkdir("/cache");
  }
  if (!resultMutex) {
    resultMutex = xSemaphoreCreateMutex();
  }
  if (!pendingMutex) {
    pendingMutex = xSemaphoreCreateMutex();
  }
  if (!downloadMutex) {
    downloadMutex = xSemaphoreCreateMutex();
  }
  if (!thumbnailMutex) {
    thumbnailMutex = xSemaphoreCreateMutex();
  }
  if (!prewarmMutex) {
    prewarmMutex = xSemaphoreCreateMutex();
  }
  enforceCacheBudget();
  Serial.println("[artwork] cache ready");
}

static bool deadlineReached(uint32_t deadlineMs) {
  return deadlineMs > 0 && static_cast<int32_t>(millis() - deadlineMs) >= 0;
}

static uint32_t deadlineRemaining(uint32_t deadlineMs) {
  if (!deadlineMs || deadlineReached(deadlineMs)) return 0;
  return deadlineMs - millis();
}

static uint32_t boundedTimeoutMs(uint32_t normalMs, uint32_t deadlineMs) {
  if (!deadlineMs) return normalMs;
  uint32_t remaining = deadlineRemaining(deadlineMs);
  if (remaining < MIN_BUDGETED_HTTP_MS) return 0;
  return remaining < normalMs ? remaining : normalMs;
}

static bool isRemoteArtworkSource(const String& source);

void ArtworkCache::loop() {
  PlayerStateSnapshot state = PlayerState::instance().snapshot();

  if (albumLookupRetryRequested && !isDownloadActive()) {
    albumLookupRetryRequested = false;
    lastAlbumLookupKey = "";
    lastAlbumLookupMs = 0;
  }

  auto serviceIdlePrewarmAndPendingPlayback = [this]() {
    PlayerStateSnapshot currentState = PlayerState::instance().snapshot();
    processPrewarmQueue(currentState);
    processPendingPlayback(currentState);
  };

  if (state.playing != lastArtworkPlaying) {
    if (!state.playing) {
      lastIdlePrewarmStationId = -1;
      lastAttemptMs = 0;
      audioConnectionReady = false;
      audioConnectionReadyMs = 0;
    }
    lastArtworkPlaying = state.playing;
  }

  if (deferredArtworkUrl.length() && deferredArtworkStationId != state.stationId) {
    deferredArtworkUrl = "";
    deferredArtworkStationId = -1;
  }

  String completedUrl;
  String completedPath;
  bool completedOk = false;
  if (takeDownloadResult(completedUrl, completedPath, completedOk)) {
    if (!completedOk) {
      if (completedUrl.startsWith("album:")) {
        String activeKey = String(ALBUM_ART_CACHE_PREFIX) + state.artist + "|" + state.title;
        if (state.playing && completedUrl == activeKey) {
          lastAlbumLookupKey = completedUrl;
          lastAlbumLookupMs = millis();
          String oldPath = previousAlbumArtworkPath;
          PlayerState::instance().setAlbumArtworkPath("");
          previousAlbumArtworkPath = "";
          if (oldPath.length()) removeCachedArtworkFamily(oldPath);
          Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
        }
      } else if (completedUrl.startsWith("thumbfill:")) {
        const String failedPath = completedUrl.substring(10);
        if (failedPath == state.albumArtworkPath && failedPath.startsWith("/cache/")) {
          // Repair covers left by older firmware that were web-readable but
          // never decodable on the LCD; otherwise the cache blocks a new lookup.
          PlayerState::instance().setAlbumArtworkPath("");
          removeCachedArtworkFamily(failedPath);
          lastAlbumLookupKey = "";
          lastAlbumLookupMs = 0;
          previousAlbumArtworkPath = "";
          Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
        }
      } else {
        String activeArtwork = currentArtworkUrl();
        if (!activeArtwork.length() &&
            state.stationId == deferredArtworkStationId &&
            deferredArtworkUrl.length()) {
          activeArtwork = deferredArtworkUrl;
        }
        if (state.playing &&
            completedUrl == activeArtwork &&
            completedUrl.startsWith("https://")) {
          deferredArtworkUrl = completedUrl;
          deferredArtworkStationId = state.stationId;
          Serial.printf("[artwork] secure artwork deferred for station %d: %s\n",
                        state.stationId,
                        completedUrl.c_str());
        }
        if (!completedUrl.startsWith("thumb")) notePrewarmFailure(completedUrl);
      }
    } else if (completedUrl.startsWith("album:")) {
      String activeKey = String(ALBUM_ART_CACHE_PREFIX) + state.artist + "|" + state.title;
      if (state.playing && completedUrl == activeKey) {
        String oldPath = previousAlbumArtworkPath;
        if (completedPath.length()) {
          PlayerState::instance().setAlbumArtworkPath(completedPath);
          previousAlbumArtworkPath = completedPath;
        }
        if (oldPath.length() && oldPath != completedPath) removeCachedArtworkFamily(oldPath);
        Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
      } else if (completedPath.length()) {
        removeCachedArtworkFamily(completedPath);
      }
    } else if (completedUrl.startsWith("thumb:") || completedUrl.startsWith("thumbfill:")) {
      PlayerStateSnapshot currentState = PlayerState::instance().snapshot();
      refreshArtworkIfThumbnailReady(completedPath, currentState, completedUrl.startsWith("thumbfill:"));
    } else {
      String currentUrl = currentArtworkUrl();
      if (!currentUrl.length() &&
          state.stationId == deferredArtworkStationId &&
          deferredArtworkUrl.length()) {
        currentUrl = deferredArtworkUrl;
      }
      if ((completedUrl == currentUrl || completedUrl == state.embeddedArtworkKey) && completedPath.length()) {
        Serial.printf("[artwork] cached: %s\n", completedPath.c_str());
        PlayerState::instance().setCachedArtworkPath(completedPath);
        if (completedUrl == deferredArtworkUrl) {
          deferredArtworkUrl = "";
          deferredArtworkStationId = -1;
        }
        Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
        refreshArtworkIfThumbnailReady(completedPath, PlayerState::instance().snapshot());
      }
    }
  }

  processPendingBrowserImport();

  // A failed cached-image conversion may retire its unsupported source.
  // Clear stale selection references so they cannot pin the loop to a missing
  // file forever. Probe at most twice a second, or immediately on a path change.
  state = PlayerState::instance().snapshot();
  if (state.cachedArtworkPath.length()) {
    const uint32_t now = millis();
    const uint32_t pathHash = fnv1a(state.cachedArtworkPath);
    if (pathHash != lastCachedArtworkProbeHash || now - lastCachedArtworkProbeMs >= 500) {
      lastCachedArtworkProbeHash = pathHash;
      lastCachedArtworkProbeMs = now;
      if (!artworkExists(state.cachedArtworkPath)) {
        artworkTraceSerial.printf("[artwork] stale LCD reference cleared: %s\n", state.cachedArtworkPath.c_str());
        PlayerState::instance().setCachedArtworkPath("");
        state = PlayerState::instance().snapshot();
        lastUrl = "";
        lastAttemptMs = 0;
        lastIdlePrewarmStationId = -1;
      }
    }
  }

  if (!WiFi.isConnected()) {
    processPendingPlayback(PlayerState::instance().snapshot());
    return;
  }

  // Idle preparation also runs during startup's audio/network grace period.
  // It is serial; the selected station can cancel unrelated idle network work.
  if (!state.playing) {
    if (state.stationId != lastIdlePrewarmStationId) {
      lastIdlePrewarmStationId = state.stationId;
      Station selected;
      if (state.stationId >= 0 && StationManager::instance().getStation(state.stationId, selected)) {
        String logo = selected.logo;
        logo.trim();
        if (logo.length() && !prewarmFailureBlocked(logo) && !artworkSourceReady(logo)) {
          const String activeLogo = activeDownloadLabel();
          if (isRemoteArtworkSource(activeLogo) && activeLogo != logo) cancelIdlePrewarm();
          requestPrewarm(logo, true);
        }
      }
    }
    processPrewarmQueue(PlayerState::instance().snapshot());
    if (isDownloadActive()) {
      processPendingPlayback(PlayerState::instance().snapshot());
      return;
    }
  }

  AppConfig& config = AppConfig::instance();
  const String requestedAlbumKey = String(ALBUM_ART_CACHE_PREFIX) + state.artist + "|" + state.title;
  String sourceUrl = currentArtworkUrl();
  if (!sourceUrl.length() &&
      state.stationId == deferredArtworkStationId &&
      deferredArtworkUrl.length()) {
    sourceUrl = deferredArtworkUrl;
  }

  // In album-art mode the station logo remains the visible fallback.  If it
  // only exists remotely, fetch it before launching a potentially slower
  // multi-provider album lookup so the LCD never has to show an empty frame.
  if (config.displayArtworkMode == "album" && state.playing &&
      !state.hasStreamImage && sourceUrl.length() && !isDownloadActive() &&
      !AlbumArtStore::instance().acquire(state.albumArtworkPath)) {
    String cachedFallback;
    const bool hasLocalFallback = state.stationLogo.startsWith("/") && LittleFS.exists(state.stationLogo);
    const bool hasCachedFallback = findExistingLcdArtworkPath(sourceUrl, cachedFallback) ||
                                   findExistingCachePath(sourceUrl, cachedFallback);
    if (!hasLocalFallback && !hasCachedFallback &&
        !(sourceUrl == lastUrl && millis() - lastAttemptMs < MISSING_ARTWORK_RETRY_MS)) {
      const bool secureFallbackAllowed = !sourceUrl.startsWith("https://") ||
          (audioConnectionReady && audioConnectionReadyMs > 0 &&
           millis() - audioConnectionReadyMs >= CURRENT_ARTWORK_TLS_GRACE_MS);
      if (secureFallbackAllowed) {
        lastUrl = sourceUrl;
        lastAttemptMs = millis();
        albumArtTrace("station-logo fallback download start: %s", sourceUrl.c_str());
        if (startDownloadTask(sourceUrl, false, true)) return;
      }
    }
  }

  if (config.displayArtworkMode == "album" && state.playing &&
      state.artist.length() && state.title.length() &&
      !state.hasStreamImage && activeAlbumArtworkKey != requestedAlbumKey) {
    activeAlbumArtworkKey = requestedAlbumKey;
    String existingAlbumPath;
    if (findExistingCachePath(requestedAlbumKey, existingAlbumPath)) {
      String oldPath = state.albumArtworkPath;
      previousAlbumArtworkPath = existingAlbumPath;
      if (state.albumArtworkPath != existingAlbumPath) {
        PlayerState::instance().setAlbumArtworkPath(existingAlbumPath);
        Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
      }
      if (oldPath.length() && oldPath != existingAlbumPath) removeCachedArtworkFamily(oldPath);
      requestLcdThumbnail(existingAlbumPath, false, true);
      refreshArtworkIfThumbnailReady(existingAlbumPath, PlayerState::instance().snapshot(), true);
    } else {
      previousAlbumArtworkPath = state.albumArtworkPath;
      if (state.albumArtworkPath.length()) {
        PlayerState::instance().setAlbumArtworkPath("");
        Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
      }
    }
  }

  bool cachedEmbeddedPathMatches = false;
  bool embeddedThumbnailReady = false;
  if (state.embeddedArtworkKey.length() && state.hasStreamImage) {
    const String embeddedStem = cachePath(state.embeddedArtworkKey, "");
    cachedEmbeddedPathMatches =
        state.cachedArtworkPath.startsWith(embeddedStem + ".") ||
        state.cachedArtworkPath.startsWith(embeddedStem + "_");
    if (cachedEmbeddedPathMatches && config.displayArtworkMode == "album") {
      embeddedThumbnailReady = lcdThumbnailReady(state.cachedArtworkPath, true);
      if (!embeddedThumbnailReady) {
        static unsigned long lastEmbeddedThumbnailProbeMs = 0;
        if (millis() - lastEmbeddedThumbnailProbeMs >= 1000) {
          lastEmbeddedThumbnailProbeMs = millis();
          requestLcdThumbnail(state.cachedArtworkPath, false, true);
        }
      }
    }
    if (cachedEmbeddedPathMatches && lastUrl == state.embeddedArtworkKey &&
        (config.displayArtworkMode != "album" || embeddedThumbnailReady)) {
      serviceIdlePrewarmAndPendingPlayback();
      return;
    }
  }

  if (state.embeddedArtworkKey.length() &&
      !(cachedEmbeddedPathMatches && lastUrl == state.embeddedArtworkKey)) {
    String existingEmbeddedPath;
    if (findExistingCachePath(state.embeddedArtworkKey, existingEmbeddedPath)) {
      if (state.cachedArtworkPath != existingEmbeddedPath) {
        Serial.printf("[artwork] embedded cached file reused: %s\n", existingEmbeddedPath.c_str());
        PlayerState::instance().setCachedArtworkPath(existingEmbeddedPath);
        Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
      }
      requestLcdThumbnail(existingEmbeddedPath, false, config.displayArtworkMode == "album");
      lastUrl = state.embeddedArtworkKey;
      serviceIdlePrewarmAndPendingPlayback();
      return;
    }
  }

  if (isDownloadActive()) {
    processPendingPlayback(state);
    return;
  }

  if (config.displayArtworkMode == "album" && state.playing &&
      state.artist.length() && state.title.length() &&
      !state.hasStreamImage && activeAlbumArtworkKey == requestedAlbumKey &&
      !state.albumArtworkPath.length()) {
    String existingAlbumPath;
    if (findExistingCachePath(requestedAlbumKey, existingAlbumPath)) {
      if (state.albumArtworkPath != existingAlbumPath) {
        PlayerState::instance().setAlbumArtworkPath(existingAlbumPath);
        Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
      }
      requestLcdThumbnail(existingAlbumPath, false, true);
      refreshArtworkIfThumbnailReady(existingAlbumPath, PlayerState::instance().snapshot(), true);
    } else if (audioConnectionReady && audioConnectionReadyMs > 0 &&
               millis() - audioConnectionReadyMs >= 1500 &&
               !(lastAlbumLookupKey == requestedAlbumKey &&
                 millis() - lastAlbumLookupMs < ALBUM_ART_MISSING_RETRY_MS)) {
      lastAlbumLookupKey = requestedAlbumKey;
      lastAlbumLookupMs = millis();
      if (startAlbumArtworkTask(state.artist, state.title, requestedAlbumKey)) return;
    }
  }

  bool albumThumbnailReady = false;
  if (config.displayArtworkMode == "album" && state.playing &&
      !state.hasStreamImage && state.albumArtworkPath.length()) {
    albumThumbnailReady = lcdThumbnailReady(state.albumArtworkPath, true);
    if (!albumThumbnailReady) {
      static unsigned long lastAlbumThumbnailProbeMs = 0;
      if (millis() - lastAlbumThumbnailProbeMs >= 1000) {
        lastAlbumThumbnailProbeMs = millis();
        requestLcdThumbnail(state.albumArtworkPath, false, true);
      }
    }
  }

  if (sourceUrl.length()) {
    unsigned long now = millis();
    if (sourceUrl == lastUrl &&
        state.cachedArtworkPath.length()) {
      if (!albumThumbnailReady && !embeddedThumbnailReady) {
        requestLcdThumbnail(state.cachedArtworkPath);
        refreshArtworkIfThumbnailReady(state.cachedArtworkPath, state);
      }
      serviceIdlePrewarmAndPendingPlayback();
      return;
    }
    bool secureArtworkReadyForFirstRetry = false;
    bool allowSecureFallback = true;
    if (state.playing && sourceUrl.startsWith("https://")) {
      const unsigned long readyMs = audioConnectionReadyMs;
      allowSecureFallback = audioConnectionReady &&
          readyMs > 0 &&
          now - readyMs >= CURRENT_ARTWORK_TLS_GRACE_MS;
      if (allowSecureFallback) {
        const unsigned long secureReadyAt = readyMs + CURRENT_ARTWORK_TLS_GRACE_MS;
        secureArtworkReadyForFirstRetry =
            sourceUrl == deferredArtworkUrl &&
            static_cast<int32_t>(now - secureReadyAt) >= 0 &&
            static_cast<int32_t>(lastAttemptMs - secureReadyAt) < 0;
      }
    }

    if (sourceUrl == lastUrl &&
        !state.cachedArtworkPath.length() &&
        !secureArtworkReadyForFirstRetry &&
        now - lastAttemptMs < MISSING_ARTWORK_RETRY_MS) {
      processPendingPlayback(state);
      return;
    }

    String existingPath;
    if (findExistingLcdArtworkPath(sourceUrl, existingPath)) {
      String originalPath;
      if (findExistingCachePath(sourceUrl, originalPath)) {
        compactRemoteArtwork(sourceUrl, originalPath, existingPath);
      }
      if (state.cachedArtworkPath != existingPath) {
        Serial.printf("[artwork] lcd-only cache reused: %s\n", existingPath.c_str());
        PlayerState::instance().setCachedArtworkPath(existingPath);
        Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
      }
      requestLcdThumbnail(existingPath);
      refreshArtworkIfThumbnailReady(existingPath, PlayerState::instance().snapshot());
      lastUrl = sourceUrl;
      serviceIdlePrewarmAndPendingPlayback();
      return;
    }

    if (findExistingCachePath(sourceUrl, existingPath)) {
      if (state.cachedArtworkPath != existingPath) {
        Serial.printf("[artwork] cached file reused: %s\n", existingPath.c_str());
        PlayerState::instance().setCachedArtworkPath(existingPath);
        Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
      }
      requestLcdThumbnail(existingPath);
      refreshArtworkIfThumbnailReady(existingPath, PlayerState::instance().snapshot());
      lastUrl = sourceUrl;
      serviceIdlePrewarmAndPendingPlayback();
      return;
    }

    if (artworkStartedMs > 0 && millis() - artworkStartedMs < ARTWORK_STARTUP_GRACE_MS) {
      processPendingPlayback(PlayerState::instance().snapshot());
      return;
    }

    const bool hasCurrentCachedArtwork =
        state.cachedArtworkPath.length() && LittleFS.exists(state.cachedArtworkPath);
    const unsigned long retryMs = hasCurrentCachedArtwork ? RETRY_MS : MISSING_ARTWORK_RETRY_MS;
    if (!(sourceUrl == lastUrl && now - lastAttemptMs < retryMs)) {
      lastUrl = sourceUrl;
      lastAttemptMs = now;

      Serial.printf("[artwork] download start: %s\n", sourceUrl.c_str());
      if (!startDownloadTask(sourceUrl, false, allowSecureFallback)) {
        Serial.println("[artwork] download task start failed");
      }
      processPendingPlayback(PlayerState::instance().snapshot());
      return;
    }
  }

  String embeddedKeyValue;
  String embeddedUrlValue;
  std::vector<uint32_t> embeddedSegments;
  if (takePendingEmbedded(embeddedKeyValue, embeddedUrlValue, embeddedSegments)) {
    if (embeddedKeyValue == state.embeddedArtworkKey) {
      unsigned long now = millis();
      lastUrl = embeddedKeyValue;
      lastAttemptMs = now;
      Serial.printf("[artwork] embedded download start: %s segments=%u\n",
                    embeddedUrlValue.c_str(),
                    static_cast<unsigned>(embeddedSegments.size() / 2));
      if (!startEmbeddedDownloadTask(embeddedKeyValue, embeddedUrlValue, embeddedSegments)) {
        Serial.println("[artwork] embedded download task start failed");
      }
    }
  }

  const bool albumArtworkAlreadySelected =
      config.displayArtworkMode == "album" && state.playing &&
      ((state.hasStreamImage && embeddedThumbnailReady) || albumThumbnailReady);
  String localArtwork = state.cachedArtworkPath.length() ? state.cachedArtworkPath : state.stationLogo;
  if (config.displayArtworkMode == "album" && state.playing && !albumArtworkAlreadySelected) {
    localArtwork = state.stationLogo;
  }
  if (!albumArtworkAlreadySelected && localArtwork.length() &&
      localArtwork.startsWith("/")) {
    requestLcdThumbnail(localArtwork);
    refreshArtworkIfThumbnailReady(localArtwork, state);
  }

  serviceIdlePrewarmAndPendingPlayback();
}

bool ArtworkCache::writeBufferYielding(File& file, const uint8_t* data, size_t length) {
  if (!data) return false;

  static constexpr size_t CHUNK_BYTES = 4096;
  size_t written = 0;
  while (written < length) {
    if (idlePrewarmCancellationRequested()) return false;
    size_t chunk = min(CHUNK_BYTES, length - written);
    if (file.write(data + written, chunk) != chunk) {
      return false;
    }
    written += chunk;
    vTaskDelay(1);
  }
  return true;
}

void ArtworkCache::requestEmbeddedImage(const String& streamUrl, const std::vector<uint32_t>& segments) {
  if (!streamUrl.length() || segments.size() < 2 || (segments.size() % 2) != 0) return;
  if (segments.size() / 2 > MAX_EMBEDDED_SEGMENTS) {
    Serial.printf("[artwork] embedded image has too many segments: %u\n", static_cast<unsigned>(segments.size() / 2));
    return;
  }

  size_t total = 0;
  for (size_t i = 0; i + 1 < segments.size(); i += 2) {
    if (segments[i + 1] == 0) return;
    total += segments[i + 1];
    if (total > MAX_ARTWORK_BYTES) {
      Serial.printf("[artwork] embedded image too large: %u\n", static_cast<unsigned>(total));
      return;
    }
  }

  String key = embeddedKey(streamUrl, segments);
  PlayerState::instance().setEmbeddedArtworkKey(key);

  if (!pendingMutex) return;
  if (xSemaphoreTake(pendingMutex, 0) == pdTRUE) {
    pendingEmbedded = true;
    pendingEmbeddedKey = key;
    pendingEmbeddedUrl = streamUrl;
    pendingEmbeddedSegments = segments;
    xSemaphoreGive(pendingMutex);
  }
}

bool ArtworkCache::takePendingEmbedded(String& key, String& url, std::vector<uint32_t>& segments) {
  if (!pendingMutex) return false;

  bool ready = false;
  if (xSemaphoreTake(pendingMutex, 0) == pdTRUE) {
    if (pendingEmbedded) {
      key = pendingEmbeddedKey;
      url = pendingEmbeddedUrl;
      segments = pendingEmbeddedSegments;
      pendingEmbedded = false;
      pendingEmbeddedKey = "";
      pendingEmbeddedUrl = "";
      pendingEmbeddedSegments.clear();
      ready = true;
    }
    xSemaphoreGive(pendingMutex);
  }

  return ready;
}

bool ArtworkCache::startDownloadTask(const String& url, bool idlePrewarm, bool allowSecureFallback) {
  if (!markDownloadStarted(url, nullptr, idlePrewarm)) return false;

  ArtworkDownloadJob* job = new (std::nothrow) ArtworkDownloadJob();
  if (!job) {
    markDownloadFinished();
    return false;
  }

  job->cache = this;
  job->kind = ArtworkJobKind::Url;
  job->idlePrewarm = idlePrewarm;
  job->allowSecureFallback = allowSecureFallback;
  job->key = url;
  job->url = url;
  TaskHandle_t handle = nullptr;

  BaseType_t ok = xTaskCreatePinnedToCore(
    ArtworkCache::downloadTask,
    "artwork-dl",
    8192,
    job,
    ARTWORK_TASK_PRIORITY,
    &handle,
    ARTWORK_TASK_CORE
  );

  if (ok != pdPASS) {
    markDownloadFinished();
    delete job;
    return false;
  }

  setDownloadTaskHandle(handle);
  return true;
}

void ArtworkCache::retryCurrentAlbumLookup() {
  albumLookupRetryRequested = true;
}

bool ArtworkCache::startAlbumArtworkTask(const String& artist, const String& title, const String& key) {
  if (!markDownloadStarted(key)) return false;
  ArtworkDownloadJob* job = new (std::nothrow) ArtworkDownloadJob();
  if (!job) {
    markDownloadFinished();
    return false;
  }
  job->cache = this;
  job->kind = ArtworkJobKind::AlbumSearch;
  job->key = key;
  job->artist = artist;
  job->title = title;
  TaskHandle_t handle = nullptr;
  BaseType_t ok = xTaskCreatePinnedToCore(ArtworkCache::downloadTask, "album-art", 12288,
                                           job, ARTWORK_TASK_PRIORITY, &handle, ARTWORK_TASK_CORE);
  if (ok != pdPASS) {
    markDownloadFinished();
    delete job;
    return false;
  }
  setDownloadTaskHandle(handle);
  return true;
}

bool ArtworkCache::startEmbeddedDownloadTask(const String& key, const String& url, const std::vector<uint32_t>& segments) {
  if (!markDownloadStarted(key.length() ? key : url)) return false;

  ArtworkDownloadJob* job = new (std::nothrow) ArtworkDownloadJob();
  if (!job) {
    markDownloadFinished();
    return false;
  }

  job->cache = this;
  job->kind = ArtworkJobKind::Embedded;
  job->key = key;
  job->url = url;
  job->segments = segments;
  TaskHandle_t handle = nullptr;

  BaseType_t ok = xTaskCreatePinnedToCore(
    ArtworkCache::downloadTask,
    "artwork-emb",
    12288,
    job,
    ARTWORK_TASK_PRIORITY,
    &handle,
    ARTWORK_TASK_CORE
  );

  if (ok != pdPASS) {
    markDownloadFinished();
    delete job;
    return false;
  }

  setDownloadTaskHandle(handle);
  return true;
}

bool ArtworkCache::startThumbnailTask(const String& imagePath, bool idlePrewarm, bool fillFrame) {
  if (!markDownloadStarted(String("thumb:") + imagePath, nullptr, idlePrewarm)) return false;

  ArtworkDownloadJob* job = new (std::nothrow) ArtworkDownloadJob();
  if (!job) {
    markDownloadFinished();
    return false;
  }

  job->cache = this;
  job->kind = ArtworkJobKind::Thumbnail;
  job->idlePrewarm = idlePrewarm;
  job->fillFrame = fillFrame;
  job->key = String(fillFrame ? "thumbfill:" : "thumb:") + imagePath;
  job->url = imagePath;
  TaskHandle_t handle = nullptr;

  BaseType_t ok = xTaskCreatePinnedToCore(
    ArtworkCache::downloadTask,
    "art-thumb",
    8192,
    job,
    ARTWORK_TASK_PRIORITY,
    &handle,
    ARTWORK_TASK_CORE
  );

  if (ok != pdPASS) {
    markDownloadFinished();
    delete job;
    return false;
  }

  setDownloadTaskHandle(handle);
  return true;
}

bool ArtworkCache::queueBrowserArtworkImport(const String& url, const String& tempPath) {
  String source = url;
  String temp = tempPath;
  source.trim();
  temp.trim();

  if ((!source.startsWith("http://") && !source.startsWith("https://")) ||
      !temp.startsWith("/cache/") ||
      !pendingMutex) {
    return false;
  }

  bool queued = false;
  if (xSemaphoreTake(pendingMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (pendingBrowserImport) {
      queued = pendingBrowserImportUrl == source && pendingBrowserImportPath == temp;
    } else {
      pendingBrowserImport = true;
      pendingBrowserImportUrl = source;
      pendingBrowserImportPath = temp;
      queued = true;
    }
    xSemaphoreGive(pendingMutex);
  }

  if (queued) {
    Serial.printf("[artwork] browser cache import queued: %s\n", source.c_str());
  }
  return queued;
}

bool ArtworkCache::startBrowserArtworkImportTask(const String& url, const String& tempPath) {
  if (!url.length() || !tempPath.length() || !markDownloadStarted(String("browser-art:") + url)) {
    return false;
  }

  ArtworkDownloadJob* job = new (std::nothrow) ArtworkDownloadJob();
  if (!job) {
    markDownloadFinished();
    return false;
  }

  job->cache = this;
  job->kind = ArtworkJobKind::BrowserImport;
  job->key = url;
  job->url = tempPath;
  TaskHandle_t handle = nullptr;

  BaseType_t ok = xTaskCreatePinnedToCore(
    ArtworkCache::downloadTask,
    "art-import",
    8192,
    job,
    ARTWORK_TASK_PRIORITY,
    &handle,
    ARTWORK_TASK_CORE
  );

  if (ok != pdPASS) {
    markDownloadFinished();
    delete job;
    return false;
  }

  setDownloadTaskHandle(handle);
  Serial.printf("[artwork] browser cache import start: %s\n", url.c_str());
  return true;
}

void ArtworkCache::processPendingBrowserImport() {
  if (!pendingMutex || isDownloadActive()) return;

  String source;
  String tempPath;
  bool ready = false;
  if (xSemaphoreTake(pendingMutex, 0) == pdTRUE) {
    if (pendingBrowserImport) {
      source = pendingBrowserImportUrl;
      tempPath = pendingBrowserImportPath;
      pendingBrowserImport = false;
      pendingBrowserImportUrl = "";
      pendingBrowserImportPath = "";
      ready = true;
    }
    xSemaphoreGive(pendingMutex);
  }

  if (!ready) return;

  String existingPath;
  if (findExistingLcdArtworkPath(source, existingPath)) {
    if (LittleFS.exists(tempPath)) LittleFS.remove(tempPath);
    noteDownloadStatus(String("browser cache skipped, lcd cache ready ") + existingPath);
    Serial.printf("[artwork] browser cache import skipped, lcd cache ready: %s\n",
                  existingPath.c_str());
    return;
  }

  if (!LittleFS.exists(tempPath)) {
    Serial.printf("[artwork] browser cache temp missing: %s\n", tempPath.c_str());
    return;
  }

  if (!startBrowserArtworkImportTask(source, tempPath)) {
    queueBrowserArtworkImport(source, tempPath);
  }
}

bool ArtworkCache::thumbnailKnownReady(const String& imagePath, const String& thumbPath) const {
  return imagePath.length() &&
         thumbPath.length() &&
         readyThumbnailSource == imagePath &&
         readyThumbnailPath == thumbPath;
}

void ArtworkCache::markThumbnailReady(const String& imagePath, const String& thumbPath) {
  if (!imagePath.length() || !thumbPath.length()) return;
  readyThumbnailSource = imagePath;
  readyThumbnailPath = thumbPath;
  if (lastThumbnailAttemptSource == imagePath ||
      lastThumbnailAttemptSource == imagePath + ":fill") {
    lastThumbnailAttemptSource = "";
    lastThumbnailAttemptMs = 0;
  }
}

void ArtworkCache::clearThumbnailReady(const String& imagePath) {
  if (!imagePath.length() || readyThumbnailSource == imagePath) {
    readyThumbnailSource = "";
    readyThumbnailPath = "";
  }
  if (!imagePath.length() || lastArtworkRefreshPath == imagePath ||
      lastArtworkRefreshPath == imagePath + ":fill") {
    lastArtworkRefreshPath = "";
  }
}

bool ArtworkCache::markDownloadStarted(const String& label, TaskHandle_t handle, bool idlePrewarm) {
  if (!downloadMutex) return false;
  bool started = false;
  if (xSemaphoreTake(downloadMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
    if (!downloadInProgress) {
      downloadInProgress = true;
      downloadIsIdlePrewarm = idlePrewarm;
      idlePrewarmCancelRequested = false;
      downloadTaskHandle = handle;
      downloadStartedMs = millis();
      downloadLabel = label;
      started = true;
    }
    xSemaphoreGive(downloadMutex);
  }
  return started;
}

void ArtworkCache::setDownloadTaskHandle(TaskHandle_t handle) {
  if (!downloadMutex) return;
  if (xSemaphoreTake(downloadMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
    if (downloadInProgress) downloadTaskHandle = handle;
    xSemaphoreGive(downloadMutex);
  }
}

void ArtworkCache::markDownloadFinished() {
  if (!downloadMutex) return;
  if (xSemaphoreTake(downloadMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
    downloadTaskHandle = nullptr;
    downloadInProgress = false;
    downloadIsIdlePrewarm = false;
    idlePrewarmCancelRequested = false;
    downloadStartedMs = 0;
    downloadLabel = "";
    xSemaphoreGive(downloadMutex);
  }
}

void ArtworkCache::noteDownloadStatus(const String& status) {
  if (!downloadMutex) return;
  if (xSemaphoreTake(downloadMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
    downloadStatus = status;
    downloadStatusMs = millis();
    xSemaphoreGive(downloadMutex);
  }
}

bool ArtworkCache::isDownloadActive() {
  return downloadActive();
}

bool ArtworkCache::downloadActive() {
  if (!downloadMutex) return false;
  bool active = false;
  if (xSemaphoreTake(downloadMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
    active = downloadInProgress;
    xSemaphoreGive(downloadMutex);
  }
  return active;
}

unsigned long ArtworkCache::downloadElapsedMs() {
  if (!downloadMutex) return 0;
  unsigned long elapsed = 0;
  if (xSemaphoreTake(downloadMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (downloadInProgress && downloadStartedMs > 0) {
      elapsed = millis() - downloadStartedMs;
    }
    xSemaphoreGive(downloadMutex);
  }
  return elapsed;
}

String ArtworkCache::activeDownloadLabel() {
  if (!downloadMutex) return "";
  String label;
  if (xSemaphoreTake(downloadMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (downloadInProgress) label = downloadLabel;
    xSemaphoreGive(downloadMutex);
  }
  return label;
}

void ArtworkCache::cancelIdlePrewarm() {
  if (!downloadMutex) return;
  String label;
  bool requested = false;
  if (xSemaphoreTake(downloadMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (downloadInProgress && downloadIsIdlePrewarm) {
      idlePrewarmCancelRequested = true;
      label = downloadLabel;
      requested = true;
    }
    xSemaphoreGive(downloadMutex);
  }
  if (requested) {
    Serial.printf("[artwork] idle prewarm cancellation requested: %s\n", label.c_str());
  }
}

void ArtworkCache::notifyAudioConnectStarting() {
  audioConnectionReady = false;
  audioConnectionReadyMs = 0;
}

void ArtworkCache::notifyAudioConnectResult(bool connected) {
  audioConnectionReady = connected;
  audioConnectionReadyMs = connected ? millis() : 0;
  if (connected) {
    Serial.printf("[artwork] current HTTPS artwork allowed after %lums audio grace\n",
                  static_cast<unsigned long>(CURRENT_ARTWORK_TLS_GRACE_MS));
  }
}

bool ArtworkCache::idlePrewarmCancellationRequested() {
  if (!downloadMutex) return false;
  bool requested = false;
  if (xSemaphoreTake(downloadMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    requested = downloadInProgress && downloadIsIdlePrewarm && idlePrewarmCancelRequested;
    xSemaphoreGive(downloadMutex);
  }
  return requested;
}

String ArtworkCache::lastDownloadStatus() {
  if (!downloadMutex) return "";
  String status;
  if (xSemaphoreTake(downloadMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    status = downloadStatus;
    xSemaphoreGive(downloadMutex);
  }
  return status;
}

unsigned long ArtworkCache::lastDownloadStatusAgeMs() {
  if (!downloadMutex) return 0;
  unsigned long age = 0;
  if (xSemaphoreTake(downloadMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (downloadStatusMs > 0) age = millis() - downloadStatusMs;
    xSemaphoreGive(downloadMutex);
  }
  return age;
}

void ArtworkCache::storeDownloadResult(const String& url, const String& path, bool success) {
  if (!resultMutex) return;

  if (xSemaphoreTake(resultMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
    resultUrl = url;
    resultPath = path;
    resultSuccess = success;
    resultReady = true;
    xSemaphoreGive(resultMutex);
  }
}

bool ArtworkCache::takeDownloadResult(String& url, String& path, bool& success) {
  if (!resultMutex) return false;

  bool ready = false;
  if (xSemaphoreTake(resultMutex, 0) == pdTRUE) {
    if (resultReady) {
      url = resultUrl;
      path = resultPath;
      success = resultSuccess;
      resultUrl = "";
      resultPath = "";
      resultSuccess = false;
      resultReady = false;
      ready = true;
    }
    xSemaphoreGive(resultMutex);
  }

  return ready;
}

void ArtworkCache::downloadTask(void* param) {
  ArtworkDownloadJob* job = static_cast<ArtworkDownloadJob*>(param);
  ArtworkCache* cache = job ? job->cache : nullptr;
  ArtworkJobKind kind = job ? job->kind : ArtworkJobKind::Url;
  bool idlePrewarm = job ? job->idlePrewarm : false;
  bool allowSecureFallback = job ? job->allowSecureFallback : true;
  bool fillFrame = job ? job->fillFrame : false;
  String key = job ? job->key : "";
  String url = job ? job->url : "";
  String artist = job ? job->artist : "";
  String title = job ? job->title : "";
  std::vector<uint32_t> segments = job ? job->segments : std::vector<uint32_t>();
  delete job;

  if (cache && (url.length() || kind == ArtworkJobKind::AlbumSearch)) {
    String path;
    bool ok = false;
    bool cancelled = idlePrewarm && cache->idlePrewarmCancellationRequested();
    if (!cancelled && kind == ArtworkJobKind::Embedded) {
      ok = cache->downloadEmbedded(url, segments, key, path);
    } else if (!cancelled && kind == ArtworkJobKind::Thumbnail) {
      ok = cache->ensureLcdThumbnail(url, fillFrame);
      path = url;
    } else if (!cancelled && kind == ArtworkJobKind::BrowserImport) {
      ok = cache->importLocalImage(key, url, path);
      if (!ok && LittleFS.exists(url)) LittleFS.remove(url);
    } else if (!cancelled && kind == ArtworkJobKind::AlbumSearch) {
      ok = cache->resolveAndDownloadAlbumArtwork(artist, title, key, path);
    } else if (!cancelled) {
      ok = cache->download(url, path, 0, allowSecureFallback);
    }
    cancelled = idlePrewarm && cache->idlePrewarmCancellationRequested();
    if (cancelled) {
      Serial.println("[artwork] idle prewarm cancelled");
    } else if (ok) {
      cache->storeDownloadResult(key.length() ? key : url, path, true);
    } else {
      cache->storeDownloadResult(key.length() ? key : url, "", false);
      if (kind == ArtworkJobKind::Thumbnail) {
        if (fillFrame) albumArtTrace("fill-cropped LCD thumbnail failed: %s", url.c_str());
        Serial.println("[artwork] lcd thumbnail task failed");
      } else if (kind == ArtworkJobKind::BrowserImport) {
        Serial.println("[artwork] browser cache import failed");
      } else {
        Serial.println("[artwork] download failed or unsupported image format");
      }
    }
    cache->markDownloadFinished();
  }

  vTaskDelete(nullptr);
}

String ArtworkCache::currentArtworkUrl() const {
  PlayerStateSnapshot state = PlayerState::instance().snapshot();

  if (state.streamLogoUrl.startsWith("http://") || state.streamLogoUrl.startsWith("https://")) {
    return state.streamLogoUrl;
  }

  if (state.stationLogo.startsWith("http://") || state.stationLogo.startsWith("https://")) {
    return state.stationLogo;
  }

  return "";
}

static String encodeArtworkQuery(const String& value) {
  String output;
  static const char hex[] = "0123456789ABCDEF";
  for (size_t i = 0; i < value.length(); ++i) {
    uint8_t c = static_cast<uint8_t>(value[i]);
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
      output += static_cast<char>(c);
    } else {
      output += '%';
      output += hex[c >> 4];
      output += hex[c & 0x0F];
    }
  }
  return output;
}

static String resizedStationLogoUrl(const String& url) {
  if (!StationLogoPolicy::canUsePublicResizer(url.c_str())) return "";
  // Request a baseline JPEG the existing LCD decoder already supports.
  // No logo cropping: retain the source aspect ratio and avoid enlargement.
  return "https://wsrv.nl/?url=" + encodeArtworkQuery(url) +
         "&w=176&h=176&fit=inside&output=jpg&q=85&we&bg=070909&page=-1";
}

static String preferredStationLogoUrl(const String& url) {
  const char* official = StationLogoPolicy::smallerOfficialUrl(url.c_str());
  if (official[0]) return String(official);
  const String nativeSmall = imgurThumbnailFallbackUrl(url);
  if (nativeSmall.length()) return ArtworkHttp::publicImageUrl(nativeSmall);
  return resizedStationLogoUrl(url);
}

static bool fetchArtworkJson(const String& url, JsonDocument& doc,
                             uint32_t deadlineMs = 0,
                             const std::function<bool()>& cancelled = {}, int* httpStatus = nullptr) {
  ArtworkHttp::Options options;
  options.deadlineMs = deadlineMs;
  options.cancelled = cancelled;
  ArtworkHttp::Response response;
  // Both the HTTP body and the parsed document use PSRAM; many small default
  // ArduinoJson allocations would otherwise exhaust newlib/audio internal RAM.
  const bool received = ArtworkHttp::get(url, ArtworkHttpPolicy::MAX_METADATA_BYTES, response, options);
  if (httpStatus) *httpStatus = response.status;
  if (!received) {
    albumArtTrace("JSON %s: %s", ArtworkHttp::host(url).c_str(), response.error.c_str());
    return false;
  }
  // Treat input as read-only: the document must own its strings after this
  // temporary response buffer is released.
  const size_t internalBefore = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  DeserializationError error;
  if (ArtworkHttp::host(url) == "musicbrainz.org") {
    JsonDocument filter(doc.allocator());
    if (!ArtworkJson::musicBrainzFilter(filter)) {
      albumArtTrace("JSON MusicBrainz filter: PSRAM unavailable; response discarded");
      return false;
    }
    error = deserializeJson(doc, static_cast<const uint8_t*>(response.data), response.size,
                            DeserializationOption::Filter(filter));
  } else {
    error = deserializeJson(doc, static_cast<const uint8_t*>(response.data), response.size);
  }
  if (response.size >= 64 * 1024 || error == DeserializationError::NoMemory) {
    albumArtTrace("JSON memory: payload=%u internal=%u->%u PSRAM-free=%u",
                  static_cast<unsigned>(response.size), static_cast<unsigned>(internalBefore),
                  static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
                  static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)));
  }
  if (error != DeserializationError::Ok) {
    albumArtTrace("JSON parse failed: %s (%u bytes)", error.c_str(),
                  static_cast<unsigned>(response.size));
    doc.clear(); // Release a partial PSRAM document before the next provider.
  }
  return error == DeserializationError::Ok;
}
static String normalizeArtworkText(const String& input) {
    String mapped;
    mapped.reserve(input.length());
    for (size_t i = 0; i < input.length();) {
      uint8_t a = static_cast<uint8_t>(input[i]);
      uint8_t b = i + 1 < input.length() ? static_cast<uint8_t>(input[i + 1]) : 0;
      char replacement = 0;
      if (a == 0xC3) {
        switch (b) {
          case 0x80: case 0x81: case 0x82: case 0x83: case 0x84: case 0x85:
          case 0xA0: case 0xA1: case 0xA2: case 0xA3: case 0xA4: case 0xA5: replacement = 'a'; break;
          case 0x87: case 0xA7: replacement = 'c'; break;
          case 0x88: case 0x89: case 0x8A: case 0x8B:
          case 0xA8: case 0xA9: case 0xAA: case 0xAB: replacement = 'e'; break;
          case 0x8C: case 0x8D: case 0x8E: case 0x8F:
          case 0xAC: case 0xAD: case 0xAE: case 0xAF: replacement = 'i'; break;
          case 0x91: case 0xB1: replacement = 'n'; break;
          case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x98:
          case 0xB2: case 0xB3: case 0xB4: case 0xB5: case 0xB6: case 0xB8: replacement = 'o'; break;
          case 0x99: case 0x9A: case 0x9B: case 0x9C:
          case 0xB9: case 0xBA: case 0xBB: case 0xBC: replacement = 'u'; break;
          case 0x9D: case 0xBD: replacement = 'y'; break;
          case 0x9F: replacement = 's'; break;
          default: break;
        }
        if (replacement) i += 2;
      } else if (a == 0xC5) {
        switch (b) {
          case 0x90: case 0x91: replacement = 'o'; break; // Ő ő
          case 0xB0: case 0xB1: replacement = 'u'; break; // Ű ű
          case 0x98: case 0x99: replacement = 's'; break;
          case 0x9A: case 0x9B: replacement = 't'; break;
          case 0xBD: case 0xBE: replacement = 'z'; break;
          default: break;
        }
        if (replacement) i += 2;
      } else if (a == 0xC4) {
        switch (b) {
          case 0xB0: case 0xB1: replacement = 'i'; break;
          case 0x86: case 0x87: replacement = 'c'; break;
          case 0x8C: case 0x8D: replacement = 'c'; break;
          case 0x9E: case 0x9F: replacement = 'g'; break;
          case 0xB9: case 0xBA: replacement = 'l'; break;
          default: break;
        }
        if (replacement) i += 2;
      } else if (a == 0xC6 && (b == 0x92 || b == 0x93)) {
        replacement = 'a';
        i += 2;
      }
      if (replacement) {
        mapped += replacement;
      } else {
        char ch = static_cast<char>(a);
        if (ch >= 'A' && ch <= 'Z') ch = static_cast<char>(ch - 'A' + 'a');
        mapped += ch;
        ++i;
      }
    }
    String out;
    bool previousSpace = true;
    for (size_t i = 0; i < mapped.length(); ++i) {
      char ch = mapped[i];
      if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '&' || ch == ',') {
        out += ch;
        previousSpace = false;
      } else if (!previousSpace) {
        out += ' ';
        previousSpace = true;
      }
    }
    out.trim();
    return out;
}

static bool artworkArtistsMatch(const String& foundArtist, const String& wantedArtist) {
  auto artistCredits = [&](String value) {
    value = normalizeArtworkText(value);
    const char* separators[] = {
      " feat ", " ft ", " featuring ", " with ", " and ", "&", ","
    };
    for (const char* separator : separators) value.replace(separator, ",");

    std::vector<String> credits;
    int start = 0;
    while (start <= static_cast<int>(value.length())) {
      int separator = value.indexOf(',', start);
      String credit = separator < 0 ? value.substring(start) : value.substring(start, separator);
      credit.trim();
      if (credit.length()) credits.push_back(credit);
      if (separator < 0) break;
      start = separator + 1;
    }
    return credits;
  };

  auto sameArtistName = [](String left, String right) {
    // A common broadcast alias uses the letter in place of P!nk's stylized !.
    // Keep this explicit: general fuzzy artist matching confused cover artists
    // with the original performer in earlier searches.
    if (left == "p nk") left = "pink";
    if (right == "p nk") right = "pink";
    std::vector<String> leftWords;
    std::vector<String> rightWords;
    auto splitWords = [](String value, std::vector<String>& words) {
      value.trim();
      int start = 0;
      while (start < static_cast<int>(value.length())) {
        while (start < static_cast<int>(value.length()) && value[start] == ' ') ++start;
        int end = value.indexOf(' ', start);
        String word = end < 0 ? value.substring(start) : value.substring(start, end);
        if (word.length()) words.push_back(word);
        if (end < 0) break;
        start = end + 1;
      }
      std::sort(words.begin(), words.end());
    };
    splitWords(left, leftWords);
    splitWords(right, rightWords);
    if (leftWords.empty() || leftWords.size() != rightWords.size()) return false;
    for (size_t i = 0; i < leftWords.size(); ++i) {
      if (leftWords[i] != rightWords[i]) return false;
    }
    return true;
  };

  auto artistsMatch = [&](const String& found, const String& wanted) {
    std::vector<String> foundCredits = artistCredits(found);
    std::vector<String> wantedCredits = artistCredits(wanted);
    if (foundCredits.empty() || wantedCredits.empty()) return false;

    // A single station artist may be credited alongside a guest on a provider;
    // for explicit duets, require every requested artist to be present.
    if (wantedCredits.size() == 1) {
      for (const String& credit : foundCredits) {
        if (sameArtistName(credit, wantedCredits[0])) return true;
      }
      return false;
    }
    if (foundCredits.size() != wantedCredits.size()) return false;
    std::vector<bool> matched(foundCredits.size(), false);
    for (const String& wantedCredit : wantedCredits) {
      bool foundMatch = false;
      for (size_t i = 0; i < foundCredits.size(); ++i) {
        if (!matched[i] && sameArtistName(foundCredits[i], wantedCredit)) {
          matched[i] = true;
          foundMatch = true;
          break;
        }
      }
      if (!foundMatch) return false;
    }
    return true;
  };

  return artistsMatch(foundArtist, wantedArtist);
}

static bool exactTrackMatch(String foundArtist, String foundTitle,
                            const String& wantedArtist, const String& wantedTitle,
                            bool allowStudioMix = false, bool allowTitleTypos = false) {

  auto stripFeature = [](String value) {
    const char* markers[] = { " feat ", " ft ", " featuring ", " with " };
    int cutAt = -1;
    for (const char* marker : markers) {
      int position = value.indexOf(marker);
      if (position > 0 && (cutAt < 0 || position < cutAt)) cutAt = position;
    }
    if (cutAt >= 0) value = value.substring(0, cutAt);
    value.trim();
    return value;
  };

  auto baseTitle = [&](String value) {
    // Stores often name the original studio mix in parentheses (California
    // (Tchad Blake Mix)). Only relax this subtitle, never the credited artist,
    // and never accept live/demo/remix/tribute versions for a plain title.
    if (allowStudioMix && value.endsWith(")")) {
      const int at = value.lastIndexOf(" (");
      if (at > 0) {
        const String suffix = normalizeArtworkText(value.substring(at + 2, value.length() - 1));
        bool differentVersion = false;
        for (const char* marker : {"remix", "live", "acoustic", "demo", "karaoke", "tribute",
                                   "instrumental", "extended", "cover version"}) {
          if (suffix.indexOf(marker) >= 0) differentVersion = true;
        }
        if (!differentVersion && (suffix.endsWith(" mix") || suffix == "stereo" || suffix == "mono")) {
          value.remove(at);
        }
      }
    }
    value = stripFeature(normalizeArtworkText(value));
    const char* versionSuffixes[] = {
      " country version", " radio version", " album version", " single version",
      " radio edit", " single edit", " album edit", " original mix",
      " remastered", " remaster", " clean version", " explicit version"
    };
    for (const char* suffix : versionSuffixes) {
      size_t valueLength = value.length();
      size_t suffixLength = strlen(suffix);
      if (valueLength > suffixLength && value.endsWith(suffix)) {
        value.remove(valueLength - suffixLength);
        value.trim();
        break;
      }
    }
    return value;
  };

  String expectedTitle = baseTitle(wantedTitle);
  String actualTitle = baseTitle(foundTitle);
  return artworkArtistsMatch(foundArtist, wantedArtist) &&
         expectedTitle.length() && (expectedTitle == actualTitle ||
           (allowTitleTypos && ArtworkTitleMatch::minorTypo(expectedTitle.c_str(), actualTitle.c_str())));
}

static bool subtitleTrackMatch(const String& foundArtist, const String& foundTitle,
                                const String& wantedArtist, const String& wantedTitle) {
  if (!artworkArtistsMatch(foundArtist, wantedArtist)) return false;
  const auto found = ArtworkTitleMatch::splitSubtitle(std::string_view(foundTitle.c_str(), foundTitle.length()));
  const auto wanted = ArtworkTitleMatch::splitSubtitle(std::string_view(wantedTitle.c_str(), wantedTitle.length()));
  if (!found.valid || !wanted.valid || found.main.empty() || wanted.main.empty()) return false;
  // One missing subtitle is acceptable; two different explicit subtitles are
  // not assumed equivalent. Exact/typo full-title matching already ran first.
  if (found.subtitle.empty() == wanted.subtitle.empty()) return false;
  const auto annotation = found.subtitle.empty() ? wanted.subtitle : found.subtitle;
  const String normalizedAnnotation = normalizeArtworkText(String(annotation.data(), annotation.size()));
  if (ArtworkTitleMatch::protectedSubtitle(normalizedAnnotation.c_str())) return false;
  const String foundMain = normalizeArtworkText(String(found.main.data(), found.main.size()));
  const String wantedMain = normalizeArtworkText(String(wanted.main.data(), wanted.main.size()));
  return foundMain == wantedMain || ArtworkTitleMatch::minorTypo(wantedMain.c_str(), foundMain.c_str());
}

static bool artworkMatchNeedsVerifiedAlbum(int quality) {
  return quality <= 2; // Studio-mix and optional-subtitle matches require ownership proof.
}

static const char* artworkMatchLabel(int quality) {
  return quality == 4 ? "exact" : quality == 3 ? "minor-title-typo" :
         quality == 2 ? "studio-title" : "subtitle";
}

static void addUniqueArtworkCandidate(std::vector<String>& urls, const String& url) {
  if (!url.length()) return;
  for (const String& existing : urls) {
    if (existing == url) return;
  }
  urls.push_back(url);
}

static bool isMusicBrainzMbid(const String& value) {
  if (value.length() != 36) return false;
  for (size_t i = 0; i < value.length(); ++i) {
    const bool separator = i == 8 || i == 13 || i == 18 || i == 23;
    const char character = value[i];
    if ((separator && character != '-') ||
        (!separator && !isxdigit(static_cast<unsigned char>(character)))) {
      return false;
    }
  }
  return true;
}

static bool isCompilationArtist(String artist) {
  artist.trim();
  artist.toLowerCase();
  return artist == "various artists" || artist == "various" || artist == "v/a" ||
         artist == "va" || artist == "v.a." || artist == "various performers" ||
         artist == "[various artists]";
}

enum class AlbumArtworkKind { Album, Single, ArtistCollection, Unverified, Compilation };

static bool compilationAlbumTitle(const String& title) {
  return ArtworkReleaseRank::collectionTitle(std::string_view(title.c_str(), title.length()));
}

static bool albumArtistOwnsTrack(const String& albumArtist, const String& trackArtist) {
  // An album by one participant in a duet is still an artist-owned release.
  return albumArtist.length() && !isCompilationArtist(albumArtist) &&
         artworkArtistsMatch(trackArtist, albumArtist);
}

static bool musicBrainzSecondaryType(JsonObject group, const char* wanted) {
  JsonArray types = group["secondary-types"].as<JsonArray>();
  for (JsonVariant type : types) {
    if (type.as<String>() == wanted) return true;
  }
  return false;
}

static String musicBrainzArtistCredit(JsonArray credits) {
  String result;
  for (JsonVariant credit : credits) {
    if (credit.is<JsonObject>()) {
      String name = credit["name"] | "";
      if (!name.length()) name = credit["artist"]["name"] | "";
      result += name;
      result += credit["joinphrase"] | "";
    } else if (credit.is<const char*>()) result += credit.as<String>();
  }
  return result;
}

static AlbumArtworkKind albumArtworkKind(const String& albumArtist, const String& trackArtist,
                                         const String& albumTitle, const String& primaryType = "",
                                         bool collection = false) {
  if (isCompilationArtist(albumArtist) ||
      (albumArtist.length() && !albumArtistOwnsTrack(albumArtist, trackArtist))) {
    return AlbumArtworkKind::Compilation;
  }
  if (!albumArtist.length()) return AlbumArtworkKind::Unverified;
  if (collection || compilationAlbumTitle(albumTitle) ||
      ArtworkReleaseRank::collectionMetadata("", "", primaryType.c_str())) return AlbumArtworkKind::ArtistCollection;
  String lower = albumTitle;
  lower.toLowerCase();
  if (primaryType == "Single" || primaryType == "EP" || primaryType == "single" || primaryType == "ep" ||
      lower.endsWith(" - single") || lower.endsWith(" - ep")) return AlbumArtworkKind::Single;
  return AlbumArtworkKind::Album;
}

static String albumTitleForSearch(String title) {
  String lower = title;
  lower.toLowerCase();
  const char* featureMarkers[] = { " feat.", " feat ", " ft.", " ft ", " featuring ", " with " };
  int featureAt = -1;
  for (const char* marker : featureMarkers) {
    int position = lower.indexOf(marker);
    if (position > 0 && (featureAt < 0 || position < featureAt)) featureAt = position;
  }
  if (featureAt > 0) {
    title = title.substring(0, featureAt);
    lower = lower.substring(0, featureAt);
  }

  const char* versionSuffixes[] = {
    " (country version)", " country version", " (acoustic version)", " acoustic version",
    " (radio version)", " radio version", " (radio edit)", " radio edit",
    " (live version)", " live version", " (album version)", " album version",
    " (single version)", " single version"
  };
  for (const char* suffix : versionSuffixes) {
    size_t length = strlen(suffix);
    if (lower.length() > length && lower.endsWith(suffix)) {
      title.remove(title.length() - length);
      break;
    }
  }
  title.trim();
  return title;
}

struct StoreArtworkAlbum {
  String id;
  String title;
  String cover;
  String trackArtist;
  int quality;
  String releaseDate;
  AlbumArtworkKind kind = AlbumArtworkKind::Unverified;
};

static bool isStoreAlbumId(const String& id) {
  if (!id.length() || id.length() > 20 || id == "0") return false;
  for (size_t i = 0; i < id.length(); ++i) {
    if (id[i] < '0' || id[i] > '9') return false;
  }
  return true;
}

static void rankStoreArtworkAlbums(std::vector<StoreArtworkAlbum>& albums) {
  auto release = [](const StoreArtworkAlbum& album) -> ArtworkReleaseRank::Release {
    return {std::string_view(album.title.c_str(), album.title.length()),
            std::string_view(album.releaseDate.c_str(), album.releaseDate.length()), album.quality,
            album.kind == AlbumArtworkKind::Compilation || album.kind == AlbumArtworkKind::ArtistCollection,
            album.kind == AlbumArtworkKind::Single};
  };
  std::stable_sort(albums.begin(), albums.end(), [&](const StoreArtworkAlbum& a, const StoreArtworkAlbum& b) {
    return ArtworkReleaseRank::prefer(release(a), release(b));
  });
}

std::vector<String> ArtworkCache::resolveAlbumArtworkUrls(const String& artist, const String& title,
                                                           AlbumArtworkProvider provider, uint32_t deadlineMs,
                                                           AlbumArtworkFallbacks& fallbacks,
                                                           AlbumArtworkSearch& search) {
  std::vector<String> urls;
  const String artistQuery = encodeArtworkQuery(artist);
  const String titleQuery = encodeArtworkQuery(albumTitleForSearch(title));
  ArtworkJson::Allocator jsonAllocator;
  JsonDocument doc(&jsonAllocator);
  auto cancelled = [&]() {
    PlayerStateSnapshot current = PlayerState::instance().snapshot();
    return !audioConnectionReady || !current.playing || current.artist != artist || current.title != title;
  };
  auto matchQuality = [&](const String& foundArtist, const String& foundTitle) {
    if (exactTrackMatch(foundArtist, foundTitle, artist, title)) return 4;
    if (exactTrackMatch(foundArtist, foundTitle, artist, title, false, true)) return 3;
    if (exactTrackMatch(foundArtist, foundTitle, artist, title, true, true)) return 2;
    return subtitleTrackMatch(foundArtist, foundTitle, artist, title) ? 1 : 0;
  };
  auto addCandidate = [&](const String& url, AlbumArtworkKind kind, const String& albumTitle) {
    std::vector<String>* target = &urls;
    const char* label = "verified artist album";
    switch (kind) {
      case AlbumArtworkKind::Single: target = &fallbacks.singles; label = "artist single/EP fallback"; break;
      case AlbumArtworkKind::ArtistCollection:
        target = &fallbacks.artistCollections; label = "artist collection fallback"; break;
      case AlbumArtworkKind::Unverified: target = &fallbacks.unverified; label = "unverified album fallback"; break;
      case AlbumArtworkKind::Compilation: target = &fallbacks.compilations; label = "compilation fallback"; break;
      case AlbumArtworkKind::Album: break;
    }
    if (!url.length()) return;
    for (const String& existing : *target) if (existing == url) return;
    const size_t before = target->size();
    const bool directFallback = kind != AlbumArtworkKind::Album && url.indexOf("coverartarchive.org/") < 0;
    auto archiveCandidate = std::find_if(target->begin(), target->end(), [](const String& candidate) {
      return candidate.indexOf("coverartarchive.org/") >= 0;
    });
    if (before >= 4) {
      // A long list of MB compilation releases must not crowd out a small,
      // directly downloadable store image for the same fallback category.
      if (!directFallback || archiveCandidate == target->end()) return;
      target->erase(archiveCandidate);
      archiveCandidate = std::find_if(target->begin(), target->end(), [](const String& candidate) {
        return candidate.indexOf("coverartarchive.org/") >= 0;
      });
    }
    if (directFallback) target->insert(archiveCandidate, url);
    else target->push_back(url);
    albumArtTrace("%s: %s", label, albumTitle.c_str());
  };

  static unsigned long lastMusicBrainzRequestMs = 0;
  auto waitForMusicBrainz = [&]() {
    while (lastMusicBrainzRequestMs && millis() - lastMusicBrainzRequestMs < 1100) {
      if (cancelled() || deadlineReached(deadlineMs)) return false;
      vTaskDelay(pdMS_TO_TICKS(20));
    }
    if (cancelled() || deadlineReached(deadlineMs)) return false;
    lastMusicBrainzRequestMs = millis();
    return true;
  };
  auto fetchMusicBrainz = [&](const String& url) {
    if (!search.musicBrainz.canRequest() || !waitForMusicBrainz()) return false;
    search.musicBrainz.requestStarted();
    int status = 0;
    const bool ok = fetchArtworkJson(url, doc, deadlineMs, cancelled, &status);
    if (status == 503) {
      if (!search.musicBrainz.deferred()) search.retryReleaseGroup = url.indexOf("/release-group/?") >= 0;
      search.musicBrainz.serviceUnavailable();
      albumArtTrace(search.musicBrainz.retrying()
          ? "MusicBrainz retry: HTTP 503; no further retry for this track"
          : "MusicBrainz HTTP 503: deferred until other providers finish");
    }
    return ok;
  };
  auto mbKind = [&](JsonObject release, const String& recordingArtist) {
    JsonObject group = release["release-group"].as<JsonObject>();
    String albumArtist = musicBrainzArtistCredit(release["artist-credit"].as<JsonArray>());
    // MusicBrainz search omits the release credit when it is identical to the
    // recording credit; an explicit Various Artists credit must override it.
    if (!albumArtist.length()) albumArtist = recordingArtist;
    const bool collection = musicBrainzSecondaryType(group, "Compilation") ||
                            musicBrainzSecondaryType(group, "Soundtrack") ||
                            musicBrainzSecondaryType(group, "DJ-mix") ||
                            musicBrainzSecondaryType(group, "Live") ||
                            musicBrainzSecondaryType(group, "Remix") ||
                            musicBrainzSecondaryType(group, "Demo");
    const String type = group["primary-type"] | "";
    AlbumArtworkKind kind = albumArtworkKind(albumArtist, recordingArtist,
                                             release["title"] | "", type, collection);
    const String status = release["status"] | "";
    if (kind == AlbumArtworkKind::Album &&
        (type != "Album" || (status.length() && status != "Official"))) {
      kind = AlbumArtworkKind::Unverified;
    }
    return kind;
  };
  if (provider == AlbumArtworkProvider::MusicBrainz) {
    if (!search.musicBrainz.canRequest()) return urls;
    // Prefer the targeted album ID obtained from Last.fm while MusicBrainz
    // was deferred. The retry pass has a single API-request allowance.
    if (search.musicBrainz.retrying() && isMusicBrainzMbid(search.lastFmAlbum.mbid)) {
      const auto& pending = search.lastFmAlbum;
      albumArtTrace("MusicBrainz deferred Last.fm album verification: %s", pending.title.c_str());
      if (fetchMusicBrainz("http://musicbrainz.org/ws/2/release/" + pending.mbid +
                           "?fmt=json&inc=artist-credits+release-groups")) {
        const String releaseArtist = musicBrainzArtistCredit(doc["artist-credit"].as<JsonArray>());
        if (releaseArtist.length()) {
          const AlbumArtworkKind kind = mbKind(doc.as<JsonObject>(), pending.artist);
          if (!artworkMatchNeedsVerifiedAlbum(pending.quality) || kind == AlbumArtworkKind::Album) {
            addCandidate("https://coverartarchive.org/release/" + pending.mbid + "/front-250", kind, pending.title);
            addCandidate(pending.cover, kind, pending.title);
          }
        }
      }
      return urls;
    }
    // Constrain the artist at the server too. A title-only search for common
    // titles (California, Believe, ...) can omit the desired recording entirely.
    // Unquoted artist terms retain reversed-name/duet matching; the complete
    // credit is still checked strictly below before accepting any cover.
    String primaryArtist = artist;
    for (const char* separator : {",", " & ", " feat.", " featuring "}) {
      const int at = primaryArtist.indexOf(separator);
      if (at > 0) primaryArtist.remove(at);
    }
    primaryArtist = normalizeArtworkText(primaryArtist);
    primaryArtist.replace('&', ' ');
    primaryArtist.replace(',', ' ');
    if (primaryArtist == "p nk") primaryArtist = "pink";
    String ownTitle = albumTitleForSearch(title);
    ownTitle.replace('"', ' ');
    const String recordingQuery = "recording:\"" + ownTitle + "\" AND artist:(" + primaryArtist + ")";
    const String mbUrl = "http://musicbrainz.org/ws/2/recording/?fmt=json&limit=16&query=" +
                         encodeArtworkQuery(recordingQuery);
    bool mbOk = false;
    if (!search.musicBrainz.retrying() || !search.retryReleaseGroup) {
      albumArtTrace("MusicBrainz query: %s - %s", artist.c_str(), title.c_str());
      unsigned long requestStartedMs = millis();
      mbOk = fetchMusicBrainz(mbUrl);
      albumArtTrace("MusicBrainz response: %s (%lums)", mbOk ? "ok" : "failed",
                    static_cast<unsigned long>(millis() - requestStartedMs));
    }
    if (mbOk) {
      struct RankedAlbum {
        String groupId;
        String releaseId;
        String title;
        String date;
        int quality;
        bool cd;
      };
      std::vector<RankedAlbum> albums;
      JsonArray recordings = doc["recordings"].as<JsonArray>();
      albumArtTrace("MusicBrainz returned %u recording(s)", static_cast<unsigned>(recordings.size()));
      for (JsonObject recording : recordings) {
        int score = recording["score"] | 0;
        if (score < 80 || recording["video"] == true) continue;
        String foundArtist = musicBrainzArtistCredit(recording["artist-credit"].as<JsonArray>());
        String foundTitle = recording["title"] | "";
        const int quality = matchQuality(foundArtist, foundTitle);
        if (!quality) {
          albumArtTrace("MusicBrainz reject: %s - %s (score %d)", foundArtist.c_str(),
                        foundTitle.c_str(), score);
          continue;
        }
        albumArtTrace("MusicBrainz %s match: %s - %s", artworkMatchLabel(quality),
                      foundArtist.c_str(), foundTitle.c_str());

        JsonArray releases = recording["releases"].as<JsonArray>();
        for (JsonObject release : releases) {
          const String releaseId = release["id"] | "";
          const String groupId = release["release-group"]["id"] | "";
          if (!isMusicBrainzMbid(releaseId)) continue;
          const String albumTitle = release["title"] | "";
          const AlbumArtworkKind kind = mbKind(release, foundArtist);
          if (artworkMatchNeedsVerifiedAlbum(quality) && kind != AlbumArtworkKind::Album) continue;
          if (kind != AlbumArtworkKind::Album) {
            addCandidate("https://coverartarchive.org/release/" + releaseId + "/front-250", kind, albumTitle);
            continue;
          }
          String date = release["date"] | "";
          if (date.length() < 4) date = "9999";
          bool cd = false;
          JsonArray media = release["media"].as<JsonArray>();
          for (JsonObject medium : media) {
            if (medium["format"] == "CD") cd = true;
          }
          bool duplicate = false;
          for (RankedAlbum& existing : albums) {
            if (isMusicBrainzMbid(groupId) && existing.groupId == groupId) {
              if (quality > existing.quality ||
                  (quality == existing.quality && (date < existing.date ||
                   (date == existing.date && cd && !existing.cd)))) {
                existing = {groupId, releaseId, albumTitle, date, quality, cd};
              }
              duplicate = true;
              break;
            }
          }
          if (!duplicate && albums.size() < 16) albums.push_back({groupId, releaseId, albumTitle, date, quality, cd});
        }
      }
      std::stable_sort(albums.begin(), albums.end(), [](const RankedAlbum& a, const RankedAlbum& b) {
        if (a.quality != b.quality) return a.quality > b.quality;
        if (a.date != b.date) return a.date < b.date;
        return a.cd && !b.cd;
      });
      for (const RankedAlbum& album : albums) {
        if (urls.size() >= 2) break;
        addCandidate("https://coverartarchive.org/" +
                     String(isMusicBrainzMbid(album.groupId) ? "release-group/" : "release/") +
                     (isMusicBrainzMbid(album.groupId) ? album.groupId : album.releaseId) + "/front-250",
                     AlbumArtworkKind::Album, album.title);
      }
      if (!albums.empty()) addCandidate("https://coverartarchive.org/release/" + albums[0].releaseId +
                                        "/front-250", AlbumArtworkKind::Album, albums[0].title);
      albumArtTrace("MusicBrainz Cover Art Archive candidates: %u", static_cast<unsigned>(urls.size()));
    }
    doc.clear();
    if (!urls.empty()) return urls;
    // If there is no artist album, retain the named Single/EP, but give later
    // providers a chance to identify the original album before downloading it.
    if (search.musicBrainz.canRequest() && (fallbacks.singles.empty() || search.musicBrainz.retrying())) {
      const String groupQuery = "releasegroup:\"" + ownTitle + "\" AND artist:(" + primaryArtist + ")";
      if (fetchMusicBrainz("http://musicbrainz.org/ws/2/release-group/?fmt=json&limit=8&query=" +
                           encodeArtworkQuery(groupQuery))) {
        JsonArray groups = doc["release-groups"].as<JsonArray>();
        for (JsonObject group : groups) {
          const String foundArtist = musicBrainzArtistCredit(group["artist-credit"].as<JsonArray>());
          const String groupId = group["id"] | "";
          const int quality = matchQuality(foundArtist, group["title"] | "");
          if ((group["score"] | 0) < 80 || !isMusicBrainzMbid(groupId) ||
              !quality) continue;
          const bool collection = musicBrainzSecondaryType(group, "Compilation") ||
                                  musicBrainzSecondaryType(group, "Soundtrack") ||
                                  musicBrainzSecondaryType(group, "Live") ||
                                  musicBrainzSecondaryType(group, "Remix");
          AlbumArtworkKind kind = albumArtworkKind(foundArtist, artist, group["title"] | "",
                                                   group["primary-type"] | "", collection);
          const String type = group["primary-type"] | "";
          if (!type.length()) kind = AlbumArtworkKind::Unverified;
          if (artworkMatchNeedsVerifiedAlbum(quality) && kind != AlbumArtworkKind::Album) continue;
          addCandidate("https://coverartarchive.org/release-group/" + groupId + "/front-250",
                       kind, group["title"] | "");
        }
      }
      doc.clear();
    }
  }

  String apiKey = AppConfig::instance().effectiveLastFmApiKey();
  if (provider == AlbumArtworkProvider::LastFm && apiKey.length()) {
    String lastFmUrl = "https://ws.audioscrobbler.com/2.0/?method=track.getInfo&format=json&api_key=";
    lastFmUrl += encodeArtworkQuery(apiKey);
    lastFmUrl += "&autocorrect=1&artist=" + artistQuery + "&track=" + titleQuery;
    unsigned long requestStartedMs = millis();
    bool lastFmOk = fetchArtworkJson(lastFmUrl, doc, deadlineMs, cancelled);
    if (lastFmOk && !doc["track"].is<JsonObject>()) {
      if (doc["error"].is<int>()) {
        albumArtTrace("Last.fm API error: %d", doc["error"].as<int>());
      } else {
        albumArtTrace("Last.fm response has no track data");
      }
      lastFmOk = false;
    }
    albumArtTrace("Last.fm response: %s (%lums)", lastFmOk ? "ok" : "failed",
                  static_cast<unsigned long>(millis() - requestStartedMs));
    if (lastFmOk) {
      String foundArtist = doc["track"]["artist"]["name"] | "";
      String foundTitle = doc["track"]["name"] | "";
      const int quality = matchQuality(foundArtist, foundTitle);
      if (quality) {
        albumArtTrace("Last.fm %s match: %s - %s", artworkMatchLabel(quality),
                      foundArtist.c_str(), foundTitle.c_str());
        const String albumArtist = doc["track"]["album"]["artist"] | "";
        const String albumTitle = doc["track"]["album"]["title"] | "";
        const String albumMbid = doc["track"]["album"]["mbid"] | "";
        if (!doc["track"]["album"].is<JsonObject>()) {
          albumArtTrace("Last.fm matched track has no album data");
        }
        String cdnCover;
        {
          JsonArray images = doc["track"]["album"]["image"].as<JsonArray>();
          String extraLargeCover;
          String largeCover;
          for (JsonObject image : images) {
            String size = image["size"] | "";
            const char* cover = image["#text"] | "";
            if (size == "extralarge" && strlen(cover)) extraLargeCover = cover;
            if (size == "large" && strlen(cover)) largeCover = cover;
          }
          // Keep the smaller CDN image as a fallback if the MBID release has
          // no CAA cover. 174px is close to the 176px LCD frame and much smaller
          // than Last.fm's frequently 100-200KB 300px PNG.
          cdnCover = largeCover.length() ? largeCover : extraLargeCover;
        }
        if (!cdnCover.length() && !isMusicBrainzMbid(albumMbid)) {
          albumArtTrace("Last.fm matched track has no usable album image or release MBID");
        }
        // track.getInfo can credit a compilation to the track performer. Do
        // not call it an artist album unless the release MBID confirms that.
        AlbumArtworkKind kind = isCompilationArtist(albumArtist) || compilationAlbumTitle(albumTitle)
                                  ? AlbumArtworkKind::Compilation : AlbumArtworkKind::Unverified;
        doc.clear();
        if (kind != AlbumArtworkKind::Compilation && isMusicBrainzMbid(albumMbid)) {
          if (fetchMusicBrainz("http://musicbrainz.org/ws/2/release/" + albumMbid +
                               "?fmt=json&inc=artist-credits+release-groups")) {
            const String releaseArtist = musicBrainzArtistCredit(doc["artist-credit"].as<JsonArray>());
            if (releaseArtist.length()) kind = mbKind(doc.as<JsonObject>(), foundArtist);
          }
          doc.clear();
          if (search.musicBrainz.deferred()) {
            search.lastFmAlbum = {albumMbid, foundArtist, albumTitle, cdnCover, quality};
            albumArtTrace("Last.fm album verification deferred with MusicBrainz");
          }
        }
        if (artworkMatchNeedsVerifiedAlbum(quality) && kind != AlbumArtworkKind::Album) return urls;
        if (isMusicBrainzMbid(albumMbid)) {
          addCandidate("https://coverartarchive.org/release/" + albumMbid + "/front-250", kind, albumTitle);
        }
        addCandidate(cdnCover, kind, albumTitle);
      } else if (!foundArtist.length() || !foundTitle.length()) {
        albumArtTrace("Last.fm track data incomplete: artist/title missing");
      } else {
        albumArtTrace("Last.fm returned a different track: %s - %s", foundArtist.c_str(), foundTitle.c_str());
      }
    }
    doc.clear();
  } else if (provider == AlbumArtworkProvider::LastFm) {
    albumArtTrace("Last.fm skipped: no API key configured");
  }

  if (provider == AlbumArtworkProvider::Deezer) {
    String deezerUrl = "https://api.deezer.com/search/track?q=" + artistQuery + "%20" + titleQuery + "&limit=8";
    unsigned long requestStartedMs = millis();
    bool deezerOk = fetchArtworkJson(deezerUrl, doc, deadlineMs, cancelled);
    albumArtTrace("Deezer response: %s (%lums)", deezerOk ? "ok" : "failed",
                  static_cast<unsigned long>(millis() - requestStartedMs));
    if (deezerOk) {
      std::vector<StoreArtworkAlbum> albums;
      JsonArray tracks = doc["data"].as<JsonArray>();
      albumArtTrace("Deezer returned %u track(s)", static_cast<unsigned>(tracks.size()));
      for (JsonObject track : tracks) {
        String foundArtist = track["artist"]["name"] | "";
        String foundTitle = track["title"] | "";
        const int quality = matchQuality(foundArtist, foundTitle);
        if (quality) {
          albumArtTrace("Deezer %s match: %s - %s", artworkMatchLabel(quality),
                        foundArtist.c_str(), foundTitle.c_str());
          const String id = track["album"]["id"].as<String>();
          bool duplicate = false;
          for (StoreArtworkAlbum& existing : albums) {
            if (existing.id == id) {
              existing.quality = max(existing.quality, quality);
              duplicate = true;
            }
          }
          if (!duplicate && isStoreAlbumId(id) && albums.size() < 8) {
            albums.push_back({id, track["album"]["title"] | "", track["album"]["cover_medium"] | "",
                              foundArtist, quality, track["release_date"] | ""});
          }
        } else albumArtTrace("Deezer reject: %s - %s", foundArtist.c_str(), foundTitle.c_str());
      }
      doc.clear();
      rankStoreArtworkAlbums(albums);
      // Search results normally omit album.artist. Verify ownership once on
      // the album endpoint, not by assuming the song artist owns the album.
      const size_t verifyCount = min<size_t>(albums.size(), 2);
      bool verificationUnavailable = false;
      for (size_t i = 0; i < verifyCount && !cancelled() && !deadlineReached(deadlineMs); ++i) {
        const StoreArtworkAlbum& album = albums[i];
        AlbumArtworkKind kind = AlbumArtworkKind::Unverified;
        String cover = album.cover;
        int lookupStatus = 0;
        const bool lookupOk = !verificationUnavailable &&
            fetchArtworkJson("https://api.deezer.com/album/" + album.id, doc, deadlineMs, cancelled, &lookupStatus);
        if (!lookupOk && (lookupStatus <= 0 || lookupStatus == 503)) {
          if (!verificationUnavailable) albumArtTrace("Deezer album verification unavailable; retaining remaining exact-match covers as unverified fallbacks");
          verificationUnavailable = true;
        }
        if (lookupOk &&
            doc["id"].as<String>() == album.id) {
          const String albumArtist = doc["artist"]["name"] | "";
          const String albumTitle = doc["title"] | album.title;
          kind = albumArtworkKind(albumArtist, album.trackArtist, albumTitle, doc["record_type"] | "");
          const String verifiedCover = doc["cover_medium"] | "";
          if (verifiedCover.length()) cover = verifiedCover;
          albumArtTrace("Deezer album owner: %s - %s", albumArtist.c_str(), albumTitle.c_str());
        }
        doc.clear();
        if (artworkMatchNeedsVerifiedAlbum(album.quality) && kind != AlbumArtworkKind::Album) continue;
        addCandidate(cover, kind, album.title);
        if (!urls.empty()) break;
      }
    }
    doc.clear();
  }

  if (provider == AlbumArtworkProvider::ITunes) {
    String itunesUrl = "https://itunes.apple.com/search?term=" + artistQuery + "%20" + titleQuery + "&entity=song&limit=16";
    unsigned long requestStartedMs = millis();
    bool itunesOk = fetchArtworkJson(itunesUrl, doc, deadlineMs, cancelled);
    albumArtTrace("iTunes response: %s (%lums)", itunesOk ? "ok" : "failed",
                  static_cast<unsigned long>(millis() - requestStartedMs));
    if (itunesOk) {
      std::vector<StoreArtworkAlbum> albums;
      JsonArray results = doc["results"].as<JsonArray>();
      albumArtTrace("iTunes returned %u result(s)", static_cast<unsigned>(results.size()));
      for (JsonObject result : results) {
        String foundArtist = result["artistName"] | "";
        String foundTitle = result["trackName"] | "";
        const int quality = matchQuality(foundArtist, foundTitle);
        if (quality) {
          albumArtTrace("iTunes %s match: %s - %s", artworkMatchLabel(quality),
                        foundArtist.c_str(), foundTitle.c_str());
          String cover = result["artworkUrl100"] | "";
          if (cover.length()) {
            cover.replace("100x100bb", "250x250bb");
            const String albumTitle = result["collectionName"] | "";
            const String albumArtist = result["collectionArtistName"] | "";
            const String id = result["collectionId"].as<String>();
            if (isCompilationArtist(albumArtist)) {
              if (!artworkMatchNeedsVerifiedAlbum(quality)) addCandidate(cover, AlbumArtworkKind::Compilation, albumTitle);
              continue;
            }
            bool duplicate = false;
            for (StoreArtworkAlbum& existing : albums) {
              if (existing.id == id) {
                existing.quality = max(existing.quality, quality);
                duplicate = true;
              }
            }
            if (!duplicate && isStoreAlbumId(id) && albums.size() < 8) {
              albums.push_back({id, albumTitle, cover, foundArtist, quality, result["releaseDate"] | ""});
            }
          }
        } else albumArtTrace("iTunes reject: %s - %s", foundArtist.c_str(), foundTitle.c_str());
      }
      doc.clear();
      rankStoreArtworkAlbums(albums);
      // A single batched lookup provides the real album artists. A missing
      // collectionArtistName on a song result is not ownership evidence.
      if (albums.size() > 3) albums.resize(3);
      String albumIds;
      for (const StoreArtworkAlbum& album : albums) {
        if (albumIds.length()) albumIds += ',';
        albumIds += album.id;
      }
      bool lookupOk = false;
      if (albumIds.length()) {
        ArtworkPhaseTrace phase("iTunes album-verification");
        lookupOk = fetchArtworkJson("https://itunes.apple.com/lookup?id=" + albumIds + "&entity=album",
                                    doc, deadlineMs, cancelled);
      }
      for (StoreArtworkAlbum& album : albums) {
        if (lookupOk) {
          JsonArray lookupResults = doc["results"].as<JsonArray>();
          for (JsonObject result : lookupResults) {
            if (result["wrapperType"] != "collection" || result["collectionId"].as<String>() != album.id) continue;
            const String albumArtist = result["artistName"] | "";
            const String albumTitle = result["collectionName"] | album.title;
            const int tracks = result["trackCount"] | 0;
            const String copyright = result["copyright"] | "";
            const String genre = result["primaryGenreName"] | "";
            const bool collection = ArtworkReleaseRank::collectionMetadata(copyright.c_str(), genre.c_str());
            album.kind = albumArtworkKind(albumArtist, album.trackArtist, albumTitle,
                                           tracks > 0 && tracks <= 4 ? "Single" : "Album", collection);
            album.title = albumTitle;
            const String releaseDate = result["releaseDate"] | "";
            if (releaseDate.length()) album.releaseDate = releaseDate;
            albumArtTrace("iTunes album owner: %s - %s (%s%s)", albumArtist.c_str(), albumTitle.c_str(),
                          album.releaseDate.c_str(), collection ? "; collection metadata" : "");
            break;
          }
        }
      }
      doc.clear();
      // The lookup may reveal a soundtrack/compilation or a parent box set
      // whose title differs from the song search. Rank AGAIN using that data.
      rankStoreArtworkAlbums(albums);
      for (const StoreArtworkAlbum& album : albums) {
        if (artworkMatchNeedsVerifiedAlbum(album.quality) && album.kind != AlbumArtworkKind::Album) continue;
        addCandidate(album.cover, album.kind, album.title);
      }
    }
  }
  return urls;
}

bool ArtworkCache::resolveAndDownloadAlbumArtwork(const String& artist, const String& title,
                                                   const String& key, String& outPath) {
  const unsigned long searchStartedMs = millis();
  const uint32_t searchDeadlineMs = searchStartedMs + ALBUM_ART_LOOKUP_BUDGET_MS;
  AlbumArtworkFallbacks fallbacks;
  AlbumArtworkSearch search;
  albumArtTrace("search start: %s - %s", artist.c_str(), title.c_str());
  const AlbumArtworkProvider providers[] = {
    AlbumArtworkProvider::MusicBrainz,
    AlbumArtworkProvider::LastFm,
    AlbumArtworkProvider::ITunes,
    AlbumArtworkProvider::Deezer
  };
  const size_t providerCount = sizeof(providers) / sizeof(providers[0]);
  const size_t retryStage = providerCount;
  const size_t fallbackStart = retryStage + 1;
  const char* providerNames[] = { "MusicBrainz/CAA", "Last.fm", "iTunes", "Deezer",
                                "MusicBrainz retry",
                                "artist single/EP fallback", "artist collection fallback",
                                "unverified album fallback", "compilation fallback" };
  const size_t stageCount = sizeof(providerNames) / sizeof(providerNames[0]);
  for (size_t providerIndex = 0; providerIndex < stageCount; ++providerIndex) {
    if (millis() - searchStartedMs >= ALBUM_ART_LOOKUP_BUDGET_MS) {
      albumArtTrace("search budget reached after %lums", static_cast<unsigned long>(millis() - searchStartedMs));
      return false;
    }
    // Reserve time to display an already known fallback rather than spending
    // the entire lookup budget on more metadata with nothing left to download.
    const bool hasFallback = !fallbacks.singles.empty() || !fallbacks.artistCollections.empty() ||
                             !fallbacks.unverified.empty() || !fallbacks.compilations.empty();
    if (providerIndex <= retryStage && hasFallback &&
        millis() - searchStartedMs >= ALBUM_ART_LOOKUP_BUDGET_MS - ALBUM_ART_IMAGE_BUDGET_MS) {
      albumArtTrace("reserving remaining search budget for known artwork fallback");
      providerIndex = fallbackStart;
    }
    PlayerStateSnapshot current = PlayerState::instance().snapshot();
    if (!current.playing || current.artist != artist || current.title != title) {
      albumArtTrace("search cancelled: track changed before %s", providerNames[providerIndex]);
      return false;
    }
    unsigned long providerStartedMs = millis();
    std::vector<String> candidates;
    if (providerIndex < providerCount) {
      candidates = resolveAlbumArtworkUrls(artist, title, providers[providerIndex], searchDeadlineMs, fallbacks, search);
    } else if (providerIndex == retryStage) {
      if (!search.musicBrainz.beginRetry()) continue;
      albumArtTrace("MusicBrainz retry after other providers: one API request allowed");
      candidates = resolveAlbumArtworkUrls(artist, title, AlbumArtworkProvider::MusicBrainz,
                                           searchDeadlineMs, fallbacks, search);
    } else {
      const std::vector<String>* fallbackStages[] = {&fallbacks.singles, &fallbacks.artistCollections,
                                                    &fallbacks.unverified, &fallbacks.compilations};
      candidates = *fallbackStages[providerIndex - fallbackStart];
      if (candidates.size() > 2) candidates.resize(2);
    }
    albumArtTrace("%s: %u image candidate(s), %lums", providerNames[providerIndex],
                  static_cast<unsigned>(candidates.size()),
                  static_cast<unsigned long>(millis() - providerStartedMs));
    if (providerIndex <= retryStage &&
        (!fallbacks.singles.empty() || !fallbacks.artistCollections.empty() ||
         !fallbacks.unverified.empty() || !fallbacks.compilations.empty())) {
      albumArtTrace("fallback images retained: single/EP=%u, artist-collection=%u, unverified=%u, compilation=%u",
                    static_cast<unsigned>(fallbacks.singles.size()),
                    static_cast<unsigned>(fallbacks.artistCollections.size()),
                    static_cast<unsigned>(fallbacks.unverified.size()),
                    static_cast<unsigned>(fallbacks.compilations.size()));
    }
    for (const String& candidate : candidates) {
      const unsigned long elapsedMs = millis() - searchStartedMs;
      if (elapsedMs >= ALBUM_ART_LOOKUP_BUDGET_MS) {
        albumArtTrace("search budget reached before image download");
        return false;
      }
      if (idlePrewarmCancellationRequested()) {
        albumArtTrace("search cancelled: idle prewarm requested");
        return false;
      }
      current = PlayerState::instance().snapshot();
      if (!current.playing || current.artist != artist || current.title != title) {
        albumArtTrace("search cancelled: track changed before image download");
        return false;
      }
      unsigned long downloadStartedMs = millis();
      albumArtTrace("trying image from %s: %s", providerNames[providerIndex], candidate.c_str());
      const uint32_t imageBudgetMs = min<uint32_t>(
          ALBUM_ART_IMAGE_BUDGET_MS, ALBUM_ART_LOOKUP_BUDGET_MS - elapsedMs);
      bool memoryUnavailable = false;
      if (download(candidate, outPath, imageBudgetMs, true, key, &memoryUnavailable)) {
        albumArtTrace("image ready: %s (%lums; total %lums)", outPath.c_str(),
                      static_cast<unsigned long>(millis() - downloadStartedMs),
                      static_cast<unsigned long>(millis() - searchStartedMs));
        return true;
      }
      albumArtTrace("image failed after %lums: %s",
                    static_cast<unsigned long>(millis() - downloadStartedMs),
                    lastDownloadStatus().c_str());
      if (memoryUnavailable) {
        albumArtTrace("search stopped: album RAM unavailable; using station-logo fallback");
        return false;
      }
    }
  }
  albumArtTrace("no cover found for %s - %s (%lums)", artist.c_str(), title.c_str(),
                static_cast<unsigned long>(millis() - searchStartedMs));
  return false;
}

String ArtworkCache::embeddedKey(const String& streamUrl, const std::vector<uint32_t>& segments) const {
  String key = "embedded:";
  key += streamUrl;
  for (size_t i = 0; i + 1 < segments.size(); i += 2) {
    key += ':';
    key += String(segments[i]);
    key += '+';
    key += String(segments[i + 1]);
  }
  return key;
}

String ArtworkCache::cachePath(const String& url, const String& extension) const {
  char path[40];
  snprintf(path, sizeof(path), "/cache/art_%08lx%s", static_cast<unsigned long>(fnv1a(url)), extension.c_str());
  return String(path);
}

bool ArtworkCache::findExistingCachePath(const String& url, String& outPath) const {
  if (url.startsWith(ALBUM_ART_CACHE_PREFIX)) {
    const auto frame = AlbumArtStore::instance().find(url);
    if (frame) outPath = frame->path;
    return static_cast<bool>(frame); // Album art never probes the flash cache.
  }
  const char* extensions[] = { ".png", ".jpg", ".jpeg", ".bmp" };
  for (const char* extension : extensions) {
    String path = cachePath(url, extension);
    if (LittleFS.exists(path)) {
      outPath = path;
      return true;
    }
  }
  return false;
}

static bool validLcdThumbnailFile(const String& path);

static String fileStem(const String& path) {
  int slash = path.lastIndexOf('/');
  int dot = path.lastIndexOf('.');
  if (dot <= slash) return path;
  return path.substring(0, dot);
}

static String lcdThumbnailSizedSuffix() {
  return "_" + String(LCD_THUMB_SIZE) + LCD_THUMB_EXT;
}

static String lcdThumbnailFillSuffix() {
  return "_" + String(LCD_THUMB_SIZE) + "_fill2" + LCD_THUMB_EXT;
}

static String lcdThumbnailLegacyFillSuffix() {
  return "_" + String(LCD_THUMB_SIZE) + "_fill" + LCD_THUMB_EXT;
}

static bool isPairedCacheThumbnailPath(const String& path) {
  if (!path.startsWith("/cache/")) return false;
  String lower = path;
  lower.toLowerCase();
  return lower.endsWith(lcdThumbnailSizedSuffix()) || lower.endsWith(lcdThumbnailFillSuffix()) ||
         lower.endsWith(lcdThumbnailLegacyFillSuffix());
}

static String cacheFamilyStemForPath(const String& path) {
  if (isPairedCacheThumbnailPath(path)) {
    String suffix = path.endsWith(lcdThumbnailFillSuffix()) ? lcdThumbnailFillSuffix() :
                    path.endsWith(lcdThumbnailLegacyFillSuffix()) ? lcdThumbnailLegacyFillSuffix() :
                    lcdThumbnailSizedSuffix();
    return path.substring(0, path.length() - suffix.length());
  }
  return fileStem(path);
}

void ArtworkCache::removeCachedArtworkFamily(const String& imagePath) {
  if (AlbumArtStore::isPath(imagePath)) {
    AlbumArtStore::instance().retire(imagePath);
    return;
  }
  if (!imagePath.startsWith("/cache/")) return;
  const String stem = cacheFamilyStemForPath(imagePath);
  File root = LittleFS.open("/cache");
  if (!root || !root.isDirectory()) return;
  std::vector<String> removePaths;
  File file = root.openNextFile();
  while (file) {
    String path = file.path();
    if (!path.length()) path = String("/cache/") + file.name();
    if (!file.isDirectory() && cacheFamilyStemForPath(path) == stem) removePaths.push_back(path);
    file.close();
    file = root.openNextFile();
  }
  root.close();
  for (const String& path : removePaths) LittleFS.remove(path);
}

static String fileNameOnly(const String& path) {
  int slash = path.lastIndexOf('/');
  if (slash < 0) return path;
  return path.substring(slash + 1);
}

static bool isRemoteArtworkSource(const String& source) {
  return source.startsWith("http://") || source.startsWith("https://");
}

bool ArtworkCache::findExistingLcdArtworkPath(const String& source, String& outPath) const {
  outPath = "";
  String item = source;
  item.trim();
  if (!item.length()) return false;

  String thumbPath;
  if (isRemoteArtworkSource(item)) {
    thumbPath = cachePath(item, "") + lcdThumbnailSizedSuffix();
  } else {
    item = preferredLocalArtworkPath(item);
    String lower = item;
    lower.toLowerCase();
    thumbPath = lower.endsWith(LCD_THUMB_EXT) ? item : lcdThumbnailPath(item);
  }

  if (!validLcdThumbnailFile(thumbPath)) return false;
  outPath = thumbPath;
  return true;
}

bool ArtworkCache::compactRemoteArtwork(const String& source, const String& imagePath, String& outPath, bool fillFrame) {
  outPath = imagePath;
  if (!isRemoteArtworkSource(source) || !imagePath.startsWith("/cache/")) return false;

  String thumbPath = lcdThumbnailPath(imagePath, fillFrame);
  String expectedStem = cachePath(source, "");
  if (cacheFamilyStemForPath(thumbPath) != expectedStem || !validLcdThumbnailFile(thumbPath)) {
    return false;
  }

  size_t removedBytes = 0;
  const char* extensions[] = { ".png", ".jpg", ".jpeg", ".bmp" };
  for (const char* extension : extensions) {
    String originalPath = cachePath(source, extension);
    if (!LittleFS.exists(originalPath)) continue;
    File original = LittleFS.open(originalPath, "r");
    size_t originalBytes = original ? original.size() : 0;
    if (original) original.close();
    if (LittleFS.remove(originalPath)) removedBytes += originalBytes;
  }

  outPath = thumbPath;
  markThumbnailReady(thumbPath, thumbPath);
  if (removedBytes > 0) {
    Serial.printf("[artwork] lcd-only cache kept: %s, source removed (%u bytes)\n",
                  thumbPath.c_str(),
                  static_cast<unsigned>(removedBytes));
  }
  return true;
}

static bool supportedArtworkFile(const String& path) {
  String lower = path;
  lower.toLowerCase();
  return lower.endsWith(".png") ||
         lower.endsWith(".jpg") ||
         lower.endsWith(".jpeg") ||
         lower.endsWith(".bmp") ||
         lower.endsWith(LCD_THUMB_EXT);
}

static bool cacheKeepProtects(const String& entryPath, const String& keepPath) {
  if (!keepPath.length()) return false;
  if (entryPath == keepPath) return true;
  if (!entryPath.startsWith("/cache/") || !keepPath.startsWith("/cache/")) return false;
  return cacheFamilyStemForPath(entryPath) == cacheFamilyStemForPath(keepPath);
}

String ArtworkCache::preferredLocalArtworkPath(String source) const {
  source.trim();
  if (!source.length() || isRemoteArtworkSource(source)) return source;

  String localPath = source;
  if (!localPath.startsWith("/")) {
    String rooted = "/" + localPath;
    String logosRooted = "/logos/" + localPath;
    if (LittleFS.exists(rooted)) {
      localPath = rooted;
    } else if (LittleFS.exists(logosRooted)) {
      localPath = logosRooted;
    } else {
      localPath = rooted;
    }
  }

  String lower = localPath;
  lower.toLowerCase();
  if (!lower.endsWith(".jpg") && !lower.endsWith(".jpeg")) return localPath;

  String pngPath = fileStem(localPath) + ".png";
  if (LittleFS.exists(pngPath)) return pngPath;

  String bmpPath = fileStem(localPath) + ".bmp";
  if (LittleFS.exists(bmpPath)) return bmpPath;

  String baseName = fileNameOnly(localPath);
  String logoPngPath = "/logos/" + fileStem(baseName) + ".png";
  if (LittleFS.exists(logoPngPath)) return logoPngPath;

  String logoBmpPath = "/logos/" + fileStem(baseName) + ".bmp";
  if (LittleFS.exists(logoBmpPath)) return logoBmpPath;

  return localPath;
}

bool ArtworkCache::queuePrewarmItem(const String& source, bool highPriority) {
  if (!prewarmMutex || !source.length()) return false;

  bool queued = false;
  if (xSemaphoreTake(prewarmMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
    for (const String& item : prewarmQueue) {
      if (item == source) {
        xSemaphoreGive(prewarmMutex);
        return true;
      }
    }

    if (prewarmQueue.size() >= PREWARM_QUEUE_LIMIT) {
      if (highPriority && !prewarmQueue.empty()) {
        prewarmQueue.pop_back();
      } else {
        xSemaphoreGive(prewarmMutex);
        return false;
      }
    }

    if (highPriority) {
      prewarmQueue.insert(prewarmQueue.begin(), source);
    } else {
      prewarmQueue.push_back(source);
    }
    queued = true;
    xSemaphoreGive(prewarmMutex);
  }

  if (queued) {
    if (highPriority) lastPrewarmWorkMs = 0;
    Serial.printf("[artwork] prewarm queued: %s\n", source.c_str());
  }
  return queued;
}

bool ArtworkCache::requestPrewarm(const String& source, bool highPriority) {
  String item = source;
  item.trim();
  if (!item.length()) return false;

  if (!isRemoteArtworkSource(item)) {
    item = preferredLocalArtworkPath(item);
    if (!supportedArtworkFile(item) || !LittleFS.exists(item)) return false;

    String thumbPath = lcdThumbnailPath(item);
    if (thumbnailKnownReady(item, thumbPath) || validLcdThumbnailFile(thumbPath)) {
      markThumbnailReady(item, thumbPath);
      return true;
    }
  } else {
    String lcdPath;
    if (findExistingLcdArtworkPath(item, lcdPath)) return true;
    String existingPath;
    if (findExistingCachePath(item, existingPath)) {
      return requestPrewarm(existingPath, highPriority);
    }
  }

  return queuePrewarmItem(item, highPriority);
}

bool ArtworkCache::artworkSourceReady(const String& source) const {
  String item = source;
  item.trim();
  if (!item.length()) return true;

  if (isRemoteArtworkSource(item)) {
    String lcdPath;
    if (findExistingLcdArtworkPath(item, lcdPath)) return true;
    String existingPath;
    if (!findExistingCachePath(item, existingPath)) return false;
    item = existingPath;
  } else {
    item = preferredLocalArtworkPath(item);
  }

  if (!supportedArtworkFile(item) || !LittleFS.exists(item)) return false;

  String lower = item;
  lower.toLowerCase();
  if (lower.endsWith(LCD_THUMB_EXT)) return validLcdThumbnailFile(item);

  String thumbPath = lcdThumbnailPath(item);
  return thumbnailKnownReady(item, thumbPath) || validLcdThumbnailFile(thumbPath);
}

bool ArtworkCache::takePrewarmItem(String& source) {
  if (!prewarmMutex) return false;

  bool hasItem = false;
  if (xSemaphoreTake(prewarmMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    if (!prewarmQueue.empty()) {
      source = prewarmQueue.front();
      prewarmQueue.erase(prewarmQueue.begin());
      hasItem = true;
    }
    xSemaphoreGive(prewarmMutex);
  }
  return hasItem;
}

bool ArtworkCache::queueNextStationPrewarmCandidate() {
  StationManager& stations = StationManager::instance();
  const size_t stationCount = stations.count();
  if (!stationCount) {
    stationPrewarmIndex = 0;
    stationPrewarmRevision = stations.revision();
    return false;
  }

  const uint32_t revision = stations.revision();
  if (revision != stationPrewarmRevision || stationPrewarmIndex >= stationCount) {
    stationPrewarmRevision = revision;
    stationPrewarmIndex = 0;
  }

  const size_t scanLimit = stationCount < 8 ? stationCount : 8;
  for (size_t scanned = 0; scanned < scanLimit; ++scanned) {
    const size_t index = stationPrewarmIndex;
    stationPrewarmIndex = (stationPrewarmIndex + 1) % stationCount;

    Station station;
    if (!stations.stationAtIndex(index, station)) continue;

    String logo = station.logo;
    logo.trim();
    if (!logo.length() || prewarmFailureBlocked(logo) || artworkSourceReady(logo)) continue;

    artworkTraceSerial.printf("[artwork] idle station prewarm queued: #%u %s\n",
                  static_cast<unsigned>(index + 1),
                  logo.c_str());
    return requestPrewarm(logo, false);
  }

  return false;
}

void ArtworkCache::processPrewarmQueue(const PlayerStateSnapshot& state) {
  if (state.playing || isDownloadActive()) return;

  unsigned long now = millis();
  if (lastPrewarmWorkMs > 0 && now - lastPrewarmWorkMs < PREWARM_IDLE_SPACING_MS) return;

  // Throttle empty/all-ready scans too; never walk the filesystem every loop.
  lastPrewarmWorkMs = now;
  String source;
  if (!takePrewarmItem(source)) {
    if (!queueNextStationPrewarmCandidate() || !takePrewarmItem(source)) return;
  }

  if (prewarmFailureBlocked(source)) {
    Serial.printf("[artwork] prewarm retry delayed: %s\n", source.c_str());
    return;
  }

  if (isRemoteArtworkSource(source)) {
    String lcdPath;
    if (findExistingLcdArtworkPath(source, lcdPath)) return;
    String existingPath;
    if (findExistingCachePath(source, existingPath)) {
      requestPrewarm(existingPath, true);
      return;
    }

    artworkTraceSerial.printf("[artwork] prewarm download start: %s\n", source.c_str());
    if (!startDownloadTask(source, true)) {
      queuePrewarmItem(source, true);
    }
    return;
  }

  String localPath = preferredLocalArtworkPath(source);
  if (!supportedArtworkFile(localPath) || !LittleFS.exists(localPath)) return;

  artworkTraceSerial.printf("[artwork] prewarm thumbnail start: %s\n", localPath.c_str());
  requestLcdThumbnail(localPath, true);
}

bool ArtworkCache::prewarmFailureBlocked(const String& source) const {
  if (!source.length()) return false;

  unsigned long now = millis();
  for (const PrewarmFailure& failure : prewarmFailures) {
    if (failure.source == source && now - failure.failedMs < PREWARM_FAILURE_RETRY_MS) {
      return true;
    }
  }
  return false;
}

void ArtworkCache::notePrewarmFailure(const String& source) {
  if (!source.length() || source.startsWith("thumb:")) return;

  const unsigned long now = millis();
  for (PrewarmFailure& failure : prewarmFailures) {
    if (failure.source == source) {
      failure.failedMs = now;
      return;
    }
  }

  static constexpr size_t MAX_PREWARM_FAILURES = 32;
  if (prewarmFailures.size() >= MAX_PREWARM_FAILURES) {
    prewarmFailures.erase(prewarmFailures.begin());
  }
  PrewarmFailure failure;
  failure.source = source;
  failure.failedMs = now;
  prewarmFailures.push_back(failure);
}

size_t ArtworkCache::cacheBytes() const {
  File root = LittleFS.open("/cache");
  if (!root || !root.isDirectory()) return 0;

  size_t total = 0;
  File file = root.openNextFile();
  while (file) {
    if (!file.isDirectory()) total += file.size();
    file = root.openNextFile();
  }
  root.close();
  return total;
}

size_t ArtworkCache::cacheLimitBytes() const {
  return MAX_CACHE_BYTES;
}

size_t ArtworkCache::cacheTargetBytes() const {
  return TARGET_CACHE_BYTES;
}

void ArtworkCache::enforceCacheBudget(size_t incomingBytes, const String& keepPath) {
  if (!LittleFS.exists("/cache")) return;

  // Cache usage cannot exceed total filesystem usage. On a mostly empty
  // filesystem this avoids walking/opening every cached thumbnail for each
  // received image, while retaining full eviction checks near the limit.
  const size_t totalBytes = LittleFS.totalBytes();
  const size_t usedBytes = LittleFS.usedBytes();
  size_t freeBytes = totalBytes > usedBytes ? totalBytes - usedBytes : 0;
  if (usedBytes + incomingBytes <= MAX_CACHE_BYTES &&
      freeBytes >= incomingBytes + MIN_FS_FREE_BYTES) return;

  std::vector<CacheEntry> entries;
  size_t cacheTotal = 0;

  File root = LittleFS.open("/cache");
  if (!root || !root.isDirectory()) return;

  File file = root.openNextFile();
  while (file) {
    if (!file.isDirectory()) {
      CacheEntry entry;
      entry.path = String(file.path());
      entry.size = file.size();
      entry.modified = file.getLastWrite();
      cacheTotal += entry.size;
      entries.push_back(entry);
    }
    file = root.openNextFile();
  }
  root.close();

  for (size_t i = 0; i < entries.size();) {
    const CacheEntry& entry = entries[i];
    if (isPairedCacheThumbnailPath(entry.path) &&
        !validLcdThumbnailFile(entry.path)) {
      if (LittleFS.remove(entry.path)) {
        cacheTotal = entry.size > cacheTotal ? 0 : cacheTotal - entry.size;
        freeBytes += entry.size;
        Serial.printf("[artwork] invalid lcd thumbnail evicted: %s (%u bytes)\n",
                      entry.path.c_str(),
                      static_cast<unsigned>(entry.size));
        entries.erase(entries.begin() + i);
        continue;
      }
    }
    ++i;
  }

  if (cacheTotal + incomingBytes <= MAX_CACHE_BYTES &&
      freeBytes >= incomingBytes + MIN_FS_FREE_BYTES) {
    return;
  }

  std::vector<CacheFamily> families;
  for (const CacheEntry& entry : entries) {
    String stem = cacheFamilyStemForPath(entry.path);
    CacheFamily* family = nullptr;
    for (CacheFamily& existing : families) {
      if (existing.stem == stem) {
        family = &existing;
        break;
      }
    }
    if (!family) {
      CacheFamily next;
      next.stem = stem;
      families.push_back(next);
      family = &families.back();
    }

    family->entries.push_back(entry);
    family->size += entry.size;
    if (family->modified == 0 || entry.modified < family->modified) {
      family->modified = entry.modified;
    }
  }

  std::sort(families.begin(), families.end(), [](const CacheFamily& a, const CacheFamily& b) {
    if (a.modified == b.modified) return a.stem < b.stem;
    return a.modified < b.modified;
  });

  const PlayerStateSnapshot current = PlayerState::instance().snapshot();
  for (const CacheFamily& family : families) {
    bool protectedFamily = false;
    for (const CacheEntry& entry : family.entries) {
      if (cacheKeepProtects(entry.path, keepPath) ||
          cacheKeepProtects(entry.path, current.cachedArtworkPath) ||
          cacheKeepProtects(entry.path, current.albumArtworkPath)) {
        protectedFamily = true;
        break;
      }
    }
    if (protectedFamily) continue;

    size_t removedBytes = 0;
    for (const CacheEntry& entry : family.entries) {
      if (!LittleFS.remove(entry.path)) continue;
      removedBytes += entry.size;
      Serial.printf("[artwork] cache evicted: %s (%u bytes)\n",
                    entry.path.c_str(),
                    static_cast<unsigned>(entry.size));
    }

    if (!removedBytes) continue;
    cacheTotal = removedBytes > cacheTotal ? 0 : cacheTotal - removedBytes;
    freeBytes += removedBytes;

    if (cacheTotal + incomingBytes <= TARGET_CACHE_BYTES &&
        freeBytes >= incomingBytes + MIN_FS_FREE_BYTES) {
      break;
    }
  }
}

String ArtworkCache::detectDownloadedExtension(const String& tempPath) const {
  File file = LittleFS.open(tempPath, "r");
  if (!file) return "";

  size_t fileSize = file.size();
  uint8_t header[12] = {0};
  size_t readLen = file.read(header, sizeof(header));

  uint8_t tail[16] = {0};
  size_t tailLen = 0;
  if (fileSize > 0) {
    size_t tailStart = fileSize > sizeof(tail) ? fileSize - sizeof(tail) : 0;
    file.seek(tailStart);
    tailLen = file.read(tail, sizeof(tail));
  }

  if (readLen >= 8 &&
      header[0] == 0x89 &&
      header[1] == 'P' &&
      header[2] == 'N' &&
      header[3] == 'G') {
    bool hasIend = false;
    for (size_t i = 0; i + 3 < tailLen; ++i) {
      if (tail[i] == 'I' && tail[i + 1] == 'E' && tail[i + 2] == 'N' && tail[i + 3] == 'D') {
        hasIend = true;
        break;
      }
    }
    file.close();
    if (hasIend) return ".png";
    Serial.println("[artwork] png missing IEND marker");
    return "";
  }

  if (readLen >= 3 &&
      header[0] == 0xFF &&
      header[1] == 0xD8 &&
      header[2] == 0xFF) {
    file.close();
    if (tailLen >= 2 && tail[tailLen - 2] == 0xFF && tail[tailLen - 1] == 0xD9) return ".jpg";
    Serial.println("[artwork] jpg missing EOI marker");
    return "";
  }

  if (readLen >= 2 && header[0] == 'B' && header[1] == 'M') {
    file.close();
    return ".bmp";
  }

  file.close();
  Serial.printf("[artwork] unsupported header: %02X %02X %02X %02X\n", header[0], header[1], header[2], header[3]);
  return "";
}

static bool readBe32(File& file, uint32_t& value) {
  uint8_t bytes[4] = {0};
  if (file.read(bytes, sizeof(bytes)) != sizeof(bytes)) return false;
  value = (static_cast<uint32_t>(bytes[0]) << 24) |
          (static_cast<uint32_t>(bytes[1]) << 16) |
          (static_cast<uint32_t>(bytes[2]) << 8) |
          static_cast<uint32_t>(bytes[3]);
  return true;
}

static uint16_t readLe16At(const uint8_t* data) {
  return static_cast<uint16_t>(data[0]) |
         (static_cast<uint16_t>(data[1]) << 8);
}

static uint32_t readLe32At(const uint8_t* data) {
  return static_cast<uint32_t>(data[0]) |
         (static_cast<uint32_t>(data[1]) << 8) |
         (static_cast<uint32_t>(data[2]) << 16) |
         (static_cast<uint32_t>(data[3]) << 24);
}

static int32_t readLe32SignedAt(const uint8_t* data) {
  return static_cast<int32_t>(readLe32At(data));
}

static void writeLe16(File& file, uint16_t value) {
  uint8_t bytes[2] = {
    static_cast<uint8_t>(value & 0xFF),
    static_cast<uint8_t>((value >> 8) & 0xFF)
  };
  file.write(bytes, sizeof(bytes));
}

static void writeLe32(File& file, uint32_t value) {
  uint8_t bytes[4] = {
    static_cast<uint8_t>(value & 0xFF),
    static_cast<uint8_t>((value >> 8) & 0xFF),
    static_cast<uint8_t>((value >> 16) & 0xFF),
    static_cast<uint8_t>((value >> 24) & 0xFF)
  };
  file.write(bytes, sizeof(bytes));
}

static uint16_t readBe16Value(File& file) {
  uint8_t bytes[2] = {0};
  if (file.read(bytes, sizeof(bytes)) != sizeof(bytes)) return 0;
  return (static_cast<uint16_t>(bytes[0]) << 8) | bytes[1];
}

static bool readPngImageSize(const String& path, ArtworkImageSize& size) {
  File file = LittleFS.open(path, "r");
  if (!file) return false;

  uint8_t signature[24] = {0};
  bool ok = file.read(signature, sizeof(signature)) == sizeof(signature) &&
            signature[0] == 0x89 &&
            signature[1] == 'P' &&
            signature[2] == 'N' &&
            signature[3] == 'G';

  if (ok) {
    uint32_t width = (static_cast<uint32_t>(signature[16]) << 24) |
                     (static_cast<uint32_t>(signature[17]) << 16) |
                     (static_cast<uint32_t>(signature[18]) << 8) |
                     signature[19];
    uint32_t height = (static_cast<uint32_t>(signature[20]) << 24) |
                      (static_cast<uint32_t>(signature[21]) << 16) |
                      (static_cast<uint32_t>(signature[22]) << 8) |
                      signature[23];

    if (width <= UINT16_MAX && height <= UINT16_MAX) {
      size.width = static_cast<uint16_t>(width);
      size.height = static_cast<uint16_t>(height);
    }
  }

  file.close();
  return ok && size.width && size.height;
}

static bool readJpgImageSize(const String& path, ArtworkImageSize& size) {
  File file = LittleFS.open(path, "r");
  if (!file) return false;

  if (readBe16Value(file) != 0xFFD8) {
    file.close();
    return false;
  }

  while (file.available()) {
    uint8_t markerPrefix = file.read();
    if (markerPrefix != 0xFF) continue;

    uint8_t marker = file.read();
    while (marker == 0xFF) marker = file.read();

    if (marker == 0xD9 || marker == 0xDA) break;

    uint16_t segmentLength = readBe16Value(file);
    if (segmentLength < 2) break;

    bool sof = (marker >= 0xC0 && marker <= 0xC3) ||
               (marker >= 0xC5 && marker <= 0xC7) ||
               (marker >= 0xC9 && marker <= 0xCB) ||
               (marker >= 0xCD && marker <= 0xCF);

    if (sof) {
      file.read();
      size.height = readBe16Value(file);
      size.width = readBe16Value(file);
      file.close();
      return size.width && size.height;
    }

    file.seek(file.position() + segmentLength - 2);
  }

  file.close();
  return false;
}

static bool readBmpImageSize(const String& path, ArtworkImageSize& size) {
  File file = LittleFS.open(path, "r");
  if (!file) return false;

  uint8_t header[26] = {0};
  bool ok = file.read(header, sizeof(header)) == sizeof(header) &&
            header[0] == 'B' &&
            header[1] == 'M';
  file.close();
  if (!ok) return false;

  int32_t width = static_cast<int32_t>(readLe32At(header + 18));
  int32_t height = static_cast<int32_t>(readLe32At(header + 22));
  if (height < 0) height = -height;

  if (width <= 0 || height <= 0 || width > UINT16_MAX || height > UINT16_MAX) return false;
  size.width = static_cast<uint16_t>(width);
  size.height = static_cast<uint16_t>(height);
  return true;
}

static bool readArtworkImageSize(const String& path, ArtworkImageSize& size) {
  String lower = path;
  lower.toLowerCase();
  if (lower.endsWith(".png")) return readPngImageSize(path, size);
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return readJpgImageSize(path, size);
  if (lower.endsWith(".bmp")) return readBmpImageSize(path, size);
  return false;
}

static bool artworkFileFingerprint(const String& path, uint64_t& fingerprint) {
  File file = LittleFS.open(path, "r");
  if (!file) return false;

  uint64_t hash = 14695981039346656037ULL;
  uint8_t buffer[2048];
  size_t total = 0;
  while (file.available()) {
    size_t read = file.read(buffer, sizeof(buffer));
    if (!read) break;
    total += read;
    for (size_t i = 0; i < read; ++i) {
      hash ^= buffer[i];
      hash *= 1099511628211ULL;
    }
    vTaskDelay(1);
  }
  file.close();
  if (!total) return false;

  fingerprint = hash;
  return true;
}

static uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b) {
  return (static_cast<uint16_t>(r & 0xF8) << 8) |
         (static_cast<uint16_t>(g & 0xFC) << 3) |
         (b >> 3);
}

static bool validLcdThumbnailFile(const String& path) {
  File file = LittleFS.open(path, "r");
  if (!file) return false;
  if (file.size() != LCD_THUMB_BYTES) {
    file.close();
    return false;
  }

  uint8_t header[8] = {0};
  bool ok = file.read(header, sizeof(header)) == sizeof(header) &&
            header[0] == 'S' &&
            header[1] == 'R' &&
            header[2] == '5' &&
            header[3] == '6' &&
            readLe16At(header + 4) == LCD_THUMB_SIZE &&
            readLe16At(header + 6) == LCD_THUMB_SIZE;
  file.close();
  return ok;
}

String ArtworkCache::lcdThumbnailPath(const String& imagePath, bool fillFrame) const {
  if (AlbumArtStore::isPath(imagePath)) return imagePath;
  if (!imagePath.length()) return "";
  String lower = imagePath;
  lower.toLowerCase();
  if (lower.endsWith(LCD_THUMB_EXT)) return imagePath;
  String sizedExt = "_" + String(LCD_THUMB_SIZE) + (fillFrame ? "_fill2" : "") + LCD_THUMB_EXT;
  if (imagePath.startsWith("/cache/")) return fileStem(imagePath) + sizedExt;
  return cachePath(String("lcd:") + String(LCD_THUMB_SIZE) + (fillFrame ? ":fill2:" : ":") + imagePath, LCD_THUMB_EXT);
}

void ArtworkCache::invalidateLcdThumbnail(const String& imagePath) {
  String localPath = imagePath;
  localPath.trim();
  if (!localPath.length() || isRemoteArtworkSource(localPath)) return;

  localPath = preferredLocalArtworkPath(localPath);
  String thumbPath = lcdThumbnailPath(localPath);
  if (!thumbPath.length() || thumbPath == localPath) return;

  clearThumbnailReady(localPath);
  if (lastThumbnailAttemptSource == localPath) {
    lastThumbnailAttemptSource = "";
    lastThumbnailAttemptMs = 0;
  }

  bool removed = false;
  if (LittleFS.exists(thumbPath)) {
    removed = LittleFS.remove(thumbPath) || removed;
  }
  String tempPath = thumbPath + ".tmp";
  if (LittleFS.exists(tempPath)) {
    removed = LittleFS.remove(tempPath) || removed;
  }

  if (removed) {
    Serial.printf("[artwork] lcd thumbnail invalidated: %s\n", localPath.c_str());
  }
}

bool ArtworkCache::ensureLcdThumbnail(const String& imagePath, bool fillFrame) {
  return ensureLcdThumbnailPrepared(imagePath, fillFrame, false);
}

bool ArtworkCache::ensureLcdThumbnailPrepared(const String& imagePath, bool fillFrame, bool cacheBudgetReserved) {
  if (AlbumArtStore::isPath(imagePath)) return static_cast<bool>(AlbumArtStore::instance().acquire(imagePath));
  ArtworkPhaseTrace totalPhase("lcd-total", fillFrame);
  const unsigned long validationStartedMs = millis();
  if (!imagePath.length() || imagePath.startsWith("http://") || imagePath.startsWith("https://")) return false;
  if (idlePrewarmCancellationRequested()) return false;

  String lower = imagePath;
  lower.toLowerCase();
  if (lower.endsWith(LCD_THUMB_EXT)) {
    if (thumbnailKnownReady(imagePath, imagePath)) return true;
    bool valid = validLcdThumbnailFile(imagePath);
    if (valid) markThumbnailReady(imagePath, imagePath);
    return valid;
  }
  if (!lower.endsWith(".png") && !lower.endsWith(".jpg") && !lower.endsWith(".jpeg") && !lower.endsWith(".bmp")) return false;

  String thumbPath = lcdThumbnailPath(imagePath, fillFrame);
  if (thumbnailKnownReady(imagePath, thumbPath)) return true;
  if (!LittleFS.exists(imagePath)) {
    clearThumbnailReady(imagePath);
    return false;
  }
  if (validLcdThumbnailFile(thumbPath)) {
    markThumbnailReady(imagePath, thumbPath);
    return true;
  }

  bool locked = false;
  if (thumbnailMutex) {
    if (xSemaphoreTake(thumbnailMutex, pdMS_TO_TICKS(25)) != pdTRUE) return false;
    locked = true;
  }
  auto unlock = [&]() {
    if (locked) {
      xSemaphoreGive(thumbnailMutex);
      locked = false;
    }
  };

  if (idlePrewarmCancellationRequested()) {
    unlock();
    return false;
  }

  if (thumbnailKnownReady(imagePath, thumbPath) || validLcdThumbnailFile(thumbPath)) {
    markThumbnailReady(imagePath, thumbPath);
    unlock();
    return true;
  }
  clearThumbnailReady(imagePath);
  if (!fillFrame && (lower.endsWith(".jpg") || lower.endsWith(".jpeg"))) {
    File source = LittleFS.open(imagePath, "r");
    if (source) {
      struct FileInput {
        File& file;
        size_t read(uint8_t* out, size_t length) { return file.read(out, length); }
        bool skip(size_t length) {
          const size_t position = file.position();
          return position <= file.size() && length <= file.size() - position && file.seek(position + length);
        }
      } input{source};
      const auto format = LcdImagePolicy::inspect(input);
      source.close();
      if (LcdImagePolicy::needsConversion(format)) {
        // Only retire a proven incompatible, generated cache file after ready
        // LCD pixels were already checked above. Never delete uploaded originals
        // or a source merely because decoding ran out of memory.
        const bool generatedCache = format == LcdImagePolicy::Jpeg::Unsupported &&
            lower.startsWith("/cache/art_") && lower.indexOf('/', 7) < 0;
        const bool retired = generatedCache && LittleFS.remove(imagePath);
        unlock();
        artworkTraceSerial.printf("[artwork] JPEG needs LCD conversion%s: %s\n",
            retired ? ", cached source retired for repair" : "", imagePath.c_str());
        return false;
      }
    }
  }
  if (LittleFS.exists(thumbPath)) LittleFS.remove(thumbPath);
  if (fillFrame) albumArtTrace("timing lcd-validate: %lums",
                              static_cast<unsigned long>(millis() - validationStartedMs));

  const bool guardSourceChanges = imagePath.startsWith("/logos/");
  uint64_t sourceFingerprint = 0;
  ArtworkImageSize size;
  {
    ArtworkPhaseTrace phase("lcd-source-info", fillFrame);
    if (guardSourceChanges && !artworkFileFingerprint(imagePath, sourceFingerprint)) {
      unlock();
      return false;
    }
    if (!readArtworkImageSize(imagePath, size)) {
      unlock();
      if (fillFrame) albumArtTrace("cannot read cover image dimensions: %s", imagePath.c_str());
      return false;
    }
  }

  if (idlePrewarmCancellationRequested()) {
    unlock();
    return false;
  }

  if (!cacheBudgetReserved) {
    ArtworkPhaseTrace phase("lcd-cache-reserve", fillFrame);
    enforceCacheBudget(LCD_THUMB_BYTES, imagePath);
  }

  if (idlePrewarmCancellationRequested()) {
    unlock();
    return false;
  }

  lgfx::LGFX_Sprite thumb;
  {
    ArtworkPhaseTrace phase("lcd-allocate", fillFrame);
    thumb.setPsram(true);
    thumb.setColorDepth(16);
    void* spriteBuffer = thumb.createSprite(LCD_THUMB_SIZE, LCD_THUMB_SIZE);
    if (!spriteBuffer) {
      unlock();
      Serial.printf("[artwork] lcd thumbnail sprite alloc failed: %s\n", imagePath.c_str());
      if (fillFrame) albumArtTrace("cannot allocate LCD cover thumbnail buffer");
      return false;
    }
    uint16_t matBg = rgb565(7, 9, 9);
    thumb.fillSprite(matBg);
  }

  float scale = fillFrame
                  ? max(static_cast<float>(LCD_THUMB_SIZE) / size.width,
                        static_cast<float>(LCD_THUMB_SIZE) / size.height)
                  : min(static_cast<float>(LCD_THUMB_SIZE) / size.width,
                        static_cast<float>(LCD_THUMB_SIZE) / size.height);
  // Center within a fixed viewport. Passing a negative destination origin
  // together with maxWidth/maxHeight also shrinks LovyanGFX's viewport and can
  // leave a strip empty. Its center datum crops using source offsets instead.

  unsigned long started = millis();
  bool drawn = false;
  {
    ArtworkPhaseTrace phase("lcd-decode", fillFrame);
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
      drawn = thumb.drawJpgFile(LittleFS, imagePath.c_str(), 0, 0, LCD_THUMB_SIZE, LCD_THUMB_SIZE, 0, 0, scale, scale, middle_center);
    } else if (lower.endsWith(".png")) {
      drawn = thumb.drawPngFile(LittleFS, imagePath.c_str(), 0, 0, LCD_THUMB_SIZE, LCD_THUMB_SIZE, 0, 0, scale, scale, middle_center);
      thumb.releasePngMemory();
    } else if (lower.endsWith(".bmp")) {
      drawn = thumb.drawBmpFile(LittleFS, imagePath.c_str(), 0, 0, LCD_THUMB_SIZE, LCD_THUMB_SIZE, 0, 0, scale, scale, middle_center);
    }
  }

  if (!drawn) {
    thumb.deleteSprite();
    unlock();
    Serial.printf("[artwork] lcd thumbnail draw failed: %s\n", imagePath.c_str());
    if (fillFrame) albumArtTrace("image decoder could not create cover thumbnail: %s", imagePath.c_str());
    return false;
  }

  if (idlePrewarmCancellationRequested()) {
    thumb.deleteSprite();
    unlock();
    return false;
  }

  String tempPath = thumbPath + ".tmp";
  bool ok = false;
  {
    ArtworkPhaseTrace phase("lcd-write", fillFrame);
    if (LittleFS.exists(tempPath)) LittleFS.remove(tempPath);
    File out = LittleFS.open(tempPath, "w");
    if (!out) {
      thumb.deleteSprite();
      unlock();
      Serial.printf("[artwork] lcd thumbnail temp open failed: %s\n", tempPath.c_str());
      return false;
    }
    const uint8_t header[8] = {
      'S', 'R', '5', '6',
      static_cast<uint8_t>(LCD_THUMB_SIZE & 0xFF),
      static_cast<uint8_t>((LCD_THUMB_SIZE >> 8) & 0xFF),
      static_cast<uint8_t>(LCD_THUMB_SIZE & 0xFF),
      static_cast<uint8_t>((LCD_THUMB_SIZE >> 8) & 0xFF)
    };
    const uint8_t* pixels = static_cast<const uint8_t*>(thumb.getBuffer());
    const size_t pixelBytes = static_cast<size_t>(LCD_THUMB_SIZE) * LCD_THUMB_SIZE * sizeof(uint16_t);
    ok = out.write(header, sizeof(header)) == sizeof(header) &&
         pixels && writeBufferYielding(out, pixels, pixelBytes);
    out.flush();
    out.close();
    thumb.deleteSprite();
  }

  if (idlePrewarmCancellationRequested()) {
    LittleFS.remove(tempPath);
    unlock();
    return false;
  }

  if (!ok) {
    LittleFS.remove(tempPath);
    unlock();
    Serial.printf("[artwork] lcd thumbnail write failed: %s\n", tempPath.c_str());
    return false;
  }

  {
    ArtworkPhaseTrace phase("lcd-commit", fillFrame);
    if (guardSourceChanges) {
      uint64_t currentFingerprint = 0;
      if (!artworkFileFingerprint(imagePath, currentFingerprint) || currentFingerprint != sourceFingerprint) {
        LittleFS.remove(tempPath);
        unlock();
        Serial.printf("[artwork] lcd thumbnail source changed, retrying: %s\n", imagePath.c_str());
        return false;
      }
    }
    if (LittleFS.exists(thumbPath)) LittleFS.remove(thumbPath);
    if (!LittleFS.rename(tempPath, thumbPath)) {
      LittleFS.remove(tempPath);
      unlock();
      Serial.printf("[artwork] lcd thumbnail rename failed: %s\n", thumbPath.c_str());
      return false;
    }
  }

  if (!cacheBudgetReserved) {
    ArtworkPhaseTrace phase("lcd-cache-final", fillFrame);
    enforceCacheBudget(0, thumbPath);
  }
  markThumbnailReady(imagePath, thumbPath);
  unlock();
  if (!fillFrame) artworkTraceSerial.printf("[artwork] LCD station logo ready: %s\n", thumbPath.c_str());
  Serial.printf("[artwork] lcd thumbnail cached: %s from %s %ux%u %.2fx %lums\n",
                thumbPath.c_str(),
                imagePath.c_str(),
                static_cast<unsigned>(size.width),
                static_cast<unsigned>(size.height),
                scale,
                millis() - started);
  return true;
}

static void* artworkAlloc(size_t size) {
  void* ptr = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!ptr) ptr = malloc(size);
  return ptr;
}

static bool isBase64PayloadByte(uint8_t c) {
  return isalnum(c) || c == '+' || c == '/' || c == '=';
}

bool ArtworkCache::finalizeImagePayload(const String& sourcePath, size_t offset, size_t length, const String& key, String& outPath) {
  if (!length || length > MAX_ARTWORK_BYTES) return false;
  enforceCacheBudget(length);

  File source = LittleFS.open(sourcePath, "r");
  if (!source) return false;

  size_t sourceSize = source.size();
  if (offset > sourceSize || length > sourceSize - offset) {
    source.close();
    return false;
  }

  String payloadPath = cachePath(key, ".payload");
  if (LittleFS.exists(payloadPath)) LittleFS.remove(payloadPath);

  File payload = LittleFS.open(payloadPath, "w");
  if (!payload) {
    source.close();
    return false;
  }

  if (!source.seek(offset)) {
    payload.close();
    source.close();
    LittleFS.remove(payloadPath);
    return false;
  }

  uint8_t buffer[1024];
  size_t remaining = length;
  while (remaining > 0) {
    size_t toRead = min(remaining, sizeof(buffer));
    int readLen = source.read(buffer, toRead);
    if (readLen <= 0) break;
    if (payload.write(buffer, readLen) != static_cast<size_t>(readLen)) break;
    remaining -= readLen;
  }

  payload.flush();
  payload.close();
  source.close();

  if (remaining != 0) {
    LittleFS.remove(payloadPath);
    return false;
  }

  String extension = detectDownloadedExtension(payloadPath);
  if (!extension.length()) {
    bool ok = extractIcoImage(payloadPath, key, outPath);
    LittleFS.remove(payloadPath);
    return ok;
  }

  String finalPath = cachePath(key, extension);
  if (LittleFS.exists(finalPath)) LittleFS.remove(finalPath);
  if (!LittleFS.rename(payloadPath, finalPath)) {
    LittleFS.remove(payloadPath);
    return false;
  }

  outPath = finalPath;
  const bool fillFrame = key.startsWith("embedded:") &&
                         AppConfig::instance().displayArtworkMode == "album";
  ensureLcdThumbnail(finalPath, fillFrame);
  enforceCacheBudget(0, finalPath);
  return true;
}

bool ArtworkCache::requestLcdThumbnail(const String& imagePath, bool idlePrewarm, bool fillFrame) {
  if (AlbumArtStore::isPath(imagePath)) return static_cast<bool>(AlbumArtStore::instance().acquire(imagePath));
  if (!imagePath.length() || imagePath.startsWith("http://") || imagePath.startsWith("https://")) return false;

  String lower = imagePath;
  lower.toLowerCase();
  if (lower.endsWith(LCD_THUMB_EXT)) {
    if (thumbnailKnownReady(imagePath, imagePath)) return true;
    bool valid = validLcdThumbnailFile(imagePath);
    if (valid) markThumbnailReady(imagePath, imagePath);
    return valid;
  }
  if (!lower.endsWith(".png") && !lower.endsWith(".jpg") && !lower.endsWith(".jpeg") && !lower.endsWith(".bmp")) return false;

  String thumbPath = lcdThumbnailPath(imagePath, fillFrame);
  if (thumbnailKnownReady(imagePath, thumbPath)) return true;
  if (!LittleFS.exists(imagePath)) {
    clearThumbnailReady(imagePath);
    return false;
  }
  if (validLcdThumbnailFile(thumbPath)) {
    markThumbnailReady(imagePath, thumbPath);
    return true;
  }
  if (isDownloadActive()) return false;
  unsigned long now = millis();
  String attemptSource = imagePath + (fillFrame ? ":fill" : "");
  if (lastThumbnailAttemptSource == attemptSource &&
      now - lastThumbnailAttemptMs < THUMBNAIL_RETRY_MS) {
    return false;
  }
  lastThumbnailAttemptSource = attemptSource;
  lastThumbnailAttemptMs = now;

  Serial.printf("[artwork] lcd thumbnail task start: %s\n", imagePath.c_str());
  return startThumbnailTask(imagePath, idlePrewarm, fillFrame);
}

bool ArtworkCache::lcdThumbnailReady(const String& imagePath, bool fillFrame) {
  if (AlbumArtStore::isPath(imagePath)) return static_cast<bool>(AlbumArtStore::instance().acquire(imagePath));
  if (!imagePath.length() || imagePath.startsWith("http://") || imagePath.startsWith("https://")) return false;
  String thumbPath = lcdThumbnailPath(imagePath, fillFrame);
  if (!thumbPath.length()) return false;
  if (thumbnailKnownReady(imagePath, thumbPath)) return true;
  static String lastProbeKey;
  static unsigned long lastProbeMs = 0;
  const String probeKey = imagePath + (fillFrame ? ":fill" : "");
  const unsigned long now = millis();
  if (lastProbeKey == probeKey && now - lastProbeMs < 250) return false;
  lastProbeKey = probeKey;
  lastProbeMs = now;
  if (!validLcdThumbnailFile(thumbPath)) return false;
  markThumbnailReady(imagePath, thumbPath);
  return true;
}

bool ArtworkCache::artworkExists(const String& imagePath) const {
  if (AlbumArtStore::isPath(imagePath)) return static_cast<bool>(AlbumArtStore::instance().acquire(imagePath));
  return imagePath.length() && LittleFS.exists(imagePath);
}

bool ArtworkCache::stationArtworkReady(int stationId, String* outPath) const {
  if (outPath) *outPath = "";
  if (stationId < 0) return false;

  Station station;
  if (!StationManager::instance().getStation(stationId, station)) return false;

  String logo = station.logo;
  logo.trim();
  if (!logo.length()) return true;

  String imagePath;
  if (isRemoteArtworkSource(logo)) {
    if (!findExistingLcdArtworkPath(logo, imagePath) &&
        !findExistingCachePath(logo, imagePath)) return false;
  } else {
    imagePath = preferredLocalArtworkPath(logo);
  }

  if (!supportedArtworkFile(imagePath) || !LittleFS.exists(imagePath)) return false;

  String lower = imagePath;
  lower.toLowerCase();
  if (lower.endsWith(LCD_THUMB_EXT)) {
    if (!validLcdThumbnailFile(imagePath)) return false;
    if (outPath) *outPath = imagePath;
    return true;
  }

  String thumbPath = lcdThumbnailPath(imagePath);
  if (!thumbnailKnownReady(imagePath, thumbPath) && !validLcdThumbnailFile(thumbPath)) {
    return false;
  }

  if (outPath) *outPath = imagePath;
  return true;
}

bool ArtworkCache::deferStationPlayback(int stationId) {
  if (stationId < 0) return false;

  Station station;
  if (!StationManager::instance().getStation(stationId, station)) return false;

  String logo = station.logo;
  logo.trim();
  if (!logo.length()) return false;

  String readyPath;
  if (stationArtworkReady(stationId, &readyPath)) return false;

  const String activeLogo = activeDownloadLabel();
  if (isRemoteArtworkSource(activeLogo) && activeLogo != logo) cancelIdlePrewarm();
  requestPrewarm(logo, true);

  if (pendingMutex && xSemaphoreTake(pendingMutex, pdMS_TO_TICKS(20)) != pdTRUE) {
    return false;
  }

  pendingPlaybackStationId = stationId;
  pendingPlaybackStartedMs = millis();

  if (pendingMutex) xSemaphoreGive(pendingMutex);
  Serial.printf("[artwork] playback deferred for station %d until artwork is ready\n", stationId);
  return true;
}

void ArtworkCache::cancelPendingPlayback() {
  if (pendingMutex && xSemaphoreTake(pendingMutex, pdMS_TO_TICKS(20)) != pdTRUE) return;

  pendingPlaybackStationId = -1;
  pendingPlaybackStartedMs = 0;

  if (pendingMutex) xSemaphoreGive(pendingMutex);
}

bool ArtworkCache::prepareStationForPlayback(int stationId, String& outPath, uint32_t budgetMs) {
  (void)budgetMs;
  outPath = "";
  if (stationId < 0) return false;

  if (stationArtworkReady(stationId, &outPath)) return true;
  deferStationPlayback(stationId);
  return false;
}

void ArtworkCache::processPendingPlayback(const PlayerStateSnapshot& state) {
  int stationId = -1;
  unsigned long startedMs = 0;

  if (pendingMutex && xSemaphoreTake(pendingMutex, 0) == pdTRUE) {
    stationId = pendingPlaybackStationId;
    startedMs = pendingPlaybackStartedMs;
    xSemaphoreGive(pendingMutex);
  } else if (!pendingMutex) {
    stationId = pendingPlaybackStationId;
    startedMs = pendingPlaybackStartedMs;
  }

  if (stationId < 0) return;
  if (state.playing || state.stationId != stationId) {
    cancelPendingPlayback();
    return;
  }

  String artworkPath;
  bool ready = stationArtworkReady(stationId, &artworkPath);
  bool timedOut = startedMs > 0 && millis() - startedMs >= PENDING_PLAYBACK_TIMEOUT_MS;
  if (!ready && !timedOut) return;

  cancelPendingPlayback();

  PlayerStateSnapshot current = PlayerState::instance().snapshot();
  if (current.playing || current.stationId != stationId) return;

  if (ready && artworkPath.length() && current.cachedArtworkPath != artworkPath) {
    PlayerState::instance().setCachedArtworkPath(artworkPath);
  }

  JsonDocument cmd;
  cmd["play"] = true;
  if (PlayerState::instance().applyCommand(cmd)) {
    requestStateSave();
    Serial.printf("[artwork] playback resumed for station %d%s\n",
                  stationId,
                  ready ? " with artwork" : " without artwork after timeout");
    Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
  }
}

bool ArtworkCache::waitForActiveArtworkJob(const String& source, String& outPath, uint32_t budgetMs) {
  outPath = "";
  if (!source.length() || budgetMs < 250) return false;

  String labels[3] = {
    source,
    String("prepare:") + source,
    String("thumb:") + source
  };

  String activeLabel = activeDownloadLabel();
  bool matching = false;
  for (const String& label : labels) {
    if (activeLabel == label) {
      matching = true;
      break;
    }
  }
  if (!matching) return false;

  const uint32_t deadlineMs = millis() + budgetMs;
  while (!deadlineReached(deadlineMs)) {
    String existingPath;
    if (isRemoteArtworkSource(source)) {
      if (findExistingLcdArtworkPath(source, existingPath)) {
        outPath = existingPath;
        return true;
      }
      if (findExistingCachePath(source, existingPath) && ensureLcdThumbnail(existingPath)) {
        outPath = existingPath;
        return true;
      }
    } else if (LittleFS.exists(source) && ensureLcdThumbnail(source)) {
      outPath = source;
      return true;
    }

    if (!isDownloadActive()) break;
    activeLabel = activeDownloadLabel();
    matching = false;
    for (const String& label : labels) {
      if (activeLabel == label) {
        matching = true;
        break;
      }
    }
    if (!matching) return false;
    vTaskDelay(pdMS_TO_TICKS(25));
  }

  String existingPath;
  if (isRemoteArtworkSource(source)) {
    if (findExistingLcdArtworkPath(source, existingPath)) {
      outPath = existingPath;
      return true;
    }
    if (findExistingCachePath(source, existingPath) && ensureLcdThumbnail(existingPath)) {
      outPath = existingPath;
      return true;
    }
  } else if (LittleFS.exists(source) && ensureLcdThumbnail(source)) {
    outPath = source;
    return true;
  }

  return false;
}

bool ArtworkCache::prepareArtworkSourceForPlayback(const String& source, String& outPath, uint32_t budgetMs) {
  outPath = "";
  String item = source;
  item.trim();
  if (!item.length()) return true;

  if (!isRemoteArtworkSource(item)) {
    String localPath = preferredLocalArtworkPath(item);
    if (!supportedArtworkFile(localPath) || !LittleFS.exists(localPath)) return false;
    if (ensureLcdThumbnail(localPath)) {
      outPath = localPath;
      return true;
    }
    waitForActiveArtworkJob(localPath, outPath, min<uint32_t>(budgetMs, 2500));
    if (outPath.length()) return true;
    requestPrewarm(localPath, true);
    return false;
  }

  String existingPath;
  if (findExistingLcdArtworkPath(item, existingPath)) {
    outPath = existingPath;
    return true;
  }
  if (findExistingCachePath(item, existingPath)) {
    if (ensureLcdThumbnail(existingPath)) {
      outPath = existingPath;
      return true;
    }
    waitForActiveArtworkJob(existingPath, outPath, min<uint32_t>(budgetMs, 2500));
    if (outPath.length()) return true;
    requestPrewarm(existingPath, true);
    return false;
  }

  if (!WiFi.isConnected() || budgetMs < 1000) {
    requestPrewarm(item, true);
    return false;
  }

  if (isDownloadActive()) {
    if (waitForActiveArtworkJob(item, outPath, budgetMs)) return true;
    requestPrewarm(item, true);
    return false;
  }

  unsigned long started = millis();
  if (!markDownloadStarted(String("prepare:") + item)) {
    requestPrewarm(item, true);
    return false;
  }

  String downloadedPath;
  bool ok = download(item, downloadedPath, budgetMs);
  markDownloadFinished();
  lastUrl = item;
  lastAttemptMs = millis();

  if (ok && downloadedPath.length()) {
    outPath = downloadedPath;
    Serial.printf("[artwork] prepared before playback: %s in %lums\n",
                  downloadedPath.c_str(),
                  static_cast<unsigned long>(millis() - started));
    return true;
  }

  requestPrewarm(item, true);
  return false;
}

bool ArtworkCache::stateUsesArtworkPath(const PlayerStateSnapshot& state, const String& imagePath) const {
  if (!imagePath.length() || !imagePath.startsWith("/")) return false;
  if (state.cachedArtworkPath == imagePath) return true;
  if (state.albumArtworkPath == imagePath) return true;

  if (state.stationLogo.length() && !isRemoteArtworkSource(state.stationLogo)) {
    if (preferredLocalArtworkPath(state.stationLogo) == imagePath) return true;
  }

  String existingPath;
  if (state.embeddedArtworkKey.length() &&
      findExistingCachePath(state.embeddedArtworkKey, existingPath) &&
      existingPath == imagePath) {
    return true;
  }
  if (isRemoteArtworkSource(state.streamLogoUrl) &&
      (findExistingLcdArtworkPath(state.streamLogoUrl, existingPath) ||
       findExistingCachePath(state.streamLogoUrl, existingPath)) &&
      existingPath == imagePath) {
    return true;
  }
  if (isRemoteArtworkSource(state.stationLogo) &&
      (findExistingLcdArtworkPath(state.stationLogo, existingPath) ||
       findExistingCachePath(state.stationLogo, existingPath)) &&
      existingPath == imagePath) {
    return true;
  }

  return false;
}

bool ArtworkCache::refreshArtworkIfThumbnailReady(const String& imagePath, const PlayerStateSnapshot& state, bool fillFrame) {
  if (!stateUsesArtworkPath(state, imagePath)) return false;

  String thumbPath = lcdThumbnailPath(imagePath, fillFrame);
  if (!thumbPath.length()) return false;
  if (AlbumArtStore::isPath(imagePath)) {
    if (!lcdThumbnailReady(imagePath, fillFrame)) return false;
  } else if (!thumbnailKnownReady(imagePath, thumbPath)) {
    if (!validLcdThumbnailFile(thumbPath)) return false;
    markThumbnailReady(imagePath, thumbPath);
  }

  String refreshKey = imagePath + (fillFrame ? ":fill" : "");
  if (lastArtworkRefreshPath != refreshKey) {
    lastArtworkRefreshPath = refreshKey;
    Serial.printf("[artwork] lcd thumbnail ready, refreshing display: %s\n", imagePath.c_str());
    if (AppConfig::instance().displayArtworkMode == "album" && state.playing) {
      // Rebuild the model so it can switch from the station-logo fallback to
      // album art only after the fill-cropped LCD thumbnail is valid.
      Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
    } else {
      Display::instance().refreshArtwork();
    }
  }
  return true;
}

bool ArtworkCache::writeBmpFromIcoDib(const String& sourcePath, size_t offset, size_t length, const String& key, String& outPath) {
  if (length < 40 || length > MAX_ARTWORK_BYTES) return false;
  enforceCacheBudget(length + 14);

  File source = LittleFS.open(sourcePath, "r");
  if (!source) return false;
  size_t sourceSize = source.size();
  if (offset > sourceSize || length > sourceSize - offset || !source.seek(offset)) {
    source.close();
    return false;
  }

  uint8_t* dib = static_cast<uint8_t*>(artworkAlloc(length));
  if (!dib) {
    source.close();
    return false;
  }

  size_t readLen = source.read(dib, length);
  source.close();
  if (readLen != length) {
    free(dib);
    return false;
  }

  uint32_t headerSize = readLe32At(dib);
  if (headerSize < 40 || headerSize > length) {
    free(dib);
    return false;
  }

  int32_t widthSigned = readLe32SignedAt(dib + 4);
  int32_t heightSigned = readLe32SignedAt(dib + 8);
  uint16_t planes = readLe16At(dib + 12);
  uint16_t bitCount = readLe16At(dib + 14);
  uint32_t compression = readLe32At(dib + 16);
  uint32_t colorsUsed = headerSize >= 40 ? readLe32At(dib + 32) : 0;

  if (widthSigned <= 0 || heightSigned == 0 || planes != 1 ||
      !(bitCount == 1 || bitCount == 4 || bitCount == 8 || bitCount == 16 || bitCount == 24 || bitCount == 32) ||
      compression > 3) {
    free(dib);
    return false;
  }

  uint32_t width = static_cast<uint32_t>(widthSigned);
  uint32_t dibHeightAbs = heightSigned < 0 ? static_cast<uint32_t>(-heightSigned) : static_cast<uint32_t>(heightSigned);
  uint32_t imageHeight = dibHeightAbs;
  if (imageHeight >= 2) {
    imageHeight /= 2;
  }
  if (imageHeight == 0 || width > 512 || imageHeight > 512) {
    free(dib);
    return false;
  }

  uint32_t paletteEntries = 0;
  if (bitCount <= 8) {
    paletteEntries = colorsUsed ? colorsUsed : (1UL << bitCount);
  }
  uint32_t paletteBytes = paletteEntries * 4;
  if (headerSize + paletteBytes > length) {
    free(dib);
    return false;
  }

  uint32_t rowBytes = ((width * bitCount + 31) / 32) * 4;
  uint32_t pixelBytes = rowBytes * imageHeight;
  uint32_t payloadBytes = headerSize + paletteBytes + pixelBytes;
  if (payloadBytes > length || payloadBytes < headerSize) {
    free(dib);
    return false;
  }

  uint32_t patchedHeight = heightSigned < 0
                             ? static_cast<uint32_t>(-static_cast<int32_t>(imageHeight))
                             : imageHeight;
  dib[8] = static_cast<uint8_t>(patchedHeight & 0xFF);
  dib[9] = static_cast<uint8_t>((patchedHeight >> 8) & 0xFF);
  dib[10] = static_cast<uint8_t>((patchedHeight >> 16) & 0xFF);
  dib[11] = static_cast<uint8_t>((patchedHeight >> 24) & 0xFF);

  String bmpPath = cachePath(key, ".bmp");
  if (LittleFS.exists(bmpPath)) LittleFS.remove(bmpPath);

  File out = LittleFS.open(bmpPath, "w");
  if (!out) {
    free(dib);
    return false;
  }

  uint32_t bmpSize = 14 + payloadBytes;
  uint32_t pixelOffset = 14 + headerSize + paletteBytes;
  out.write(static_cast<uint8_t>('B'));
  out.write(static_cast<uint8_t>('M'));
  writeLe32(out, bmpSize);
  writeLe16(out, 0);
  writeLe16(out, 0);
  writeLe32(out, pixelOffset);

  bool ok = out.write(dib, payloadBytes) == payloadBytes;
  out.flush();
  out.close();
  free(dib);

  if (!ok) {
    LittleFS.remove(bmpPath);
    return false;
  }

  outPath = bmpPath;
  ensureLcdThumbnail(bmpPath);
  enforceCacheBudget(0, bmpPath);
  Serial.printf("[artwork] ico dib cached as bmp: %s %ux%u %ubpp\n",
                bmpPath.c_str(),
                static_cast<unsigned>(width),
                static_cast<unsigned>(imageHeight),
                static_cast<unsigned>(bitCount));
  return true;
}

bool ArtworkCache::extractIcoImage(const String& sourcePath, const String& key, String& outPath) {
  File file = LittleFS.open(sourcePath, "r");
  if (!file) return false;

  size_t sourceSize = file.size();
  uint8_t header[6] = {0};
  if (sourceSize < sizeof(header) || file.read(header, sizeof(header)) != sizeof(header)) {
    file.close();
    return false;
  }

  uint16_t reserved = readLe16At(header);
  uint16_t type = readLe16At(header + 2);
  uint16_t count = readLe16At(header + 4);
  if (reserved != 0 || type != 1 || count == 0 || count > 32 ||
      sourceSize < 6 + static_cast<size_t>(count) * 16) {
    file.close();
    return false;
  }

  std::vector<IcoEntry> entries;
  entries.reserve(count);
  for (uint16_t i = 0; i < count; ++i) {
    uint8_t dir[16] = {0};
    if (file.read(dir, sizeof(dir)) != sizeof(dir)) {
      file.close();
      return false;
    }

    IcoEntry entry;
    entry.width = dir[0] == 0 ? 256 : dir[0];
    entry.height = dir[1] == 0 ? 256 : dir[1];
    entry.bitCount = readLe16At(dir + 6);
    entry.bytes = readLe32At(dir + 8);
    entry.offset = readLe32At(dir + 12);

    if (!entry.bytes || entry.bytes > MAX_ARTWORK_BYTES ||
        entry.offset > sourceSize || entry.bytes > sourceSize - entry.offset) {
      continue;
    }

    uint8_t sig[8] = {0};
    if (file.seek(entry.offset) && file.read(sig, sizeof(sig)) == sizeof(sig)) {
      entry.compressed = (sig[0] == 0x89 && sig[1] == 'P' && sig[2] == 'N' && sig[3] == 'G') ||
                         (sig[0] == 0xFF && sig[1] == 0xD8 && sig[2] == 0xFF);
    }
    file.seek(6 + static_cast<size_t>(i + 1) * 16);
    entries.push_back(entry);
  }
  file.close();

  if (entries.empty()) return false;

  auto betterEntry = [](const IcoEntry& candidate, const IcoEntry& current) {
    auto score = [](const IcoEntry& entry) -> int32_t {
      int32_t longest = max<int32_t>(entry.width, entry.height);
      int32_t targetPenalty = longest <= 192 ? 192 - longest : (longest - 192) * 3;
      int32_t bitBonus = min<int32_t>(entry.bitCount, 32);
      return 10000 - targetPenalty + bitBonus;
    };
    return score(candidate) > score(current);
  };

  bool hasCompressed = false;
  IcoEntry bestCompressed;
  for (const IcoEntry& entry : entries) {
    if (!entry.compressed) continue;
    if (!hasCompressed || betterEntry(entry, bestCompressed)) {
      bestCompressed = entry;
      hasCompressed = true;
    }
  }

  if (hasCompressed &&
      finalizeImagePayload(sourcePath, bestCompressed.offset, bestCompressed.bytes, key, outPath)) {
    Serial.printf("[artwork] ico compressed payload extracted: %s\n", outPath.c_str());
    return true;
  }

  bool hasDib = false;
  IcoEntry bestDib;
  for (const IcoEntry& entry : entries) {
    if (entry.compressed || entry.bytes < 40) continue;
    if (!hasDib || betterEntry(entry, bestDib)) {
      bestDib = entry;
      hasDib = true;
    }
  }

  if (hasDib) {
    return writeBmpFromIcoDib(sourcePath, bestDib.offset, bestDib.bytes, key, outPath);
  }

  return false;
}

bool ArtworkCache::decodeBase64File(const String& sourcePath, const String& decodedPath) {
  File source = LittleFS.open(sourcePath, "r");
  if (!source) return false;

  size_t sourceSize = source.size();
  if (sourceSize < 16 || sourceSize > MAX_ARTWORK_BYTES) {
    source.close();
    return false;
  }

  uint8_t* encoded = static_cast<uint8_t*>(artworkAlloc(sourceSize + 1));
  if (!encoded) {
    source.close();
    return false;
  }

  size_t readLen = source.read(encoded, sourceSize);
  source.close();
  if (readLen != sourceSize) {
    free(encoded);
    return false;
  }

  size_t filteredLen = 0;
  for (size_t i = 0; i < sourceSize; ++i) {
    uint8_t c = encoded[i];
    if (isBase64PayloadByte(c)) {
      encoded[filteredLen++] = c;
    } else if (c == '\r' || c == '\n' || c == ' ' || c == '\t') {
      continue;
    } else {
      free(encoded);
      return false;
    }
  }

  if (filteredLen < 16) {
    free(encoded);
    return false;
  }

  size_t decodedLen = 0;
  int rc = mbedtls_base64_decode(nullptr, 0, &decodedLen, encoded, filteredLen);
  if (rc != MBEDTLS_ERR_BASE64_BUFFER_TOO_SMALL || decodedLen == 0 || decodedLen > MAX_ARTWORK_BYTES) {
    free(encoded);
    return false;
  }

  uint8_t* decoded = static_cast<uint8_t*>(artworkAlloc(decodedLen));
  if (!decoded) {
    free(encoded);
    return false;
  }

  size_t actualLen = 0;
  rc = mbedtls_base64_decode(decoded, decodedLen, &actualLen, encoded, filteredLen);
  free(encoded);
  if (rc != 0 || actualLen == 0 || actualLen > MAX_ARTWORK_BYTES) {
    free(decoded);
    return false;
  }

  if (LittleFS.exists(decodedPath)) LittleFS.remove(decodedPath);
  File out = LittleFS.open(decodedPath, "w");
  if (!out) {
    free(decoded);
    return false;
  }

  bool ok = out.write(decoded, actualLen) == actualLen;
  out.flush();
  out.close();
  free(decoded);
  if (!ok) {
    LittleFS.remove(decodedPath);
    return false;
  }

  return true;
}

bool ArtworkCache::normalizeEmbeddedImage(const String& tempPath, const String& key, String& outPath) {
  File file = LittleFS.open(tempPath, "r");
  if (!file) return false;
  size_t size = file.size();
  file.close();

  if (finalizeImagePayload(tempPath, 0, size, key, outPath)) return true;

  file = LittleFS.open(tempPath, "r");
  if (!file) return false;

  uint32_t pictureType = 0;
  uint32_t mimeLen = 0;
  bool parsedFlacPicture = false;
  if (readBe32(file, pictureType) &&
      readBe32(file, mimeLen) &&
      pictureType <= 20 &&
      mimeLen > 4 &&
      mimeLen < 80 &&
      file.position() + mimeLen < size) {
    if (file.seek(file.position() + mimeLen)) {
      uint32_t descLen = 0;
      if (readBe32(file, descLen) && descLen < 4096 && file.position() + descLen + 20 <= size) {
        file.seek(file.position() + descLen + 16);
        uint32_t dataLen = 0;
        if (readBe32(file, dataLen)) {
          size_t dataPos = file.position();
          if (dataLen > 0 && dataLen <= MAX_ARTWORK_BYTES && dataPos + dataLen <= size) {
            parsedFlacPicture = true;
            file.close();
            if (finalizeImagePayload(tempPath, dataPos, dataLen, key, outPath)) return true;
          }
        }
      }
    }
  }
  if (file) file.close();

  file = LittleFS.open(tempPath, "r");
  if (!file) return false;

  int encoding = file.read();
  bool parsedApic = false;
  if (encoding >= 0 && size > 16) {
    String mime;
    while (file.available() && mime.length() < 80) {
      int c = file.read();
      if (c <= 0) break;
      mime += static_cast<char>(c);
    }
    if (mime.startsWith("image/") && file.available()) {
      file.read();
      size_t guard = 0;
      if (encoding == 1 || encoding == 2) {
        int prev = -1;
        while (file.available() && guard++ < 1024) {
          int c = file.read();
          if (prev == 0 && c == 0) break;
          prev = c;
        }
      } else {
        while (file.available() && guard++ < 1024) {
          if (file.read() == 0) break;
        }
      }
      size_t dataPos = file.position();
      if (dataPos < size) {
        parsedApic = true;
        file.close();
        if (finalizeImagePayload(tempPath, dataPos, size - dataPos, key, outPath)) return true;
      }
    }
  }
  if (file) file.close();

  String decodedPath = cachePath(key, ".decoded");
  if (decodeBase64File(tempPath, decodedPath)) {
    bool ok = normalizeEmbeddedImage(decodedPath, key, outPath);
    LittleFS.remove(decodedPath);
    if (ok) return true;
  }

  if (!parsedFlacPicture && !parsedApic) {
    Serial.println("[artwork] embedded image parser did not find a PNG/JPG payload");
  }
  return false;
}

bool ArtworkCache::appendHttpRange(const String& url, uint32_t offset, uint32_t length, File& outFile,
                                  const String& expectedKey) {
  if (!length || length > MAX_ARTWORK_BYTES) return false;
  ArtworkHttp::Options options;
  options.range = "bytes=" + String(offset) + "-" + String(offset + length - 1);
  options.cancelled = [&]() {
    PlayerStateSnapshot current = PlayerState::instance().snapshot();
    return !current.playing || !audioConnectionReady || current.embeddedArtworkKey != expectedKey;
  };
  ArtworkHttp::Response response;
  if (!ArtworkHttp::get(url, length, response, options) || response.size != length) {
    albumArtTrace("embedded range failed: %s (%u/%u bytes)", response.error.c_str(),
                  static_cast<unsigned>(response.size), static_cast<unsigned>(length));
    return false;
  }
  return writeBufferYielding(outFile, response.data, response.size);
}

bool ArtworkCache::downloadEmbedded(const String& url, const std::vector<uint32_t>& segments, const String& key, String& outPath) {
  if ((!url.startsWith("http://") && !url.startsWith("https://")) ||
      !key.length() ||
      segments.size() < 2 ||
      (segments.size() % 2) != 0 ||
      segments.size() / 2 > MAX_EMBEDDED_SEGMENTS) {
    return false;
  }

  size_t total = 0;
  for (size_t i = 0; i + 1 < segments.size(); i += 2) {
    total += segments[i + 1];
    if (total > MAX_ARTWORK_BYTES) return false;
  }
  enforceCacheBudget(total);

  String tempPath = cachePath(key, ".emb");
  if (LittleFS.exists(tempPath)) LittleFS.remove(tempPath);

  File temp = LittleFS.open(tempPath, "w");
  if (!temp) return false;

  for (size_t i = 0; i + 1 < segments.size(); i += 2) {
    if (!appendHttpRange(url, segments[i], segments[i + 1], temp, key)) {
      temp.close();
      LittleFS.remove(tempPath);
      return false;
    }
  }

  temp.flush();
  temp.close();

  bool ok = normalizeEmbeddedImage(tempPath, key, outPath);
  LittleFS.remove(tempPath);
  if (ok) enforceCacheBudget(0, outPath);
  return ok;
}

bool ArtworkCache::importLocalImage(const String& url, const String& tempPath, String& outPath) {
  if ((!url.startsWith("http://") && !url.startsWith("https://")) ||
      !tempPath.startsWith("/cache/")) {
    return false;
  }

  String existingPath;
  if (findExistingLcdArtworkPath(url, existingPath)) {
    if (LittleFS.exists(tempPath)) LittleFS.remove(tempPath);
    outPath = existingPath;
    noteDownloadStatus(String("browser cache skipped, lcd cache ready ") + existingPath);
    Serial.printf("[artwork] browser cache import skipped after task start, lcd cache ready: %s\n",
                  existingPath.c_str());
    return true;
  }

  if (!LittleFS.exists(tempPath)) return false;

  File file = LittleFS.open(tempPath, "r");
  if (!file) return false;
  size_t size = file.size();
  file.close();

  if (size == 0 || size > MAX_ARTWORK_BYTES) {
    LittleFS.remove(tempPath);
    noteDownloadStatus(String("browser cache invalid size ") + String(static_cast<unsigned>(size)));
    return false;
  }

  enforceCacheBudget(size);

  String extension = detectDownloadedExtension(tempPath);
  if (!extension.length()) {
    if (extractIcoImage(tempPath, url, outPath)) {
      LittleFS.remove(tempPath);
      String compactedPath;
      compactRemoteArtwork(url, outPath, compactedPath);
      outPath = compactedPath;
      enforceCacheBudget(0, outPath);
      noteDownloadStatus(String("browser cached ico payload ") + outPath);
      return true;
    }
    LittleFS.remove(tempPath);
    noteDownloadStatus(String("browser cache unsupported payload ") + String(static_cast<unsigned>(size)));
    return false;
  }

  String path = cachePath(url, extension);
  if (LittleFS.exists(path)) {
    LittleFS.remove(path);
  }

  if (!LittleFS.rename(tempPath, path)) {
    LittleFS.remove(tempPath);
    noteDownloadStatus(String("browser cache rename failed ") + path);
    return false;
  }

  outPath = path;
  if (ensureLcdThumbnail(path)) compactRemoteArtwork(url, path, outPath);
  enforceCacheBudget(0, outPath);
  noteDownloadStatus(String("browser cached ") + outPath);
  return true;
}

static std::vector<String> resolveCoverArchiveServers(const String& url,
                                                     const ArtworkHttp::Options& options) {
  ArtworkPhaseTrace totalPhase("CAA-resolve-total");
  std::vector<String> urls;
  ArtworkHttp::Options redirectOptions = options;
  redirectOptions.followRedirects = false;
  ArtworkHttp::Response redirect;
  bool redirectOk = false;
  {
    ArtworkPhaseTrace phase("CAA-redirect");
    redirectOk = ArtworkHttp::get(ArtworkHttp::publicImageUrl(url), MAX_ARTWORK_BYTES, redirect, redirectOptions);
  }
  if (!redirectOk) {
    albumArtTrace("CAA redirect failed: %s", redirect.error.c_str());
    return urls;
  }
  const String location = redirect.location;
  const String server = ArtworkHttp::host(location);
  const int marker = location.indexOf("/download/");
  const int itemStart = marker + 10;
  const int itemEnd = location.indexOf('/', itemStart);
  if ((server != "archive.org" && !server.endsWith(".archive.org")) || marker < 0 || itemEnd <= itemStart) {
    albumArtTrace("CAA has no archive redirect: HTTP %d", redirect.status);
    return urls;
  }
  const String item = location.substring(itemStart, itemEnd);
  const String filename = location.substring(itemEnd + 1);
  if (!item.startsWith("mbid-") || !filename.length()) return urls;

  ArtworkHttp::Response metadata;
  {
    ArtworkPhaseTrace phase("CAA-metadata");
    if (ArtworkHttp::get("http://archive.org/metadata/" + item, ArtworkHttpPolicy::MAX_METADATA_BYTES, metadata, options)) {
      ArtworkJson::Allocator jsonAllocator;
      JsonDocument doc(&jsonAllocator);
      JsonDocument filter(&jsonAllocator);
      filter["dir"] = true;
      filter["d1"] = true;
      filter["d2"] = true;
      if (!filter.overflowed() && deserializeJson(doc, static_cast<const uint8_t*>(metadata.data), metadata.size,
                                                 DeserializationOption::Filter(filter)) == DeserializationError::Ok) {
        const String directory = doc["dir"] | "";
        if (directory.startsWith("/")) {
          for (const char* field : {"d1", "d2"}) {
            String fileServer = doc[field] | "";
            if (fileServer.endsWith(".archive.org") && fileServer.indexOf('/') < 0) {
              addUniqueArtworkCandidate(urls, "http://" + fileServer + directory + "/" + filename);
            }
          }
        }
      }
    } else {
      albumArtTrace("Archive metadata failed: %s", metadata.error.c_str());
    }
  }
  // Metadata occasionally fails even though the redirected file is available.
  // Retain the public download URL behind the two direct archive mirrors.
  if (urls.empty()) addUniqueArtworkCandidate(urls, ArtworkHttp::publicImageUrl(location));
  albumArtTrace("CAA resolved %u archive file server(s)", static_cast<unsigned>(urls.size()));
  return urls;
}

bool ArtworkCache::prepareAlbumMemory(uint8_t*& data, size_t length, const String& key, String& outPath, bool& unavailable) {
  ArtworkPhaseTrace totalPhase("RAM-prepare-total");
  const AlbumArtPolicy::ImageInfo info = AlbumArtPolicy::inspect(data, length);
  if (!info.valid()) {
    noteDownloadStatus("unsupported/oversized RAM cover image");
    return false;
  }
  auto stillCurrent = [&]() {
    const auto current = PlayerState::instance().snapshot();
    return !idlePrewarmCancellationRequested() && current.playing &&
           key == String(ALBUM_ART_CACHE_PREFIX) + current.artist + "|" + current.title;
  };
  if (!stillCurrent()) { noteDownloadStatus("stale artwork cancelled"); return false; }
  AlbumArtStore::Preparation frame;
  AlbumArtStore::ReserveStatus reserveStatus;
  {
    ArtworkPhaseTrace phase("RAM-reserve");
    const uint32_t retryUntil = millis() + 250;
    do {
      frame = AlbumArtStore::instance().reserve(key, LCD_THUMB_SIZE, info.format, &reserveStatus);
      if (frame || reserveStatus.failure != AlbumArtStore::ReserveFailure::SlotsBusy ||
          !stillCurrent() || deadlineReached(retryUntil)) break;
      vTaskDelay(pdMS_TO_TICKS(25)); // Let a finishing web response release its lease; retain the downloaded bytes.
    } while (true);
  }
  if (!frame && !stillCurrent()) { noteDownloadStatus("stale artwork cancelled"); return false; }
  if (!frame) {
    // A PNG may need more internal scratch than a JPEG from the next source.
    // Keep that candidate-specific failure from stopping the whole search.
    unavailable = reserveStatus.failure != AlbumArtStore::ReserveFailure::InternalLow ||
                  info.format == AlbumArtPolicy::Format::Jpeg;
    albumArtTrace("RAM reserve failed: %s; internal=%u largest=%u need=%u; PSRAM=%u largest=%u; slots=%ld,%ld published=%d",
                  AlbumArtStore::failureName(reserveStatus.failure),
                  static_cast<unsigned>(reserveStatus.internalFree), static_cast<unsigned>(reserveStatus.internalLargest),
                  static_cast<unsigned>(AlbumArtPolicy::internalHeadroom(info.format)),
                  static_cast<unsigned>(reserveStatus.psramFree), static_cast<unsigned>(reserveStatus.psramLargest),
                  reserveStatus.references[0], reserveStatus.references[1], reserveStatus.published);
    noteDownloadStatus(String("album RAM unavailable: ") + AlbumArtStore::failureName(reserveStatus.failure));
    return false;
  }
  auto discard = [&]() {
    const String failedPath = frame->path;
    frame.reset(); // Release the worker lease before retiring an unpublished frame.
    AlbumArtStore::instance().retire(failedPath);
  };
  if (!stillCurrent()) {
    discard();
    noteDownloadStatus("stale artwork cancelled");
    return false;
  }
  bool drawn = false;
  {
    ArtworkPhaseTrace phase("RAM-decode");
    vTaskDelay(1);
    lgfx::LGFX_Sprite thumb;
    thumb.setPsram(true);
    thumb.setBuffer(frame->pixels, LCD_THUMB_SIZE, LCD_THUMB_SIZE, 16);
    thumb.fillSprite(rgb565(7, 9, 9));
    const float scale = max(static_cast<float>(LCD_THUMB_SIZE) / info.width,
                            static_cast<float>(LCD_THUMB_SIZE) / info.height);
    if (info.format == AlbumArtPolicy::Format::Jpeg) {
      drawn = thumb.drawJpg(data, length, 0, 0, LCD_THUMB_SIZE, LCD_THUMB_SIZE, 0, 0, scale, scale, middle_center);
    } else {
      drawn = thumb.drawPng(data, length, 0, 0, LCD_THUMB_SIZE, LCD_THUMB_SIZE, 0, 0, scale, scale, middle_center);
      thumb.releasePngMemory();
    }
    // setBuffer() borrows the pool's pixels; the sprite does not own them.
    thumb.deleteSprite();
    vTaskDelay(1);
  }
  if (!drawn || !stillCurrent()) {
    discard();
    noteDownloadStatus(drawn ? "stale artwork cancelled" : "RAM cover decode failed");
    return false;
  }
  frame->format = info.format;
  frame->imageBytes = length;
  frame->image = data;
  data = nullptr; // Transfer the HTTP buffer, without copying or saving to flash.
  if (!AlbumArtStore::instance().publish(frame)) {
    discard();
    noteDownloadStatus("RAM cover publication failed");
    return false;
  }
  outPath = frame->path;
  albumArtTrace("RAM image ready: compressed=%u bytes, LCD=%ux%u; flash writes=0",
                static_cast<unsigned>(length), frame->side, frame->side);
  noteDownloadStatus("album ready in PSRAM");
  return true;
}

bool ArtworkCache::download(const String& url, String& outPath, uint32_t budgetMs, bool allowSecureFallback, const String& cacheKey,
                            bool* memoryUnavailable) {
  if (memoryUnavailable) *memoryUnavailable = false;
  const String storageKey = cacheKey.length() ? cacheKey : url;
  const bool fillFrame = cacheKey.startsWith(ALBUM_ART_CACHE_PREFIX) ||
                         (cacheKey.startsWith("embedded:") &&
                          AppConfig::instance().displayArtworkMode == "album");
  ArtworkPhaseTrace totalPhase("image-total", fillFrame);
  uint32_t deadlineMs = budgetMs > 0 ? millis() + budgetMs : 0;

  auto albumSearchStillCurrent = [&]() {
    if (!cacheKey.startsWith(ALBUM_ART_CACHE_PREFIX)) return true;
    PlayerStateSnapshot current = PlayerState::instance().snapshot();
    return current.playing && storageKey == String(ALBUM_ART_CACHE_PREFIX) + current.artist + "|" + current.title;
  };

  auto artworkCancelled = [&]() {
    if (!albumSearchStillCurrent()) {
      noteDownloadStatus("stale artwork cancelled");
      return true;
    }
    if (idlePrewarmCancellationRequested()) {
      noteDownloadStatus("idle prewarm cancelled");
      return true;
    }
    return false;
  };

  auto attemptDownload = [&](const String& fetchUrl) -> bool {
    if (artworkCancelled()) return false;
    if (deadlineReached(deadlineMs)) {
      noteDownloadStatus(String("budget expired before ") + fetchUrl);
      return false;
    }

    noteDownloadStatus(String("start ") + fetchUrl);

    PlayerStateSnapshot downloadState = PlayerState::instance().snapshot();
    ArtworkHttp::Options options;
    options.deadlineMs = deadlineMs;
    options.allowHttps = allowSecureFallback;
    options.cancelled = [&]() {
      return idlePrewarmCancellationRequested() || !albumSearchStillCurrent() ||
             (downloadState.playing && !audioConnectionReady);
    };
    ArtworkHttp::Response response;
    const unsigned long networkStartedMs = millis();
    if (!ArtworkHttp::get(fetchUrl, MAX_ARTWORK_BYTES, response, options)) {
      noteDownloadStatus(response.error + " host=" + ArtworkHttp::host(fetchUrl));
      return false;
    }
    const size_t written = response.size;
    albumArtTrace("image received: %u bytes, %lums, host=%s",
                  static_cast<unsigned>(written),
                  static_cast<unsigned long>(millis() - networkStartedMs),
                  ArtworkHttp::host(fetchUrl).c_str());

    if (!cacheKey.length() &&
        LcdImagePolicy::needsConversion(LcdImagePolicy::inspect(response.data, written))) {
      albumArtTrace("station JPEG is not LCD-compatible; trying an alternate source");
      noteDownloadStatus("station JPEG needs baseline conversion");
      return false;
    }

    // The socket is closed before any cache enumeration, flash erase or image
    // decoding. Previously cache maintenance used up the network deadline while
    // the response body was still waiting, leading to written=0 failures.
    if (artworkCancelled()) return false;
    if (cacheKey.startsWith(ALBUM_ART_CACHE_PREFIX)) {
      bool unavailable = false;
      const bool ready = prepareAlbumMemory(response.data, written, cacheKey, outPath, unavailable);
      if (memoryUnavailable) *memoryUnavailable = unavailable;
      return ready; // No filesystem fallback for short-lived album art.
    }
    const unsigned long storageStartedMs = millis();
    // Account for BOTH the compressed image and its LCD pixels in one preflight.
    // This is not an exclusive filesystem reservation; retain one final check
    // after the pair is complete in case another filesystem user wrote data.
    const bool cacheBudgetReserved = fillFrame;
    {
      ArtworkPhaseTrace phase("cache-reserve", fillFrame);
      enforceCacheBudget(written + (cacheBudgetReserved ? LCD_THUMB_BYTES : 0),
                         PlayerState::instance().snapshot().cachedArtworkPath);
    }
    if (artworkCancelled()) return false;
    String tempPath = cachePath(storageKey, ".tmp");
    bool stored = false;
    {
      ArtworkPhaseTrace phase("image-write", fillFrame);
      if (LittleFS.exists(tempPath)) LittleFS.remove(tempPath);
      File file = LittleFS.open(tempPath, "w");
      if (!file) {
        noteDownloadStatus("temp open failed " + tempPath);
        return false;
      }
      stored = writeBufferYielding(file, response.data, written);
      file.flush();
      file.close();
    }
    // Release the compressed image before allocating the LCD decoder buffers.
    free(response.data);
    response.data = nullptr;
    const bool cancelled = artworkCancelled();
    if (!stored || cancelled) {
      LittleFS.remove(tempPath);
      if (!cancelled) noteDownloadStatus("filesystem write failed");
      return false;
    }
    albumArtTrace("image stored: %u bytes, %lums", static_cast<unsigned>(written),
                  static_cast<unsigned long>(millis() - storageStartedMs));

    String extension;
    {
      ArtworkPhaseTrace phase("image-format", fillFrame);
      extension = detectDownloadedExtension(tempPath);
    }
    if (!extension.length()) {
      if (extractIcoImage(tempPath, storageKey, outPath)) {
        LittleFS.remove(tempPath);
        ensureLcdThumbnail(outPath, fillFrame);
        String compactedPath;
        compactRemoteArtwork(storageKey, outPath, compactedPath, fillFrame);
        outPath = compactedPath;
        enforceCacheBudget(0, outPath);
        noteDownloadStatus(String("cached ico payload ") + outPath);
        return true;
      }
      LittleFS.remove(tempPath);
      noteDownloadStatus(String("unsupported image payload written=") + String(static_cast<unsigned>(written)));
      return false;
    }

    String path = cachePath(storageKey, extension);
    {
      ArtworkPhaseTrace phase("image-commit", fillFrame);
      if (LittleFS.exists(path)) {
        LittleFS.remove(path);
      }
      if (!LittleFS.rename(tempPath, path)) {
        LittleFS.remove(tempPath);
        noteDownloadStatus(String("rename failed ") + path);
        return false;
      }
    }

    outPath = path;
    const bool thumbnailReady = ensureLcdThumbnailPrepared(path, fillFrame, cacheBudgetReserved);
    if (thumbnailReady) {
      ArtworkPhaseTrace phase("image-compact", fillFrame);
      compactRemoteArtwork(storageKey, path, outPath, fillFrame);
    } else if (fillFrame) {
      albumArtTrace("image downloaded but LCD cover thumbnail failed: %s", path.c_str());
      removeCachedArtworkFamily(path);
      outPath = "";
      noteDownloadStatus("unsupported LCD cover image");
      return false;
    }
    {
      ArtworkPhaseTrace phase("cache-final", fillFrame);
      enforceCacheBudget(0, outPath);
    }
    noteDownloadStatus(String("cached ") + outPath);
    return true;
  };

  // Album/embedded art never enters this branch. Keep the established download,
  // decode and publication path, including the original URL as cache identity.
  const String smallerStationLogo = cacheKey.length() ? String() : preferredStationLogoUrl(url);
  if (smallerStationLogo.length()) {
    albumArtTrace("trying smaller station logo: %s", smallerStationLogo.c_str());
    if (attemptDownload(smallerStationLogo)) return true;
    if (artworkCancelled() || (memoryUnavailable && *memoryUnavailable) || deadlineReached(deadlineMs)) return false;
    albumArtTrace("preferred station logo unavailable; trying compatible alternatives");
  }

  const String resizedStationLogo = cacheKey.length() ? String() : resizedStationLogoUrl(url);
  if (resizedStationLogo.length() && resizedStationLogo != smallerStationLogo) {
    albumArtTrace("trying baseline station logo: %s", resizedStationLogo.c_str());
    if (attemptDownload(resizedStationLogo)) return true;
    if (artworkCancelled() || (memoryUnavailable && *memoryUnavailable) || deadlineReached(deadlineMs)) return false;
  }

  String smallerImageUrl = cacheKey.length() ? imgurThumbnailFallbackUrl(url) : String();
  if (smallerImageUrl.length() && smallerImageUrl != url) {
    albumArtTrace("trying smaller Imgur image first");
    if (attemptDownload(ArtworkHttp::publicImageUrl(smallerImageUrl))) return true;
    if (artworkCancelled() || (memoryUnavailable && *memoryUnavailable) || deadlineReached(deadlineMs)) return false;
  }

  if (ArtworkHttp::host(url) == "coverartarchive.org") {
    ArtworkHttp::Options options;
    options.deadlineMs = deadlineMs;
    options.allowHttps = allowSecureFallback;
    options.cancelled = [&]() { return idlePrewarmCancellationRequested() || !albumSearchStillCurrent(); };
    const std::vector<String> servers = resolveCoverArchiveServers(url, options);
    for (const String& server : servers) {
      if (attemptDownload(server)) return true;
      if (artworkCancelled() || (memoryUnavailable && *memoryUnavailable) || deadlineReached(deadlineMs)) return false;
    }
    if (servers.empty()) noteDownloadStatus("CAA cover not available");
    return false;
  }

  const String publicUrl = ArtworkHttp::publicImageUrl(url);
  if (publicUrl != url) {
    albumArtTrace("public image transport: HTTP host=%s", ArtworkHttp::host(publicUrl).c_str());
    if (attemptDownload(publicUrl)) return true;
    if (artworkCancelled() || (memoryUnavailable && *memoryUnavailable) || deadlineReached(deadlineMs) || !allowSecureFallback) return false;
    albumArtTrace("HTTP image unavailable, trying advertised HTTPS URL");
  }
  return attemptDownload(url);
}
