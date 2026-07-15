#include "player_state.h"
#include "../stations/station_manager.h"
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

volatile bool playerStateDirty = false;
volatile uint32_t playerStateRevision = 1;
static SemaphoreHandle_t playerStateMutex = nullptr;

static SemaphoreHandle_t playerStateLockHandle() {
  if (!playerStateMutex) {
    playerStateMutex = xSemaphoreCreateRecursiveMutex();
  }
  return playerStateMutex;
}

class PlayerStateLock {
public:
  PlayerStateLock() {
    SemaphoreHandle_t mutex = playerStateLockHandle();
    locked = mutex && xSemaphoreTakeRecursive(mutex, pdMS_TO_TICKS(1000)) == pdTRUE;
  }

  ~PlayerStateLock() {
    if (locked) xSemaphoreGiveRecursive(playerStateLockHandle());
  }

  bool ok() const {
    return locked;
  }

private:
  bool locked = false;
};

static void markPlayerStateDirty() {
  uint32_t nextRevision = playerStateRevision + 1;
  playerStateRevision = nextRevision ? nextRevision : 1;
  playerStateDirty = true;
}

static void appendUtf8(String& out, uint16_t code) {
  if (code < 0x80) {
    out += static_cast<char>(code);
  } else if (code < 0x800) {
    out += static_cast<char>(0xC0 | (code >> 6));
    out += static_cast<char>(0x80 | (code & 0x3F));
  } else {
    out += static_cast<char>(0xE0 | (code >> 12));
    out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (code & 0x3F));
  }
}

static bool isValidUtf8(const String& text) {
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(text.c_str());
  size_t len = text.length();
  size_t i = 0;

  while (i < len) {
    uint8_t c = bytes[i++];
    if (c < 0x80) continue;

    uint8_t need = 0;
    uint32_t code = 0;
    if ((c & 0xE0) == 0xC0) {
      need = 1;
      code = c & 0x1F;
      if (code == 0) return false;
    } else if ((c & 0xF0) == 0xE0) {
      need = 2;
      code = c & 0x0F;
    } else if ((c & 0xF8) == 0xF0) {
      need = 3;
      code = c & 0x07;
    } else {
      return false;
    }

    if (i + need > len) return false;
    for (uint8_t j = 0; j < need; ++j) {
      uint8_t cc = bytes[i++];
      if ((cc & 0xC0) != 0x80) return false;
      code = (code << 6) | (cc & 0x3F);
    }
  }

  return true;
}

static bool readUtf8Codepoint(const char*& cursor, uint32_t& code) {
  uint8_t c = static_cast<uint8_t>(*cursor++);
  if (c < 0x80) {
    code = c;
    return true;
  }

  uint8_t need = 0;
  if ((c & 0xE0) == 0xC0) {
    need = 1;
    code = c & 0x1F;
  } else if ((c & 0xF0) == 0xE0) {
    need = 2;
    code = c & 0x0F;
  } else if ((c & 0xF8) == 0xF0) {
    need = 3;
    code = c & 0x07;
  } else {
    return false;
  }

  for (uint8_t i = 0; i < need; ++i) {
    uint8_t cc = static_cast<uint8_t>(*cursor++);
    if ((cc & 0xC0) != 0x80) return false;
    code = (code << 6) | (cc & 0x3F);
  }
  return true;
}

static uint16_t cp1250Codepoint(uint8_t c) {
  switch (c) {
    case 0x80: return 0x20AC;
    case 0x82: return 0x201A;
    case 0x84: return 0x201E;
    case 0x85: return 0x2026;
    case 0x86: return 0x2020;
    case 0x87: return 0x2021;
    case 0x89: return 0x2030;
    case 0x8A: return 0x0160;
    case 0x8B: return 0x2039;
    case 0x8C: return 0x015A;
    case 0x8D: return 0x0164;
    case 0x8E: return 0x017D;
    case 0x8F: return 0x0179;
    case 0x91: return 0x2018;
    case 0x92: return 0x2019;
    case 0x93: return 0x201C;
    case 0x94: return 0x201D;
    case 0x95: return 0x2022;
    case 0x96: return 0x2013;
    case 0x97: return 0x2014;
    case 0x99: return 0x2122;
    case 0x9A: return 0x0161;
    case 0x9B: return 0x203A;
    case 0x9C: return 0x015B;
    case 0x9D: return 0x0165;
    case 0x9E: return 0x017E;
    case 0x9F: return 0x017A;
    case 0xA5: return 0x0104;
    case 0xA8: return 0x00A8;
    case 0xAA: return 0x015E;
    case 0xAF: return 0x017B;
    case 0xB2: return 0x02DB;
    case 0xB3: return 0x0142;
    case 0xB9: return 0x0105;
    case 0xBA: return 0x015F;
    case 0xBC: return 0x013D;
    case 0xBE: return 0x013E;
    case 0xBF: return 0x017C;
    case 0xC3: return 0x0102;
    case 0xC5: return 0x0139;
    case 0xC6: return 0x0106;
    case 0xC8: return 0x010C;
    case 0xCF: return 0x010E;
    case 0xD0: return 0x0110;
    case 0xD1: return 0x0143;
    case 0xD2: return 0x0147;
    case 0xD5: return 0x0150;
    case 0xD8: return 0x0158;
    case 0xD9: return 0x016E;
    case 0xDB: return 0x0170;
    case 0xDE: return 0x0162;
    case 0xE3: return 0x0103;
    case 0xE5: return 0x013A;
    case 0xE6: return 0x0107;
    case 0xE8: return 0x010D;
    case 0xEF: return 0x010F;
    case 0xF0: return 0x0111;
    case 0xF1: return 0x0144;
    case 0xF2: return 0x0148;
    case 0xF5: return 0x0151;
    case 0xF8: return 0x0159;
    case 0xF9: return 0x016F;
    case 0xFB: return 0x0171;
    case 0xFE: return 0x0163;
    case 0xFF: return 0x02D9;
    default: return c;
  }
}

static bool cp1250ByteForCodepoint(uint32_t code, uint8_t& out) {
  if (code < 0x80 || (code >= 0xA0 && code <= 0xFF)) {
    out = static_cast<uint8_t>(code);
    return true;
  }

  switch (code) {
    case 0x20AC: out = 0x80; return true;
    case 0x201A: out = 0x82; return true;
    case 0x201E: out = 0x84; return true;
    case 0x2026: out = 0x85; return true;
    case 0x2020: out = 0x86; return true;
    case 0x2021: out = 0x87; return true;
    case 0x2030: out = 0x89; return true;
    case 0x0160: out = 0x8A; return true;
    case 0x2039: out = 0x8B; return true;
    case 0x015A: out = 0x8C; return true;
    case 0x0164: out = 0x8D; return true;
    case 0x017D: out = 0x8E; return true;
    case 0x0179: out = 0x8F; return true;
    case 0x2018: out = 0x91; return true;
    case 0x2019: out = 0x92; return true;
    case 0x201C: out = 0x93; return true;
    case 0x201D: out = 0x94; return true;
    case 0x2022: out = 0x95; return true;
    case 0x2013: out = 0x96; return true;
    case 0x2014: out = 0x97; return true;
    case 0x2122: out = 0x99; return true;
    case 0x0161: out = 0x9A; return true;
    case 0x203A: out = 0x9B; return true;
    case 0x015B: out = 0x9C; return true;
    case 0x0165: out = 0x9D; return true;
    case 0x017E: out = 0x9E; return true;
    case 0x017A: out = 0x9F; return true;
    case 0x0104: out = 0xA5; return true;
    case 0x015E: out = 0xAA; return true;
    case 0x017B: out = 0xAF; return true;
    case 0x02DB: out = 0xB2; return true;
    case 0x0142: out = 0xB3; return true;
    case 0x0105: out = 0xB9; return true;
    case 0x015F: out = 0xBA; return true;
    case 0x013D: out = 0xBC; return true;
    case 0x013E: out = 0xBE; return true;
    case 0x017C: out = 0xBF; return true;
    case 0x0102: out = 0xC3; return true;
    case 0x0139: out = 0xC5; return true;
    case 0x0106: out = 0xC6; return true;
    case 0x010C: out = 0xC8; return true;
    case 0x010E: out = 0xCF; return true;
    case 0x0110: out = 0xD0; return true;
    case 0x0143: out = 0xD1; return true;
    case 0x0147: out = 0xD2; return true;
    case 0x0150: out = 0xD5; return true;
    case 0x0158: out = 0xD8; return true;
    case 0x016E: out = 0xD9; return true;
    case 0x0170: out = 0xDB; return true;
    case 0x0162: out = 0xDE; return true;
    case 0x0103: out = 0xE3; return true;
    case 0x013A: out = 0xE5; return true;
    case 0x0107: out = 0xE6; return true;
    case 0x010D: out = 0xE8; return true;
    case 0x010F: out = 0xEF; return true;
    case 0x0111: out = 0xF0; return true;
    case 0x0144: out = 0xF1; return true;
    case 0x0148: out = 0xF2; return true;
    case 0x0151: out = 0xF5; return true;
    case 0x0159: out = 0xF8; return true;
    case 0x016F: out = 0xF9; return true;
    case 0x0171: out = 0xFB; return true;
    case 0x0163: out = 0xFE; return true;
    case 0x02D9: out = 0xFF; return true;
    default: return false;
  }
}

static String repairMojibake(String text) {
  if (!isValidUtf8(text)) return text;

  String bytes;
  bytes.reserve(text.length());
  bool hasHighByte = false;
  const char* cursor = text.c_str();
  while (*cursor) {
    uint32_t code = 0;
    if (!readUtf8Codepoint(cursor, code)) return text;

    uint8_t byte = 0;
    if (!cp1250ByteForCodepoint(code, byte)) return text;
    if (byte >= 0x80) hasHighByte = true;
    bytes += static_cast<char>(byte);
  }

  if (!hasHighByte || !isValidUtf8(bytes)) return text;
  return bytes;
}

static String clampTextBytes(String text, size_t maxBytes) {
  if (text.length() <= maxBytes) return text;

  size_t cut = maxBytes;
  while (cut > 0 && (static_cast<uint8_t>(text[cut]) & 0xC0) == 0x80) {
    --cut;
  }
  text.remove(cut);
  text.trim();
  return text;
}

static String normalizeText(String text) {
  text.replace("\r", " ");
  text.replace("\n", " ");
  text.trim();
  if (!text.length()) return text;

  if (isValidUtf8(text)) {
    return clampTextBytes(repairMojibake(text), 180);
  }

  String out;
  out.reserve(text.length() * 2);
  for (size_t i = 0; i < text.length(); ++i) {
    uint8_t c = static_cast<uint8_t>(text[i]);
    appendUtf8(out, cp1250Codepoint(c));
  }
  return clampTextBytes(out, 180);
}

PlayerState& PlayerState::instance() {
  static PlayerState s;
  return s;
}

PlayerStateSnapshot PlayerState::snapshot() const {
  PlayerStateSnapshot out;
  PlayerStateLock lock;
  if (!lock.ok()) return out;

  out.playing = playing;
  out.volume = volume;
  out.stationId = stationId;
  out.eqLow = eqLow;
  out.eqMid = eqMid;
  out.eqHigh = eqHigh;
  out.balance = balance;
  out.station = station;
  out.streamUrl = streamUrl;
  out.stationLogo = stationLogo;
  out.artist = artist;
  out.title = title;
  out.bitrate = bitrate;
  out.codec = codec;
  out.streamLogoUrl = streamLogoUrl;
  out.cachedArtworkPath = cachedArtworkPath;
  out.embeddedArtworkKey = embeddedArtworkKey;
  out.hasStreamImage = hasStreamImage;
  return out;
}

uint32_t PlayerState::revision() const {
  return playerStateRevision;
}

String PlayerState::toJson() const {
  PlayerStateSnapshot s = snapshot();
  JsonDocument doc;
  doc["playing"] = s.playing;
  doc["volume"] = s.volume;
  doc["stationId"] = s.stationId;
  doc["eqLow"] = s.eqLow;
  doc["eqMid"] = s.eqMid;
  doc["eqHigh"] = s.eqHigh;
  doc["balance"] = s.balance;
  doc["station"] = s.station;
  doc["stationLogo"] = s.stationLogo;
  doc["artist"] = s.artist;
  doc["title"] = s.title;
  doc["bitrate"] = s.bitrate;
  doc["codec"] = s.codec;
  doc["streamLogoUrl"] = s.streamLogoUrl;
  doc["cachedArtworkPath"] = s.cachedArtworkPath;
  doc["embeddedArtworkKey"] = s.embeddedArtworkKey;
  doc["hasStreamImage"] = s.hasStreamImage;

  String out;
  serializeJson(doc, out);
  return out;
}

static bool clearStringIfNeeded(String& value) {
  if (!value.length()) return false;
  value = "";
  return true;
}

bool PlayerState::loadStation(int id, bool resetMetadata, bool markDirty) {
  PlayerStateLock lock;
  if (!lock.ok()) return false;

  Station nextStation;
  if (!StationManager::instance().getStation(id, nextStation)) return false;

  bool changed = false;
  bool streamChanged = streamUrl != nextStation.url;
  bool logoChanged = stationLogo != nextStation.logo;

  String nextName = normalizeText(nextStation.name);
  if (stationId != id) {
    stationId = id;
    changed = true;
  }
  if (station != nextName) {
    station = nextName;
    changed = true;
  }
  if (streamChanged) {
    streamUrl = nextStation.url;
    changed = true;
    resetMetadata = true;
  }
  if (logoChanged) {
    stationLogo = nextStation.logo;
    cachedArtworkPath = "";
    changed = true;
  }

  if (resetMetadata) {
    changed |= clearStringIfNeeded(artist);
    changed |= clearStringIfNeeded(title);
    changed |= clearStringIfNeeded(bitrate);
    changed |= clearStringIfNeeded(codec);
    changed |= clearStringIfNeeded(streamLogoUrl);
    changed |= clearStringIfNeeded(cachedArtworkPath);
    changed |= clearStringIfNeeded(embeddedArtworkKey);
    if (hasStreamImage) {
      hasStreamImage = false;
      changed = true;
    }
  }

  if (changed && markDirty) markPlayerStateDirty();
  return changed;
}

bool PlayerState::clearStation(bool markDirty) {
  PlayerStateLock lock;
  if (!lock.ok()) return false;

  bool changed = false;

  if (playing) {
    playing = false;
    changed = true;
  }
  if (stationId != -1) {
    stationId = -1;
    changed = true;
  }

  changed |= clearStringIfNeeded(station);
  changed |= clearStringIfNeeded(streamUrl);
  changed |= clearStringIfNeeded(stationLogo);
  changed |= clearStringIfNeeded(artist);
  changed |= clearStringIfNeeded(title);
  changed |= clearStringIfNeeded(bitrate);
  changed |= clearStringIfNeeded(codec);
  changed |= clearStringIfNeeded(streamLogoUrl);
  changed |= clearStringIfNeeded(cachedArtworkPath);
  changed |= clearStringIfNeeded(embeddedArtworkKey);

  if (hasStreamImage) {
    hasStreamImage = false;
    changed = true;
  }

  if (changed && markDirty) markPlayerStateDirty();
  return changed;
}

bool PlayerState::clearPlaybackMetadata(bool markDirty) {
  PlayerStateLock lock;
  if (!lock.ok()) return false;

  bool changed = false;
  changed |= clearStringIfNeeded(artist);
  changed |= clearStringIfNeeded(title);
  changed |= clearStringIfNeeded(bitrate);
  changed |= clearStringIfNeeded(codec);
  changed |= clearStringIfNeeded(streamLogoUrl);
  changed |= clearStringIfNeeded(cachedArtworkPath);
  changed |= clearStringIfNeeded(embeddedArtworkKey);

  if (hasStreamImage) {
    hasStreamImage = false;
    changed = true;
  }

  if (changed && markDirty) markPlayerStateDirty();
  return changed;
}

bool PlayerState::applyCommand(const JsonDocument& cmd) {
  PlayerStateLock lock;
  if (!lock.ok()) return false;

  bool changed = false;

  if (cmd["station"].is<int>()) {
    int id = cmd["station"].as<int>();
    changed |= loadStation(id, id != stationId, false);
  }

  if (cmd["play"].is<bool>()) {
    bool requestedPlaying = cmd["play"];
    bool nextPlaying = requestedPlaying && stationId >= 0 && streamUrl.length();
    if (nextPlaying != playing) {
      playing = nextPlaying;
      changed = true;
    }
    if (!nextPlaying) {
      changed |= clearPlaybackMetadata(false);
    }
  }

  if (cmd["volume"].is<int>()) {
    uint8_t nextVolume = constrain(cmd["volume"].as<int>(), 0, 100);
    if (nextVolume != volume) {
      volume = nextVolume;
      changed = true;
    }
  }

  bool eqChanged = false;
  int8_t nextLow = eqLow;
  int8_t nextMid = eqMid;
  int8_t nextHigh = eqHigh;

  if (cmd["eqLow"].is<int>()) {
    nextLow = constrain(cmd["eqLow"].as<int>(), -12, 6);
    eqChanged = true;
  }

  if (cmd["eqMid"].is<int>()) {
    nextMid = constrain(cmd["eqMid"].as<int>(), -12, 6);
    eqChanged = true;
  }

  if (cmd["eqHigh"].is<int>()) {
    nextHigh = constrain(cmd["eqHigh"].as<int>(), -12, 6);
    eqChanged = true;
  }

  if (eqChanged && (nextLow != eqLow || nextMid != eqMid || nextHigh != eqHigh)) {
    setEq(nextLow, nextMid, nextHigh);
    changed = true;
  }

  if (cmd["balance"].is<int>()) {
    int8_t nextBalance = constrain(cmd["balance"].as<int>(), -100, 100);
    if (nextBalance != balance) {
      setBalance(nextBalance);
      changed = true;
    }
  }

  if (changed) markPlayerStateDirty();
  return changed;
}

void PlayerState::setStreamTitle(const String& streamTitle) {
  PlayerStateLock lock;
  if (!lock.ok()) return;
  if (!playing) return;

  String fullTitle = normalizeText(streamTitle);
  String nextArtist;
  String nextTitle = fullTitle;

  int sep = nextTitle.indexOf(" - ");
  if (sep > 0) {
    nextArtist = nextTitle.substring(0, sep);
    nextTitle = fullTitle.substring(sep + 3);
  }

  if (artist == nextArtist && title == nextTitle) return;

  artist = nextArtist;
  title = nextTitle;
  markPlayerStateDirty();
}

void PlayerState::setStreamLogoUrl(const String& logoUrl) {
  PlayerStateLock lock;
  if (!lock.ok()) return;

  String next = logoUrl;
  next.trim();
  if (!next.length() || streamLogoUrl == next) return;
  streamLogoUrl = next;
  if (!embeddedArtworkKey.length()) cachedArtworkPath = "";
  markPlayerStateDirty();
}

void PlayerState::setCachedArtworkPath(const String& path) {
  PlayerStateLock lock;
  if (!lock.ok()) return;

  if (cachedArtworkPath == path) return;
  cachedArtworkPath = path;
  markPlayerStateDirty();
}

void PlayerState::setEmbeddedArtworkKey(const String& key) {
  PlayerStateLock lock;
  if (!lock.ok()) return;
  if (!playing) return;

  if (embeddedArtworkKey == key && hasStreamImage) return;
  embeddedArtworkKey = key;
  hasStreamImage = key.length() > 0;
  markPlayerStateDirty();
}

void PlayerState::setStationName(const String& name) {
  PlayerStateLock lock;
  if (!lock.ok()) return;
  if (!playing) return;

  String nextName = normalizeText(name);
  String lowered = nextName;
  lowered.toLowerCase();

  if (!nextName.length() || lowered == "no name" || lowered == "noname" || station == nextName) return;
  if (stationId >= 0) return;

  station = nextName;
  markPlayerStateDirty();
}

void PlayerState::setBitrate(const String& value) {
  PlayerStateLock lock;
  if (!lock.ok()) return;
  if (!playing) return;

  if (bitrate == value) return;
  bitrate = value;
  markPlayerStateDirty();
}

void PlayerState::setCodec(const String& value) {
  PlayerStateLock lock;
  if (!lock.ok()) return;
  if (!playing) return;

  String next = value;
  next.trim();
  next.toUpperCase();
  if (!next.length() || codec == next) return;
  codec = next;
  markPlayerStateDirty();
}

void PlayerState::setHasStreamImage(bool value) {
  PlayerStateLock lock;
  if (!lock.ok()) return;
  if (!playing) return;

  if (hasStreamImage == value) return;
  hasStreamImage = value;
  markPlayerStateDirty();
}

void PlayerState::setEq(int8_t low, int8_t mid, int8_t high) {
  PlayerStateLock lock;
  if (!lock.ok()) return;

  low = constrain(low, -12, 6);
  mid = constrain(mid, -12, 6);
  high = constrain(high, -12, 6);

  if (eqLow == low && eqMid == mid && eqHigh == high) return;

  eqLow = low;
  eqMid = mid;
  eqHigh = high;
  markPlayerStateDirty();
}

void PlayerState::setBalance(int8_t value) {
  PlayerStateLock lock;
  if (!lock.ok()) return;

  value = constrain(value, -100, 100);
  if (balance == value) return;

  balance = value;
  markPlayerStateDirty();
}
