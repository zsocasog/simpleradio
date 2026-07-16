#pragma once
#include <Arduino.h>
#include <Audio.h>
#include "../state/player_state.h"

class AppConfig;

class AudioPlayer {
public:
    void begin();
    void loop();

private:
    void startTask();
    void service();
    bool connectToStream(const String& url);
    uint32_t retryDelayMs(const AppConfig& config) const;
    void applyVolumeCurve(const String& curve);
    void applyProcessingSettings(const AppConfig& config, const PlayerStateSnapshot& state);
    void processAudioEvents(uint8_t maxEvents);
    void abortStalledPlayback(uint32_t durationUs);
    Audio audio;
    TaskHandle_t taskHandle = nullptr;
    bool taskStarted = false;
    bool lastPlaying = false;
    bool lastWifiConnected = false;
    uint8_t lastVolume = 5;
    String lastStreamUrl;
    char lastCodecName[12] = "";
    uint8_t connectFailureCount = 0;
    uint8_t audioLoopStallCount = 0;
    int8_t lastEqLow = 127;
    int8_t lastEqMid = 127;
    int8_t lastEqHigh = 127;
    int8_t lastBalance = 127;
    String lastVolumeCurve;
    bool lastVuProcessing = true;
    bool lastIirProcessing = true;
    unsigned long lastRetryMs = 0;
};
