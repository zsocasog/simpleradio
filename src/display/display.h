#pragma once

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include "display_model.h"
#include "display_presenter.h"

class Display {
public:
  static Display& instance();

  void begin();
  void showBootProgress(uint8_t progress);
  void finishBoot();
  void render(const DisplayModel& model);
  void tick();
  void applyConfig();
  void showStationPicker(int selectedStationId);
  void hideStationPicker();
  void notifyActivity();
  void refreshArtwork();
  bool isVolumeScreenActive() const;
  void taskLoop();

private:
  Display() = default;

  void startTask();
  void showBootProgressNow(uint8_t progress);
  void finishBootNow();
  void renderNow(const DisplayModel& model);
  void tickNow();
  void applyConfigNow();
  void showStationPickerNow(int selectedStationId);
  void hideStationPickerNow();
  void notifyActivityNow();
  void refreshArtworkNow();
  void renderCurrent();
  void renderPartial(const DisplayModel& previous, bool footerModeChanged);
  void renderIdleClock(bool force = false);
  void renderAudioMeterFrame(bool force = false);
  void renderDateTimeFooterFrame(bool force = false);
  void renderVolumePopupFrame(bool forceFull = false);
  void dismissVolumePopupNow();
  void resetStationPickerMarqueeNow(int selectedStationId);
  void renderStationPickerMarqueeFrame();
  String artRenderKeyFor(const DisplayModel& model) const;
  void drawArtIfNeeded(const DisplayModel& model, bool force = false);

  SemaphoreHandle_t pendingMutex = nullptr;
  TaskHandle_t taskHandle = nullptr;
  bool taskStarted = false;
  DisplayModel pendingModel;
  bool hasPendingModel = false;
  bool pendingConfigApply = false;
  bool pendingActivity = false;
  bool pendingArtworkRefresh = false;
  bool deferredArtworkRefresh = false;
  int pendingBootProgress = -1;
  bool pendingBootFinish = false;
  int pendingPickerAction = 0;
  int pendingPickerStationId = -1;
  DisplayModel lastModel;
  DisplayModel deferredBootModel;
  bool hasDeferredBootModel = false;
  bool bootActive = false;
  bool bootFinishRequested = false;
  uint8_t bootProgress = 0;
  uint8_t bootProgressTarget = 0;
  unsigned long lastBootFrameMs = 0;
  unsigned long bootFullSinceMs = 0;
  unsigned long lastTickMs = 0;
  uint8_t lastBrightness = 255;
  bool lastInvert = false;
  String lastThemeAccent;
  String lastThemeCustomColor;
  bool stationPickerActive = false;
  int stationPickerSelectedId = -1;
  int stationPickerWindowStart = -1;
  int stationPickerRenderedSelectedId = -1;
  int stationPickerMarqueeSelectedId = -1;
  int stationPickerMarqueeOffset = 0;
  int stationPickerMarqueeDirection = 1;
  unsigned long stationPickerMarqueeLastMs = 0;
  unsigned long stationPickerMarqueeHoldUntil = 0;
  unsigned long lastActivityMs = 0;
  bool idleBlanked = false;
  bool idleGuardBlanked = false;
  unsigned long idleGuardLastMs = 0;
  unsigned long idleGuardRestoreMs = 0;
  bool hasRenderedModel = false;
  String lastRenderedArtKey;
  uint8_t lastFooterMode = 255;
  unsigned long volumePopupUntil = 0;
  uint8_t popupVolume = 0;
  uint8_t renderedPopupVolume = 255;
  bool volumePopupDrawn = false;
  bool volumePopupDirty = false;
  unsigned long lastVolumePopupDrawMs = 0;
  bool idleClockActive = false;
  unsigned long lastMeterRenderMs = 0;
  int lastClockStamp = -1;
  int lastClockMinuteStamp = -1;
  String lastClockStyle;
};
