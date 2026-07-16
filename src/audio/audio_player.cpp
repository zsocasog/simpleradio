#include "audio_player.h"
#include "audio_meter.h"
#include "../artwork/artwork_cache.h"
#include "../state/player_state.h"
#include "../config/app_config.h"
#include "../config/logging.h"
#include "../config/pins.h"

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <WiFi.h>
#include <algorithm>
#include <ctype.h>

enum class QueuedAudioEventKind : uint8_t {
  Name,
  StreamTitle,
  Bitrate,
  IcyLogo,
  Info,
  Image
};

static constexpr size_t AUDIO_EVENT_TEXT_BYTES = 384;
static constexpr size_t AUDIO_EVENT_SEGMENT_VALUES = 16;
static constexpr uint8_t AUDIO_EVENT_QUEUE_LENGTH = 12;
static constexpr uint32_t AUDIO_LOOP_STALL_ABORT_US = 1800000;
static constexpr uint8_t AUDIO_LOOP_STALL_ABORT_COUNT = 3;
static constexpr BaseType_t AUDIO_PUMP_TASK_CORE = 1;
static constexpr BaseType_t AUDIO_DECODE_TASK_CORE = 0;
static constexpr UBaseType_t AUDIO_PUMP_TASK_PRIORITY = 2;
static constexpr uint32_t AUDIO_PUMP_TASK_STACK = 12288;

struct QueuedAudioEvent {
  QueuedAudioEventKind kind = QueuedAudioEventKind::Info;
  char text[AUDIO_EVENT_TEXT_BYTES] = {0};
  uint8_t segmentValues = 0;
  uint32_t segments[AUDIO_EVENT_SEGMENT_VALUES] = {0};
};

static QueueHandle_t audioEventQueue = nullptr;
static char lastQueuedName[AUDIO_EVENT_TEXT_BYTES] = {0};
static char lastQueuedIcyLogo[AUDIO_EVENT_TEXT_BYTES] = {0};
static char lastQueuedStreamTitle[AUDIO_EVENT_TEXT_BYTES] = {0};
static char lastQueuedBitrate[AUDIO_EVENT_TEXT_BYTES] = {0};
static char lastQueuedInfo[AUDIO_EVENT_TEXT_BYTES] = {0};

static void copyEventText(char* out, size_t outSize, const char* text) {
  if (!out || outSize == 0) return;
  out[0] = '\0';
  if (!text) return;

  snprintf(out, outSize, "%s", text);
}

static void enqueueAudioEvent(const QueuedAudioEvent& event) {
  if (!audioEventQueue) return;

  if (xQueueSend(audioEventQueue, &event, 0) == pdTRUE) return;

  QueuedAudioEvent discarded;
  xQueueReceive(audioEventQueue, &discarded, 0);
  xQueueSend(audioEventQueue, &event, 0);
}

static void enqueueTextEvent(QueuedAudioEventKind kind, const char* text) {
  QueuedAudioEvent event;
  event.kind = kind;
  copyEventText(event.text, sizeof(event.text), text);
  enqueueAudioEvent(event);
}

static bool sameTextEvent(const char* previous, const char* text) {
  if (!previous || !text) return false;
  return strncmp(previous, text, AUDIO_EVENT_TEXT_BYTES - 1) == 0;
}

static void rememberTextEvent(char* previous, const char* text) {
  if (!previous) return;
  copyEventText(previous, AUDIO_EVENT_TEXT_BYTES, text);
}

static void resetQueuedAudioEventCache() {
  lastQueuedName[0] = '\0';
  lastQueuedIcyLogo[0] = '\0';
  lastQueuedStreamTitle[0] = '\0';
  lastQueuedBitrate[0] = '\0';
  lastQueuedInfo[0] = '\0';
}

static void enqueueDedupedTextEvent(QueuedAudioEventKind kind, const char* text) {
  if (!text || !*text) return;

  char* previous = nullptr;
  if (kind == QueuedAudioEventKind::Name) {
    previous = lastQueuedName;
  } else if (kind == QueuedAudioEventKind::IcyLogo) {
    previous = lastQueuedIcyLogo;
  } else if (kind == QueuedAudioEventKind::StreamTitle) {
    previous = lastQueuedStreamTitle;
  } else if (kind == QueuedAudioEventKind::Bitrate) {
    previous = lastQueuedBitrate;
  } else if (kind == QueuedAudioEventKind::Info) {
    previous = lastQueuedInfo;
  }

  if (previous && sameTextEvent(previous, text)) return;
  if (previous) rememberTextEvent(previous, text);
  enqueueTextEvent(kind, text);
}

static bool containsIgnoreCase(const char* text, const char* needle) {
  if (!text || !needle || !*needle) return false;

  for (const char* start = text; *start; ++start) {
    const char* a = start;
    const char* b = needle;
    while (*a && *b && tolower(static_cast<unsigned char>(*a)) == tolower(static_cast<unsigned char>(*b))) {
      ++a;
      ++b;
    }
    if (!*b) return true;
  }
  return false;
}

static bool usefulInfoEvent(const char* text) {
  return containsIgnoreCase(text, "icy-logo:") ||
         containsIgnoreCase(text, "flac") ||
         containsIgnoreCase(text, "opus") ||
         containsIgnoreCase(text, "vorbis") ||
         containsIgnoreCase(text, "aac") ||
         containsIgnoreCase(text, "mpeg") ||
         containsIgnoreCase(text, "mp3") ||
         containsIgnoreCase(text, "ogg") ||
         containsIgnoreCase(text, "wav") ||
         containsIgnoreCase(text, "m4a") ||
         containsIgnoreCase(text, "codec");
}

static void enqueueImageEvent(const std::vector<uint32_t>& segments) {
  if (segments.size() < 2) return;

  QueuedAudioEvent event;
  event.kind = QueuedAudioEventKind::Image;
  event.segmentValues = std::min<size_t>(segments.size(), AUDIO_EVENT_SEGMENT_VALUES);
  for (uint8_t i = 0; i < event.segmentValues; ++i) {
    event.segments[i] = segments[i];
  }
  enqueueAudioEvent(event);
}

static void audioPumpTaskEntry(void* param) {
  AudioPlayer* player = static_cast<AudioPlayer*>(param);
  for (;;) {
    player->loop();
    vTaskDelay(pdMS_TO_TICKS(1));
  }
}

void AudioPlayer::applyVolumeCurve(const String& curve) {
  if (curve == lastVolumeCurve) return;
  lastVolumeCurve = curve;

  if (curve == "linear") {
    audio.setVolumeCurve([](float t) {
      return -60.0f + 60.0f * t;
    });
  } else if (curve == "log") {
    audio.setVolumeCurve([](float t) {
      return -60.0f + 60.0f * t * t;
    });
  } else {
    audio.setVolumeCurve(Audio::VolumeCurveFn());
  }
}

void AudioPlayer::applyProcessingSettings(const AppConfig& config, const PlayerStateSnapshot& state) {
  bool vuNeeded = config.displayFooterMode == "vu";
  if (vuNeeded != lastVuProcessing) {
    lastVuProcessing = vuNeeded;
    AudioMeter::instance().setEnabled(vuNeeded);
  }

  bool iirNeeded = state.eqLow != 0 || state.eqMid != 0 || state.eqHigh != 0;
  if (iirNeeded != lastIirProcessing) {
    lastIirProcessing = iirNeeded;
    audio.settings.IIR_FILTER = iirNeeded;
  }
}

static String inferCodecFromText(const char* raw) {
  if (!raw || !*raw) return "";

  String text(raw);
  text.toLowerCase();

  if (text.indexOf("flac") >= 0 || text.indexOf(".fla") >= 0) return "FLAC";
  if (text.indexOf("opus") >= 0) return "OPUS";
  if (text.indexOf("vorbis") >= 0) return "VORBIS";
  if (text.indexOf("aacp") >= 0 || text.indexOf("aac+") >= 0) return "AAC+";
  if (text.indexOf("audio/aac") >= 0 || text.indexOf(".aac") >= 0 || text.indexOf(" aac") >= 0) return "AAC";
  if (text.indexOf("audio/mpeg") >= 0 || text.indexOf("mpeg") >= 0 || text.indexOf("mp3") >= 0 || text.indexOf(".mp3") >= 0) return "MP3";
  if (text.indexOf("ogg") >= 0 || text.indexOf(".oga") >= 0) return "OGG";
  if (text.indexOf("wav") >= 0 || text.indexOf(".wav") >= 0) return "WAV";
  if (text.indexOf("m4a") >= 0 || text.indexOf("mp4") >= 0) return "M4A";
  return "";
}

static void updateCodecFromText(PlayerState& state, const char* text) {
  String codec = inferCodecFromText(text);
  if (codec.length()) state.setCodec(codec);
}

static String resolveStreamLogoUrl(const String& rawLogo, const String& streamUrl) {
  String logo = rawLogo;
  logo.trim();
  if (!logo.length()) return "";
  if (logo.startsWith("http://") || logo.startsWith("https://")) return logo;
  if (logo.startsWith("//")) {
    return String(streamUrl.startsWith("https://") ? "https:" : "http:") + logo;
  }

  int schemeEnd = streamUrl.indexOf("://");
  if (schemeEnd < 0) return logo;
  int hostStart = schemeEnd + 3;
  int pathStart = streamUrl.indexOf('/', hostStart);
  String origin = pathStart > 0 ? streamUrl.substring(0, pathStart) : streamUrl;
  if (logo.startsWith("/")) return origin + logo;

  String base = pathStart > 0 ? streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1) : origin + "/";
  return base + logo;
}

static void updateStreamLogo(PlayerState& state, const char* rawLogo) {
  PlayerStateSnapshot snapshot = state.snapshot();
  String logo = resolveStreamLogoUrl(rawLogo ? String(rawLogo) : "", snapshot.streamUrl);
  if (!logo.length()) return;
  if (logo == snapshot.streamLogoUrl) return;
  Serial.printf("[audio] icy logo: %s\n", logo.c_str());
  state.setStreamLogoUrl(logo);
}

static void audioInfo(Audio::msg_t m) {
  switch (m.e) {
    case Audio::evt_name:
      enqueueDedupedTextEvent(QueuedAudioEventKind::Name, m.msg);
      break;
    case Audio::evt_streamtitle:
      enqueueDedupedTextEvent(QueuedAudioEventKind::StreamTitle, m.msg);
      break;
    case Audio::evt_bitrate:
      enqueueDedupedTextEvent(QueuedAudioEventKind::Bitrate, m.msg);
      break;
    case Audio::evt_icylogo:
      enqueueDedupedTextEvent(QueuedAudioEventKind::IcyLogo, m.msg);
      break;
    case Audio::evt_image:
      enqueueImageEvent(m.vec);
      break;
    case Audio::evt_info:
    case Audio::evt_log:
      if (usefulInfoEvent(m.msg)) {
        enqueueDedupedTextEvent(QueuedAudioEventKind::Info, m.msg);
      }
      break;
    case Audio::evt_eof:
      break;
    default:
      break;
  }
}

void AudioPlayer::begin() {
  if (!audioEventQueue) {
    audioEventQueue = xQueueCreate(AUDIO_EVENT_QUEUE_LENGTH, sizeof(QueuedAudioEvent));
  }
  Audio::audio_info_callback = audioInfo;
  audio.setAudioTaskCore(AUDIO_DECODE_TASK_CORE);
  audio.settings.VU_LEVEL = false;
  audio.settings.IIR_FILTER = false;
  lastVuProcessing = false;
  lastIirProcessing = false;
  AudioMeter::instance().setEnabled(false);
  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
  audio.setConnectionTimeout(700, 2700);
  PlayerStateSnapshot s = PlayerState::instance().snapshot();
  AppConfig& config = AppConfig::instance();
  audio.setVolumeSteps(100);
  applyVolumeCurve(config.volumeCurve);
  audio.setTone(s.eqLow, s.eqMid, s.eqHigh);
  audio.setBalance(map(s.balance, -100, 100, -16, 16));
  audio.setVolume(s.volume);
  startTask();
}

void AudioPlayer::startTask() {
  if (taskStarted) return;

  BaseType_t ok = xTaskCreatePinnedToCore(
    audioPumpTaskEntry,
    "audio-pump",
    AUDIO_PUMP_TASK_STACK,
    this,
    AUDIO_PUMP_TASK_PRIORITY,
    &taskHandle,
    AUDIO_PUMP_TASK_CORE
  );

  if (ok == pdPASS) {
    taskStarted = true;
    Serial.printf("[audio] pump task started on core %d priority %u\n",
                  AUDIO_PUMP_TASK_CORE,
                  static_cast<unsigned>(AUDIO_PUMP_TASK_PRIORITY));
  } else {
    taskHandle = nullptr;
    Serial.println("[audio] pump task start failed, using main loop fallback");
  }
}

uint32_t AudioPlayer::retryDelayMs(const AppConfig& config) const {
  uint32_t base = max<uint32_t>(config.streamRetryMs, 1000);
  uint32_t multiplier = min<uint32_t>(static_cast<uint32_t>(connectFailureCount) + 1, 8);
  return min<uint32_t>(base * multiplier, 60000);
}

bool AudioPlayer::connectToStream(const String& url) {
  if (!url.length()) return false;

  if (!WiFi.isConnected()) {
    PlayerState::instance().setStreamConnectionState(StreamConnectionState::WaitingForNetwork, connectFailureCount);
    return false;
  }

  ArtworkCache::instance().notifyAudioConnectStarting();
  PlayerState::instance().setStreamConnectionState(StreamConnectionState::Connecting, connectFailureCount);
  resetQueuedAudioEventCache();
  updateCodecFromText(PlayerState::instance(), url.c_str());
  uint32_t startMs = millis();
  bool ok = audio.connecttohost(url.c_str());
  uint32_t durationMs = millis() - startMs;

  if (ok) {
    connectFailureCount = 0;
    PlayerState::instance().setStreamConnectionState(StreamConnectionState::Connected, 0);
    ArtworkCache::instance().notifyAudioConnectResult(true);
    Serial.printf("[audio] connect ok %lu ms: %s\n",
                  static_cast<unsigned long>(durationMs),
                  url.c_str());
  } else {
    ArtworkCache::instance().notifyAudioConnectResult(false);
    if (connectFailureCount < 10) ++connectFailureCount;
    PlayerState::instance().setStreamConnectionState(StreamConnectionState::RetryWaiting, connectFailureCount);
    Serial.printf("[audio] connect failed %lu ms, failures=%u: %s\n",
                  static_cast<unsigned long>(durationMs),
                  static_cast<unsigned>(connectFailureCount),
                  url.c_str());
  }

  return ok;
}

void AudioPlayer::loop() {
  if (!taskStarted) {
    service();
    return;
  }

  if (xTaskGetCurrentTaskHandle() == taskHandle) {
    service();
  }
}

void AudioPlayer::service() {
  processAudioEvents(4);
  PlayerStateSnapshot s = PlayerState::instance().snapshot();
  AppConfig& config = AppConfig::instance();
  bool streamControlOperation = false;
  bool wifiConnected = WiFi.isConnected();
  if (wifiConnected != lastWifiConnected) {
    lastWifiConnected = wifiConnected;
    if (!wifiConnected && s.playing) {
      audio.stopSong();
      lastRetryMs = millis();
      PlayerState::instance().setStreamConnectionState(StreamConnectionState::WaitingForNetwork, connectFailureCount);
    } else if (wifiConnected && s.playing && !audio.isRunning()) {
      lastRetryMs = millis() - retryDelayMs(config);
    }
  }

  if (s.playing != lastPlaying) {
    lastPlaying = s.playing;
    audioLoopStallCount = 0;
    if (s.playing && s.streamUrl.length()) {
      ArtworkCache::instance().cancelIdlePrewarm();
      lastStreamUrl = s.streamUrl;
      lastRetryMs = millis();
      streamControlOperation = true;
      if (wifiConnected) {
        connectToStream(s.streamUrl);
      } else {
        PlayerState::instance().setStreamConnectionState(StreamConnectionState::WaitingForNetwork, connectFailureCount);
      }
    } else {
      streamControlOperation = true;
      audio.stopSong();
      resetQueuedAudioEventCache();
      lastStreamUrl = "";
      lastCodecName[0] = '\0';
      connectFailureCount = 0;
      PlayerState::instance().setStreamConnectionState(StreamConnectionState::Idle, 0);
      audioLoopStallCount = 0;
      delay(50);
    }
  }

  if (s.playing && s.streamUrl.length() && s.streamUrl != lastStreamUrl) {
    streamControlOperation = true;
    audio.stopSong();
    delay(50);
    lastStreamUrl = s.streamUrl;
    lastCodecName[0] = '\0';
    audioLoopStallCount = 0;
    lastRetryMs = millis();
    ArtworkCache::instance().cancelIdlePrewarm();
    if (wifiConnected) {
      connectToStream(s.streamUrl);
    } else {
      PlayerState::instance().setStreamConnectionState(StreamConnectionState::WaitingForNetwork, connectFailureCount);
    }
  }

  applyProcessingSettings(config, s);
  applyVolumeCurve(config.volumeCurve);

  if (s.playing &&
      s.streamUrl.length() &&
      lastStreamUrl == s.streamUrl &&
      !audio.isRunning()) {
    if (!wifiConnected) {
      PlayerState::instance().setStreamConnectionState(StreamConnectionState::WaitingForNetwork, connectFailureCount);
    } else if (!config.streamRetryEnabled) {
      PlayerState::instance().setStreamConnectionState(StreamConnectionState::Failed, connectFailureCount);
    } else {
      PlayerState::instance().setStreamConnectionState(StreamConnectionState::RetryWaiting, connectFailureCount);
      unsigned long now = millis();
      if (now - lastRetryMs >= retryDelayMs(config)) {
        lastRetryMs = now;
        streamControlOperation = true;
        audio.stopSong();
        delay(20);
        audioLoopStallCount = 0;
        connectToStream(s.streamUrl);
      }
    }
  }

  if (s.volume != lastVolume) {
    lastVolume = s.volume;
    audio.setVolume(s.volume);
  }

  if (s.eqLow != lastEqLow || s.eqMid != lastEqMid || s.eqHigh != lastEqHigh) {
    lastEqLow = s.eqLow;
    lastEqMid = s.eqMid;
    lastEqHigh = s.eqHigh;
    audio.setTone(s.eqLow, s.eqMid, s.eqHigh);
  }

  if (s.balance != lastBalance) {
    lastBalance = s.balance;
    audio.setBalance(map(s.balance, -100, 100, -16, 16));
  }

  uint32_t audioLoopStartUs = micros();
  audio.loop();
  uint32_t audioLoopDurationUs = micros() - audioLoopStartUs;
  if (s.playing && !streamControlOperation && audioLoopDurationUs > AUDIO_LOOP_STALL_ABORT_US) {
    if (audioLoopStallCount < AUDIO_LOOP_STALL_ABORT_COUNT) ++audioLoopStallCount;
    Serial.printf("[audio] loop stall %lu ms (%u/%u)\n",
                  static_cast<unsigned long>(audioLoopDurationUs / 1000),
                  static_cast<unsigned>(audioLoopStallCount),
                  static_cast<unsigned>(AUDIO_LOOP_STALL_ABORT_COUNT));
    if (audioLoopStallCount >= AUDIO_LOOP_STALL_ABORT_COUNT) {
      abortStalledPlayback(audioLoopDurationUs);
      AudioMeter::instance().update(0, false);
    }
  } else {
    audioLoopStallCount = 0;
    const char* codecName = audio.getCodecname();
    if (s.playing &&
        codecName &&
        strcmp(codecName, "unknown") != 0 &&
        strncmp(lastCodecName, codecName, sizeof(lastCodecName)) != 0) {
      snprintf(lastCodecName, sizeof(lastCodecName), "%s", codecName);
      PlayerState::instance().setCodec(codecName);
    }
    if (!lastVuProcessing || !s.playing || !audio.isRunning()) {
      AudioMeter::instance().update(0, false);
    }
  }
  processAudioEvents(8);
}

void AudioPlayer::processAudioEvents(uint8_t maxEvents) {
  if (!audioEventQueue) return;

  PlayerState& state = PlayerState::instance();
  QueuedAudioEvent event;
  uint8_t processed = 0;

  while (processed < maxEvents && xQueueReceive(audioEventQueue, &event, 0) == pdTRUE) {
    ++processed;
    switch (event.kind) {
      case QueuedAudioEventKind::Name:
        state.setStationName(event.text);
        break;

      case QueuedAudioEventKind::StreamTitle:
        state.setStreamTitle(event.text);
        break;

      case QueuedAudioEventKind::Bitrate:
        state.setBitrate(event.text);
        break;

      case QueuedAudioEventKind::IcyLogo:
        updateStreamLogo(state, event.text);
        break;

      case QueuedAudioEventKind::Image: {
        std::vector<uint32_t> segments;
        segments.reserve(event.segmentValues);
        for (uint8_t i = 0; i < event.segmentValues; ++i) {
          segments.push_back(event.segments[i]);
        }
        ArtworkCache::instance().requestEmbeddedImage(state.snapshot().streamUrl, segments);
        break;
      }

      case QueuedAudioEventKind::Info:
      default: {
        String info(event.text);
        info.trim();
        if (info.startsWith("icy-logo:")) {
          updateStreamLogo(state, info.substring(9).c_str());
        }
        updateCodecFromText(state, event.text);
        break;
      }
    }
  }
}

void AudioPlayer::abortStalledPlayback(uint32_t durationUs) {
  uint32_t durationMs = durationUs / 1000;
  Serial.printf("[audio] loop stall %lu ms, stopping stream\n", static_cast<unsigned long>(durationMs));
  audio.stopSong();
  lastPlaying = false;
  lastStreamUrl = "";
  lastCodecName[0] = '\0';
  lastRetryMs = millis();

  JsonDocument cmd;
  cmd["play"] = false;
  PlayerState::instance().applyCommand(cmd);
}



