#pragma once

#include <Arduino.h>
#include <FS.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <vector>
#include "album_search_policy.h"

struct PlayerStateSnapshot;

class ArtworkCache {
public:
  static ArtworkCache& instance();

  void begin();
  void loop();
  void requestEmbeddedImage(const String& streamUrl, const std::vector<uint32_t>& segments);
  bool findExistingCachePath(const String& url, String& outPath) const;
  bool findExistingLcdArtworkPath(const String& source, String& outPath) const;
  String lcdThumbnailPath(const String& imagePath, bool fillFrame = false) const;
  bool lcdThumbnailReady(const String& imagePath, bool fillFrame = false);
  bool artworkExists(const String& imagePath) const;
  void invalidateLcdThumbnail(const String& imagePath);
  bool ensureLcdThumbnail(const String& imagePath, bool fillFrame = false);
  bool requestLcdThumbnail(const String& imagePath, bool idlePrewarm = false, bool fillFrame = false);
  bool requestPrewarm(const String& source, bool highPriority = false);
  bool deferStationPlayback(int stationId);
  void cancelPendingPlayback();
  bool prepareStationForPlayback(int stationId, String& outPath, uint32_t budgetMs = 5200);
  bool stationArtworkReady(int stationId, String* outPath = nullptr) const;
  bool importLocalImage(const String& url, const String& tempPath, String& outPath);
  bool queueBrowserArtworkImport(const String& url, const String& tempPath);
  size_t cacheBytes() const;
  size_t cacheLimitBytes() const;
  size_t cacheTargetBytes() const;
  void enforceCacheBudget(size_t incomingBytes = 0, const String& keepPath = "");
  bool downloadActive();
  unsigned long downloadElapsedMs();
  String activeDownloadLabel();
  void cancelIdlePrewarm();
  void notifyAudioConnectStarting();
  void notifyAudioConnectResult(bool connected);
  void retryCurrentAlbumLookup();
  String lastDownloadStatus();
  unsigned long lastDownloadStatusAgeMs();

private:
  ArtworkCache() = default;

  enum class AlbumArtworkProvider : uint8_t {
    MusicBrainz,
    LastFm,
    Deezer,
    ITunes
  };

  struct AlbumArtworkFallbacks {
    std::vector<String> singles;
    std::vector<String> artistCollections;
    std::vector<String> unverified;
    std::vector<String> compilations;
  };

  struct AlbumArtworkSearch {
    AlbumSearchPolicy::MusicBrainzRound musicBrainz;
    bool retryReleaseGroup = false;
    struct DeferredAlbum {
      String mbid;
      String artist;
      String title;
      String cover;
      int quality = 0;
    } lastFmAlbum;
  };

  bool download(const String& url, String& outPath, uint32_t budgetMs = 0, bool allowSecureFallback = true, const String& cacheKey = "",
                bool* memoryUnavailable = nullptr);
  bool prepareAlbumMemory(uint8_t*& data, size_t length, const String& key, String& outPath, bool& unavailable);
  bool resolveAndDownloadAlbumArtwork(const String& artist, const String& title, const String& key, String& outPath);
  bool downloadEmbedded(const String& url, const std::vector<uint32_t>& segments, const String& key, String& outPath);
  bool appendHttpRange(const String& url, uint32_t offset, uint32_t length, File& outFile,
                       const String& expectedKey);
  bool normalizeEmbeddedImage(const String& tempPath, const String& key, String& outPath);
  bool extractIcoImage(const String& sourcePath, const String& key, String& outPath);
  bool writeBmpFromIcoDib(const String& sourcePath, size_t offset, size_t length, const String& key, String& outPath);
  bool finalizeImagePayload(const String& sourcePath, size_t offset, size_t length, const String& key, String& outPath);
  bool decodeBase64File(const String& sourcePath, const String& decodedPath);
  String embeddedKey(const String& streamUrl, const std::vector<uint32_t>& segments) const;
  String cachePath(const String& url, const String& extension) const;
  String detectDownloadedExtension(const String& tempPath) const;
  String currentArtworkUrl() const;
  bool startDownloadTask(const String& url, bool idlePrewarm = false, bool allowSecureFallback = true);
  bool startAlbumArtworkTask(const String& artist, const String& title, const String& key);
  std::vector<String> resolveAlbumArtworkUrls(const String& artist, const String& title, AlbumArtworkProvider provider,
                                            uint32_t deadlineMs, AlbumArtworkFallbacks& fallbacks,
                                            AlbumArtworkSearch& search);
  void removeCachedArtworkFamily(const String& imagePath);
  bool startEmbeddedDownloadTask(const String& key, const String& url, const std::vector<uint32_t>& segments);
  bool startThumbnailTask(const String& imagePath, bool idlePrewarm = false, bool fillFrame = false);
  bool startBrowserArtworkImportTask(const String& url, const String& tempPath);
  void processPrewarmQueue(const PlayerStateSnapshot& state);
  void processPendingBrowserImport();
  void processPendingPlayback(const PlayerStateSnapshot& state);
  bool takePrewarmItem(String& source);
  bool queuePrewarmItem(const String& source, bool highPriority);
  bool queueNextStationPrewarmCandidate();
  bool artworkSourceReady(const String& source) const;
  bool prepareArtworkSourceForPlayback(const String& source, String& outPath, uint32_t budgetMs);
  bool waitForActiveArtworkJob(const String& source, String& outPath, uint32_t budgetMs);
  String preferredLocalArtworkPath(String source) const;
  bool thumbnailKnownReady(const String& imagePath, const String& thumbPath) const;
  void markThumbnailReady(const String& imagePath, const String& thumbPath);
  void clearThumbnailReady(const String& imagePath = "");
  bool stateUsesArtworkPath(const PlayerStateSnapshot& state, const String& imagePath) const;
  bool refreshArtworkIfThumbnailReady(const String& imagePath, const PlayerStateSnapshot& state, bool fillFrame = false);
  bool markDownloadStarted(const String& label, TaskHandle_t handle = nullptr, bool idlePrewarm = false);
  void setDownloadTaskHandle(TaskHandle_t handle);
  void markDownloadFinished();
  bool idlePrewarmCancellationRequested();
  bool writeBufferYielding(File& file, const uint8_t* data, size_t length);
  bool ensureLcdThumbnailPrepared(const String& imagePath, bool fillFrame, bool cacheBudgetReserved);
  bool compactRemoteArtwork(const String& source, const String& imagePath, String& outPath, bool fillFrame = false);
  bool isDownloadActive();
  void noteDownloadStatus(const String& status);
  void storeDownloadResult(const String& url, const String& path, bool success);
  bool takeDownloadResult(String& url, String& path, bool& success);
  bool prewarmFailureBlocked(const String& source) const;
  void notePrewarmFailure(const String& source);
  bool takePendingEmbedded(String& key, String& url, std::vector<uint32_t>& segments);
  static void downloadTask(void* param);

  String lastUrl;
  unsigned long lastAttemptMs = 0;
  bool downloadInProgress = false;
  bool downloadIsIdlePrewarm = false;
  bool idlePrewarmCancelRequested = false;
  unsigned long downloadStartedMs = 0;
  String downloadLabel;
  String downloadStatus;
  unsigned long downloadStatusMs = 0;
  TaskHandle_t downloadTaskHandle = nullptr;
  SemaphoreHandle_t resultMutex = nullptr;
  SemaphoreHandle_t pendingMutex = nullptr;
  SemaphoreHandle_t downloadMutex = nullptr;
  SemaphoreHandle_t thumbnailMutex = nullptr;
  SemaphoreHandle_t prewarmMutex = nullptr;
  bool resultReady = false;
  bool resultSuccess = false;
  String resultUrl;
  String resultPath;
  bool pendingEmbedded = false;
  String pendingEmbeddedKey;
  String pendingEmbeddedUrl;
  std::vector<uint32_t> pendingEmbeddedSegments;
  bool pendingBrowserImport = false;
  String pendingBrowserImportUrl;
  String pendingBrowserImportPath;
  String readyThumbnailSource;
  String readyThumbnailPath;
  String lastThumbnailAttemptSource;
  unsigned long lastThumbnailAttemptMs = 0;
  std::vector<String> prewarmQueue;
  struct PrewarmFailure {
    String source;
    unsigned long failedMs = 0;
  };
  std::vector<PrewarmFailure> prewarmFailures;
  unsigned long lastPrewarmWorkMs = 0;
  size_t stationPrewarmIndex = 0;
  uint32_t stationPrewarmRevision = 0;
  String lastArtworkRefreshPath;
  String activeAlbumArtworkKey;
  String previousAlbumArtworkPath;
  String lastAlbumLookupKey;
  unsigned long lastAlbumLookupMs = 0;
  volatile bool albumLookupRetryRequested = false;
  String deferredArtworkUrl;
  int deferredArtworkStationId = -1;
  int pendingPlaybackStationId = -1;
  unsigned long pendingPlaybackStartedMs = 0;
  unsigned long artworkStartedMs = 0;
  bool lastArtworkPlaying = false;
  uint32_t lastCachedArtworkProbeMs = 0;
  uint32_t lastCachedArtworkProbeHash = 0;
  int lastIdlePrewarmStationId = -1;
  volatile bool audioConnectionReady = false;
  volatile unsigned long audioConnectionReadyMs = 0;
};
