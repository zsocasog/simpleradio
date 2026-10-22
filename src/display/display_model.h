#pragma once
#include <Arduino.h>
#include "../state/player_state.h"

struct DisplayModel {
  bool apMode = false;
  bool networkConnected = false;
  String ip;

  bool playing = false;
  StreamConnectionState streamConnectionState = StreamConnectionState::Idle;
  uint8_t streamConnectFailures = 0;
  uint8_t volume = 0;
  int stationId = -1;

  String station;
  String artist;
  String title;
  String bitrate;
  String codec;
  String logoPath;
  String streamLogoUrl;
  bool hasStreamImage = false;
  bool albumArtworkMode = false;
  bool isAlbumArtwork = false;

  String metaText;
  int16_t metaOffset = 0;
  bool metaScrollable = false;

  bool equals(const DisplayModel& o) const {
    return apMode == o.apMode &&
           networkConnected == o.networkConnected &&
           ip == o.ip &&
           playing == o.playing &&
           streamConnectionState == o.streamConnectionState &&
           streamConnectFailures == o.streamConnectFailures &&
           volume == o.volume &&
           stationId == o.stationId &&
           station == o.station &&
           artist == o.artist &&
           title == o.title &&
           bitrate == o.bitrate &&
           codec == o.codec &&
           logoPath == o.logoPath &&
           streamLogoUrl == o.streamLogoUrl &&
           hasStreamImage == o.hasStreamImage &&
           albumArtworkMode == o.albumArtworkMode &&
           isAlbumArtwork == o.isAlbumArtwork &&
           metaText == o.metaText &&
           metaOffset == o.metaOffset &&
           metaScrollable == o.metaScrollable;
  }
};
