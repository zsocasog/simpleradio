#include "display_presenter.h"
#include <LittleFS.h>
#include <WiFi.h>
#include "../artwork/artwork_cache.h"

static constexpr int META_SCROLL_THRESHOLD = 26;

static bool isRemoteUrl(const String& value) {
  return value.startsWith("http://") || value.startsWith("https://");
}

static String fileStem(const String& path) {
  int slash = path.lastIndexOf('/');
  int dot = path.lastIndexOf('.');
  if (dot <= slash) return path;
  return path.substring(0, dot);
}

static String fileNameOnly(const String& path) {
  int slash = path.lastIndexOf('/');
  if (slash < 0) return path;
  return path.substring(slash + 1);
}

static String normalizeLocalLogoPath(String path) {
  path.trim();
  if (!path.length() || isRemoteUrl(path)) return path;
  if (path.startsWith("/")) return path;

  String rooted = "/" + path;
  if (LittleFS.exists(rooted)) return rooted;

  String logosRooted = "/logos/" + path;
  if (LittleFS.exists(logosRooted)) return logosRooted;

  return rooted;
}

static String localLcdLogoPath(const String& path) {
  String localPath = normalizeLocalLogoPath(path);
  if (!localPath.startsWith("/")) return localPath;

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

DisplayModel DisplayPresenter::build(const PlayerState& s) {
  PlayerStateSnapshot state = s.snapshot();
  DisplayModel m;

  m.apMode = !WiFi.isConnected();
  m.ip = m.apMode
           ? WiFi.softAPIP().toString()
           : WiFi.localIP().toString();

  m.playing = state.playing;
  m.volume = state.volume;
  m.stationId = state.stationId;

  m.station = state.station;
  m.artist = state.artist;
  m.title = state.title;
  m.bitrate = state.bitrate;
  m.codec = state.codec;
  m.streamLogoUrl = state.streamLogoUrl;
  m.hasStreamImage = state.hasStreamImage;
  m.logoPath = state.cachedArtworkPath.length() ? state.cachedArtworkPath : localLcdLogoPath(state.stationLogo);
  if (!state.cachedArtworkPath.length()) {
    String cachedPath;
    if (state.embeddedArtworkKey.length() &&
        ArtworkCache::instance().findExistingCachePath(state.embeddedArtworkKey, cachedPath)) {
      m.logoPath = cachedPath;
    } else if (isRemoteUrl(state.streamLogoUrl) &&
               (ArtworkCache::instance().findExistingLcdArtworkPath(state.streamLogoUrl, cachedPath) ||
                ArtworkCache::instance().findExistingCachePath(state.streamLogoUrl, cachedPath))) {
      m.logoPath = cachedPath;
    } else if (isRemoteUrl(state.stationLogo) &&
               (ArtworkCache::instance().findExistingLcdArtworkPath(state.stationLogo, cachedPath) ||
                ArtworkCache::instance().findExistingCachePath(state.stationLogo, cachedPath))) {
      m.logoPath = cachedPath;
    }
  }

  if (state.artist.length() || state.title.length()) {
    m.metaText = state.artist;
    if (state.artist.length() && state.title.length()) {
      m.metaText += " - ";
    }
    m.metaText += state.title;
    m.metaScrollable = m.metaText.length() > META_SCROLL_THRESHOLD;
  }

  return m;
}
