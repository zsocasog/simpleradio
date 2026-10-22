#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

enum class StreamConnectionState : uint8_t {
  Idle = 0,
  WaitingForNetwork,
  Connecting,
  Connected,
  RetryWaiting,
  Failed
};

const char* streamConnectionStateName(StreamConnectionState state);

struct PlayerStateSnapshot {
  bool playing = false;
  StreamConnectionState streamConnectionState = StreamConnectionState::Idle;
  uint8_t streamConnectFailures = 0;
  uint8_t volume = 50;
  int stationId = -1;
  int8_t eqLow = 0;
  int8_t eqMid = 0;
  int8_t eqHigh = 0;
  int8_t balance = 0;
  String station;
  String streamUrl;
  String stationLogo;
  String artist;
  String title;
  String bitrate;
  String codec;
  String streamLogoUrl;
  String cachedArtworkPath;
  String albumArtworkPath;
  String embeddedArtworkKey;
  bool hasStreamImage = false;
};

class PlayerState {
public:
  static PlayerState& instance();

  bool playing = false;
  StreamConnectionState streamConnectionState = StreamConnectionState::Idle;
  uint8_t streamConnectFailures = 0;
  uint8_t volume = 50;
  int stationId = -1;
  int8_t eqLow = 0;
  int8_t eqMid = 0;
  int8_t eqHigh = 0;
  int8_t balance = 0;

  String station;
  String streamUrl;
  String stationLogo;

  String artist;
  String title;
  String bitrate;
  String codec;
  String streamLogoUrl;
  String cachedArtworkPath;
  String albumArtworkPath;
  String embeddedArtworkKey;
  bool hasStreamImage = false;

  PlayerStateSnapshot snapshot() const;
  uint32_t revision() const;
  String toJson() const;
  bool applyCommand(const JsonDocument& cmd);
  bool loadStation(int id, bool resetMetadata = true, bool markDirty = true);
  bool clearStation(bool markDirty = true);
  bool clearPlaybackMetadata(bool markDirty = true);
  void setStreamTitle(const String& streamTitle);
  void setStreamArtistTitle(const String& streamArtist, const String& streamTitle);
  void setStreamLogoUrl(const String& logoUrl);
  void setCachedArtworkPath(const String& path);
  void setAlbumArtworkPath(const String& path);
  void setEmbeddedArtworkKey(const String& key);
  void setStationName(const String& name);
  void setBitrate(const String& value);
  void setCodec(const String& value);
  void setHasStreamImage(bool value);
  void setStreamConnectionState(StreamConnectionState state, uint8_t failures = 0);
  void setEq(int8_t low, int8_t mid, int8_t high);
  void setBalance(int8_t value);

private:
  PlayerState() = default;
};

extern volatile bool playerStateDirty;
extern volatile uint32_t playerStateRevision;
