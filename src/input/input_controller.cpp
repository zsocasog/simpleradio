#include "input_controller.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "../config/app_config.h"
#include "../config/hardware_capabilities.h"
#include "../config/pins.h"
#include "../artwork/artwork_cache.h"
#include "../display/display.h"
#include "../display/display_presenter.h"
#include "../state/player_state.h"
#include "../stations/station_manager.h"
#include "../web/web_server.h"

static constexpr unsigned long IR_STATION_NUMBER_TIMEOUT_MS = 1200;
static constexpr BaseType_t INPUT_TASK_CORE = 1;
static constexpr UBaseType_t INPUT_TASK_PRIORITY = 2;
static constexpr uint32_t INPUT_TASK_STACK = 6144;
static constexpr TickType_t INPUT_TASK_DELAY = pdMS_TO_TICKS(2);

#if IR_PIN >= 0
#include <IRrecv.h>
#include <IRremoteESP8266.h>
#include <IRutils.h>

static constexpr uint16_t IR_CAPTURE_BUFFER_SIZE = 128;
static constexpr uint8_t IR_CAPTURE_TIMEOUT_MS = 80;
static constexpr uint16_t IR_MIN_UNKNOWN_SIZE = 12;
static constexpr unsigned long IR_LEARNING_ARM_MS = 300;
static constexpr unsigned long IR_REPEAT_WINDOW_MS = 800;
static constexpr unsigned long IR_COMMAND_GUARD_MS = 160;

static IRrecv irrecv(IR_PIN, IR_CAPTURE_BUFFER_SIZE, IR_CAPTURE_TIMEOUT_MS, true);
static decode_results irResults;
static uint64_t lastIrCode = 0;
static unsigned long lastIrCodeMs = 0;
static uint64_t lastHandledIrCode = 0;
static unsigned long lastHandledIrMs = 0;
static String lastLearningAction;
static unsigned long learningStartedMs = 0;
static uint8_t appliedIrSensitivity = 0;
#endif

struct EncoderRuntime {
  portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
  volatile long rawPosition = 0;
  volatile uint8_t oldAB = 0;
  long lastReadPosition = 0;
  int8_t detentAccumulator = 0;
  bool lastButton = true;
  unsigned long lastButtonMs = 0;
  bool buttonDown = false;
  bool longReported = false;
  unsigned long buttonDownMs = 0;
};

static EncoderRuntime enc1;
static EncoderRuntime enc2;
static int mutedVolume = -1;
static bool stationPickerActive = false;
static int stationPickerIndex = -1;
static unsigned long stationPickerChangedMs = 0;
static unsigned long stationPickerOpenedMs = 0;
static int pendingVolumeTarget = -1;
static unsigned long pendingVolumeTargetMs = 0;
static uint16_t irStationNumberBuffer = 0;
static uint8_t irStationNumberDigits = 0;
static unsigned long irStationNumberMs = 0;
static TaskHandle_t inputTaskHandle = nullptr;
static bool inputTaskStarted = false;

static DRAM_ATTR const int8_t ENCODER_STATES[16] = {
  0, -1, 1, 0,
  1, 0, 0, -1,
  -1, 0, 0, 1,
  0, 1, -1, 0
};

enum class ButtonEvent {
  None,
  ShortPress,
  LongPress
};

InputController& InputController::instance() {
  static InputController controller;
  return controller;
}

static void inputTaskEntry(void*) {
  for (;;) {
    InputController::instance().loop();
    vTaskDelay(INPUT_TASK_DELAY);
  }
}

static void applyCommand(JsonDocument& cmd) {
  Display::instance().notifyActivity();
  int preparedStationId = -1;
  String preparedArtworkPath;
  bool shouldDeferPlayback = false;
  bool changed = false;
  if (cmd["play"].is<bool>()) {
    if (!cmd["play"].as<bool>()) {
      ArtworkCache::instance().cancelPendingPlayback();
    } else {
      PlayerStateSnapshot state = PlayerState::instance().snapshot();
      preparedStationId = cmd["station"].is<int>() ? cmd["station"].as<int>() : state.stationId;
      bool artworkReady = preparedStationId >= 0 &&
                          ArtworkCache::instance().stationArtworkReady(preparedStationId, &preparedArtworkPath);
      ArtworkCache::instance().cancelPendingPlayback();
      bool switchingStation = state.playing &&
                              cmd["station"].is<int>() &&
                              preparedStationId >= 0 &&
                              preparedStationId != state.stationId;
      if (switchingStation && !artworkReady) {
        Display::instance().notifyActivity();
        JsonDocument stopCmd;
        stopCmd["play"] = false;
        changed |= PlayerState::instance().applyCommand(stopCmd);
        Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
        vTaskDelay(pdMS_TO_TICKS(80));
        state = PlayerState::instance().snapshot();
      }

      // Audio playback must not wait for a remote logo or its LCD thumbnail.
      // Artwork continues in the background and updates the display when ready.
      shouldDeferPlayback = false;
      if (shouldDeferPlayback) cmd["play"] = false;
    }
  }

  changed |= PlayerState::instance().applyCommand(cmd);

  if (shouldDeferPlayback && !ArtworkCache::instance().deferStationPlayback(preparedStationId)) {
    JsonDocument resumeCmd;
    resumeCmd["play"] = true;
    changed |= PlayerState::instance().applyCommand(resumeCmd);
  }

  if (preparedStationId >= 0 && preparedArtworkPath.length()) {
    PlayerStateSnapshot state = PlayerState::instance().snapshot();
    if (state.stationId == preparedStationId && state.cachedArtworkPath != preparedArtworkPath) {
      PlayerState::instance().setCachedArtworkPath(preparedArtworkPath);
      Display::instance().render(DisplayPresenter::build(PlayerState::instance()));
      changed = true;
    }
  }

  if (changed) {
    requestStateSave();
  }
}

static void stationOffset(int offset) {
  int nextId = -1;
  PlayerStateSnapshot state = PlayerState::instance().snapshot();
  if (!StationManager::instance().stationIdRelative(state.stationId, offset, nextId)) return;

  JsonDocument cmd;
  cmd["station"] = nextId;
  cmd["play"] = true;
  applyCommand(cmd);
}

static void volumeOffset(int delta) {
  JsonDocument cmd;
  PlayerStateSnapshot state = PlayerState::instance().snapshot();
  int baseVolume = pendingVolumeTarget >= 0 ? pendingVolumeTarget : state.volume;
  int nextVolume = constrain(baseVolume + delta, 0, 100);
  if (nextVolume == baseVolume && nextVolume == state.volume) return;
  pendingVolumeTarget = nextVolume;
  pendingVolumeTargetMs = millis();
  cmd["volume"] = nextVolume;
  applyCommand(cmd);
}

static void togglePlay() {
  JsonDocument cmd;
  cmd["play"] = !PlayerState::instance().snapshot().playing;
  applyCommand(cmd);
}

static void stopPlayback() {
  JsonDocument cmd;
  cmd["play"] = false;
  applyCommand(cmd);
}

static void toggleMute() {
  PlayerStateSnapshot state = PlayerState::instance().snapshot();
  JsonDocument cmd;

  if (state.volume > 0) {
    mutedVolume = state.volume;
    cmd["volume"] = 0;
  } else {
    cmd["volume"] = mutedVolume > 0 ? mutedVolume : 30;
  }

  applyCommand(cmd);
}

static void cycleDisplayFooterView() {
  AppConfig& config = AppConfig::instance();

  if (config.displayFooterModeId == DisplayFooterMode::Off) {
    config.displayFooterMode = "station";
    config.displayFooterModeId = DisplayFooterMode::Station;
  } else if (config.displayFooterModeId == DisplayFooterMode::Station) {
    config.displayFooterMode = "datetime";
    config.displayFooterModeId = DisplayFooterMode::DateTime;
  } else if (config.displayFooterModeId == DisplayFooterMode::DateTime) {
    config.displayFooterMode = "vu";
    config.displayFooterModeId = DisplayFooterMode::Vu;
    config.displayVuStyle = "bars";
    config.displayVuStyleId = DisplayVuStyle::Bars;
  } else if (config.displayFooterModeId == DisplayFooterMode::Vu &&
             config.displayVuStyleId == DisplayVuStyle::Bars) {
    config.displayVuStyle = "symmetric";
    config.displayVuStyleId = DisplayVuStyle::Symmetric;
  } else if (config.displayFooterModeId == DisplayFooterMode::Vu &&
             config.displayVuStyleId == DisplayVuStyle::Symmetric) {
    config.displayVuStyle = "classic";
    config.displayVuStyleId = DisplayVuStyle::Classic;
  } else {
    config.displayFooterMode = "off";
    config.displayFooterModeId = DisplayFooterMode::Off;
    config.displayVuStyle = "bars";
    config.displayVuStyleId = DisplayVuStyle::Bars;
  }

  config.save();
  Display::instance().notifyActivity();
  Display::instance().applyConfig();
}

static void playStationIndex(size_t index) {
  int stationId = -1;
  if (!StationManager::instance().stationIdAtIndex(index, stationId)) return;

  JsonDocument cmd;
  cmd["station"] = stationId;
  cmd["play"] = true;
  applyCommand(cmd);
}

static void playStationNumber(uint16_t number) {
  if (number == 0) return;
  playStationIndex(static_cast<size_t>(number - 1));
}

static uint64_t* irSlot(AppConfig& config, const String& action) {
  if (action == "prev") return &config.irPrev;
  if (action == "next") return &config.irNext;
  if (action == "toggle") return &config.irToggle;
  if (action == "volUp") return &config.irVolUp;
  if (action == "volDown") return &config.irVolDown;
  if (action == "mute") return &config.irMute;
  if (action == "power") return &config.irPower;
  if (action == "up") return &config.irUp;
  if (action == "down") return &config.irDown;
  if (action == "left") return &config.irLeft;
  if (action == "right") return &config.irRight;
  if (action == "ok") return &config.irOk;
  if (action == "list") return &config.irList;
  if (action == "back") return &config.irBack;
  if (action == "digit0") return &config.irDigit0;
  if (action == "digit1") return &config.irDigit1;
  if (action == "digit2") return &config.irDigit2;
  if (action == "digit3") return &config.irDigit3;
  if (action == "digit4") return &config.irDigit4;
  if (action == "digit5") return &config.irDigit5;
  if (action == "digit6") return &config.irDigit6;
  if (action == "digit7") return &config.irDigit7;
  if (action == "digit8") return &config.irDigit8;
  if (action == "digit9") return &config.irDigit9;
  if (action == "star") return &config.irStar;
  if (action == "hash") return &config.irHash;
  if (action == "station1") return &config.irStation1;
  if (action == "station2") return &config.irStation2;
  if (action == "station3") return &config.irStation3;
  if (action == "station4") return &config.irStation4;
  if (action == "station5") return &config.irStation5;
  return nullptr;
}

static int currentStationIndex() {
  PlayerStateSnapshot state = PlayerState::instance().snapshot();
  int index = StationManager::instance().indexOfStation(state.stationId);
  return index >= 0 ? index : 0;
}

static void openStationPicker() {
  size_t stationCount = StationManager::instance().count();
  if (!stationCount) return;

  stationPickerActive = true;
  stationPickerIndex = currentStationIndex();
  stationPickerOpenedMs = millis();
  stationPickerChangedMs = 0;

  int stationId = -1;
  StationManager::instance().stationIdAtIndex(stationPickerIndex, stationId);
  Display::instance().showStationPicker(stationId);
}

static void closeStationPicker() {
  stationPickerActive = false;
  Display::instance().hideStationPicker();
}

static void moveStationPicker(int direction) {
  size_t stationCount = StationManager::instance().count();
  if (!stationCount) return;

  if (!stationPickerActive) openStationPicker();
  stationPickerIndex += direction;
  while (stationPickerIndex < 0) stationPickerIndex += static_cast<int>(stationCount);
  stationPickerIndex = stationPickerIndex % static_cast<int>(stationCount);
  stationPickerChangedMs = millis();

  int stationId = -1;
  StationManager::instance().stationIdAtIndex(stationPickerIndex, stationId);
  Display::instance().showStationPicker(stationId);
}

static void playPickedStation() {
  if (!stationPickerActive || stationPickerIndex < 0) return;
  playStationIndex(stationPickerIndex);
  closeStationPicker();
}

static int8_t readEncoderState(uint8_t pinA, uint8_t pinB) {
  return (digitalRead(pinA) ? 2 : 0) | (digitalRead(pinB) ? 1 : 0);
}

static void IRAM_ATTR readEncoderIsr(EncoderRuntime& runtime, uint8_t pinA, uint8_t pinB) {
  uint8_t state = (digitalRead(pinA) ? 2 : 0) | (digitalRead(pinB) ? 1 : 0);

  portENTER_CRITICAL_ISR(&runtime.mux);
  runtime.oldAB <<= 2;
  runtime.oldAB |= (state & 0x03);
  int8_t direction = ENCODER_STATES[runtime.oldAB & 0x0F];
  if (direction) runtime.rawPosition += direction;
  portEXIT_CRITICAL_ISR(&runtime.mux);
}

static int8_t readEncoderDelta(EncoderRuntime& runtime) {
  long rawPosition = 0;
  portENTER_CRITICAL(&runtime.mux);
  rawPosition = runtime.rawPosition;
  portEXIT_CRITICAL(&runtime.mux);

  long logicalPosition = rawPosition / 4;
  long delta = logicalPosition - runtime.lastReadPosition;
  runtime.lastReadPosition = logicalPosition;

  if (delta > 12) return 12;
  if (delta < -12) return -12;
  return static_cast<int8_t>(delta);
}

static int8_t applyEncoderSensitivity(EncoderRuntime& runtime, int8_t rawStep, uint8_t sensitivity) {
  if (rawStep == 0) return 0;

  uint8_t clampedSensitivity = constrain(sensitivity, 1, 8);
  uint8_t detentsPerAction = 9 - clampedSensitivity;
  if (detentsPerAction <= 1) return rawStep;

  if ((runtime.detentAccumulator > 0 && rawStep < 0) || (runtime.detentAccumulator < 0 && rawStep > 0)) {
    runtime.detentAccumulator = 0;
  }

  runtime.detentAccumulator += rawStep;
  int8_t actions = runtime.detentAccumulator / static_cast<int8_t>(detentsPerAction);
  runtime.detentAccumulator = runtime.detentAccumulator % static_cast<int8_t>(detentsPerAction);
  return actions;
}

static bool buttonClicked(EncoderRuntime& runtime, uint8_t pin) {
  if (pin == static_cast<uint8_t>(-1)) return false;

  bool current = digitalRead(pin);
  unsigned long now = millis();
  bool clicked = false;

  if (runtime.lastButton && !current && now - runtime.lastButtonMs > 180) {
    clicked = true;
    runtime.lastButtonMs = now;
  }

  runtime.lastButton = current;
  return clicked;
}

static ButtonEvent readButtonEvent(EncoderRuntime& runtime, uint8_t pin, uint16_t longPressMs) {
  if (pin == static_cast<uint8_t>(-1)) return ButtonEvent::None;

  bool released = digitalRead(pin);
  unsigned long now = millis();
  ButtonEvent event = ButtonEvent::None;

  if (!released && runtime.lastButton) {
    runtime.buttonDown = true;
    runtime.longReported = false;
    runtime.buttonDownMs = now;
  }

  if (!released && runtime.buttonDown && !runtime.longReported && now - runtime.buttonDownMs >= longPressMs) {
    runtime.longReported = true;
    event = ButtonEvent::LongPress;
  }

  if (released && !runtime.lastButton) {
    if (runtime.buttonDown && !runtime.longReported && now - runtime.buttonDownMs > 40) {
      event = ButtonEvent::ShortPress;
    }
    runtime.buttonDown = false;
    runtime.longReported = false;
    runtime.lastButtonMs = now;
  }

  runtime.lastButton = released;
  return event;
}

static bool suppressEncoderButtonOnVolumeScreen(EncoderRuntime& runtime, uint8_t pin) {
  if (pin == static_cast<uint8_t>(-1) || !Display::instance().isVolumeScreenActive()) return false;

  bool released = digitalRead(pin);
  runtime.buttonDown = false;
  runtime.longReported = false;
  runtime.lastButton = released;
  runtime.lastButtonMs = millis();
  return true;
}

#if ENC1_A >= 0 && ENC1_B >= 0
static void IRAM_ATTR readEncoder1ISR() {
  readEncoderIsr(enc1, ENC1_A, ENC1_B);
}
#endif

#if ENC2_A >= 0 && ENC2_B >= 0
static void IRAM_ATTR readEncoder2ISR() {
  readEncoderIsr(enc2, ENC2_A, ENC2_B);
}
#endif

static void beginEncoder(uint8_t pinA, uint8_t pinB, uint8_t pinSw, EncoderRuntime& runtime) {
  if (pinA == static_cast<uint8_t>(-1) || pinB == static_cast<uint8_t>(-1)) return;

  pinMode(pinA, INPUT_PULLUP);
  pinMode(pinB, INPUT_PULLUP);
  if (pinSw != static_cast<uint8_t>(-1)) pinMode(pinSw, INPUT_PULLUP);

  runtime.oldAB = (digitalRead(pinA) ? 2 : 0) | (digitalRead(pinB) ? 1 : 0);
  runtime.rawPosition = 0;
  runtime.lastReadPosition = 0;
  runtime.detentAccumulator = 0;
}

static void loopEncoderOne() {
#if ENC1_A >= 0 && ENC1_B >= 0
  AppConfig& config = AppConfig::instance();
  bool singleEncoderMode = !HardwareCapabilities::encoder2Available || !config.secondEncoderEnabled;
  int8_t step = applyEncoderSensitivity(enc1, readEncoderDelta(enc1), config.encoderSensitivity);
  if (step != 0) {
    if (singleEncoderMode && stationPickerActive) {
      int count = abs(step);
      while (count-- > 0) moveStationPicker(step > 0 ? 1 : -1);
    } else {
      volumeOffset(step * config.encoderVolumeStep);
    }
  }

#if ENC1_SW >= 0
  if (!suppressEncoderButtonOnVolumeScreen(enc1, ENC1_SW)) {
    ButtonEvent button = readButtonEvent(enc1, ENC1_SW, config.encoderLongPressMs);
    if (singleEncoderMode && button == ButtonEvent::LongPress) {
      if (!stationPickerActive) {
        openStationPicker();
      }
    } else if (button == ButtonEvent::ShortPress) {
      if (singleEncoderMode && stationPickerActive) {
        playPickedStation();
      } else {
        togglePlay();
      }
    }
  }
#endif

  if (singleEncoderMode && stationPickerActive && config.encoderAutoPlayStation) {
    unsigned long now = millis();
    if (stationPickerChangedMs &&
        now - stationPickerOpenedMs >= config.encoderLongPressMs &&
        now - stationPickerChangedMs >= config.encoderAutoPlayMs) {
      playPickedStation();
    }
  }
#endif
}

static void loopEncoderTwo() {
#if ENC2_A >= 0 && ENC2_B >= 0
  int8_t step = applyEncoderSensitivity(enc2, readEncoderDelta(enc2), AppConfig::instance().encoderSensitivity);
  if (step != 0) {
    int count = abs(step);
    while (count-- > 0) stationOffset(step > 0 ? 1 : -1);
  }

#if ENC2_SW >= 0
  if (!suppressEncoderButtonOnVolumeScreen(enc2, ENC2_SW) && buttonClicked(enc2, ENC2_SW)) {
    togglePlay();
  }
#endif
#endif
}

static int8_t irDigitValue(const String& action) {
  if (action.length() != 6 || !action.startsWith("digit")) return -1;
  char digit = action.charAt(5);
  return digit >= '0' && digit <= '9' ? digit - '0' : -1;
}

static void clearIrStationNumberInput() {
  irStationNumberBuffer = 0;
  irStationNumberDigits = 0;
  irStationNumberMs = 0;
}

static void commitIrStationNumberInput() {
  if (!irStationNumberDigits) return;

  uint16_t stationNumber = irStationNumberBuffer;

  clearIrStationNumberInput();
  if (stationPickerActive) closeStationPicker();
  playStationNumber(stationNumber);
}

static bool irStationNumberCanGrow() {
  if (!irStationNumberDigits || irStationNumberDigits >= 3) return false;
  size_t stationCount = StationManager::instance().count();
  if (stationCount == 0 || stationCount > 999) stationCount = 999;

  if (irStationNumberDigits == 1 && irStationNumberBuffer == 0) {
    return stationCount >= 1;
  }

  uint16_t nextPrefixMin = irStationNumberBuffer * 10;
  return nextPrefixMin <= stationCount;
}

static void appendIrStationDigit(uint8_t digit) {
  unsigned long now = millis();
  if (irStationNumberDigits && now - irStationNumberMs > IR_STATION_NUMBER_TIMEOUT_MS) {
    commitIrStationNumberInput();
  }

  if (irStationNumberDigits >= 3) {
    clearIrStationNumberInput();
  }

  irStationNumberBuffer = irStationNumberBuffer * 10 + digit;
  irStationNumberDigits++;
  irStationNumberMs = now;

  if (irStationNumberDigits >= 3 || !irStationNumberCanGrow()) {
    commitIrStationNumberInput();
  }
}

static void loopIrStationNumberInput() {
  if (irStationNumberDigits && millis() - irStationNumberMs > IR_STATION_NUMBER_TIMEOUT_MS) {
    commitIrStationNumberInput();
  }
}

static void applyIrAction(const String& action) {
  int8_t digit = irDigitValue(action);
  if (digit >= 0) {
    appendIrStationDigit(static_cast<uint8_t>(digit));
    return;
  }

  if (irStationNumberDigits) {
    if (action == "toggle" || action == "ok") {
      commitIrStationNumberInput();
      return;
    }
    clearIrStationNumberInput();
  }

  if (stationPickerActive) {
    if (action == "down" || action == "right" || action == "next") {
      moveStationPicker(1);
      return;
    }
    if (action == "up" || action == "left" || action == "prev") {
      moveStationPicker(-1);
      return;
    }
    if (action == "toggle" || action == "ok") {
      playPickedStation();
      return;
    }
    if (action == "back" || action == "list" || action == "hash") {
      closeStationPicker();
      return;
    }
  }

  if (action == "prev") {
    stationOffset(-1);
  } else if (action == "next") {
    stationOffset(1);
  } else if (action == "toggle") {
    togglePlay();
  } else if (action == "volUp") {
    volumeOffset(2);
  } else if (action == "volDown") {
    volumeOffset(-2);
  } else if (action == "up") {
    stationOffset(1);
  } else if (action == "down") {
    stationOffset(-1);
  } else if (action == "left") {
    stationOffset(-1);
  } else if (action == "right") {
    stationOffset(1);
  } else if (action == "ok") {
    if (stationPickerActive) {
      playPickedStation();
    } else {
      togglePlay();
    }
  } else if (action == "list") {
    openStationPicker();
  } else if (action == "back") {
    closeStationPicker();
  } else if (action == "mute") {
    cycleDisplayFooterView();
  } else if (action == "power") {
    stopPlayback();
  } else if (action == "station1") {
    playStationIndex(0);
  } else if (action == "station2") {
    playStationIndex(1);
  } else if (action == "station3") {
    playStationIndex(2);
  } else if (action == "station4") {
    playStationIndex(3);
  } else if (action == "station5") {
    playStationIndex(4);
  } else if (action == "star") {
    toggleMute();
  } else if (action == "hash") {
    stopPlayback();
  }
}

static bool updateIrLearningWindow(const String& action) {
#if IR_PIN >= 0
  if (action != lastLearningAction) {
    lastLearningAction = action;
    learningStartedMs = action.length() ? millis() : 0;
    return true;
  }
#endif
  return false;
}

#if IR_PIN >= 0
static void applyIrSensitivity(const AppConfig& config) {
  uint8_t sensitivity = constrain(config.irSensitivity, 15, 60);
  if (appliedIrSensitivity == sensitivity) return;
  irrecv.setTolerance(sensitivity);
  appliedIrSensitivity = sensitivity;
}

static bool validIrFrame(const decode_results& result) {
  if (result.overflow) return false;
  if (result.decode_type == UNKNOWN || result.decode_type == UNUSED) return false;
  if (result.repeat) return result.rawlen >= 4 && lastIrCode != 0 && millis() - lastIrCodeMs <= IR_REPEAT_WINDOW_MS;
  if (result.rawlen < 12) return false;
  if (result.bits < 12) return false;
  if (result.value == 0xFFFFFFFFFFFFFFFFULL || result.value < 256) return false;
  return true;
}

static bool decodedIrCode(const decode_results& result, uint64_t& code, bool& repeat) {
  if (!validIrFrame(result)) return false;

  repeat = result.repeat;
  if (repeat) {
    code = lastIrCode;
    return code != 0;
  }

  code = result.value;
  lastIrCode = code;
  lastIrCodeMs = millis();
  return true;
}
#endif

static void handleIrCode(uint64_t code, bool repeat) {
  AppConfig& config = AppConfig::instance();
  updateIrLearningWindow(config.irActionLearning);

  if (config.irActionLearning.length()) {
    if (repeat) return;
#if IR_PIN >= 0
    if (learningStartedMs && millis() - learningStartedMs < IR_LEARNING_ARM_MS) return;
#endif
    uint64_t* slot = irSlot(config, config.irActionLearning);
    if (slot) *slot = code;
    config.irActionLearning = "";
    config.save();
    return;
  }

  unsigned long now = millis();
  if (code == lastHandledIrCode && now - lastHandledIrMs < IR_COMMAND_GUARD_MS) return;
  lastHandledIrCode = code;
  lastHandledIrMs = now;

  const char* actions[] = {
    "prev", "next", "toggle", "volUp", "volDown", "mute", "power",
    "up", "down", "left", "right", "ok", "list", "back",
    "digit0", "digit1", "digit2", "digit3", "digit4", "digit5", "digit6", "digit7", "digit8", "digit9",
    "star", "hash", "station1", "station2", "station3", "station4", "station5"
  };

  for (const char* action : actions) {
    uint64_t* slot = irSlot(config, action);
    if (slot && *slot && code == *slot) {
      applyIrAction(action);
      return;
    }
  }
}

void InputController::begin() {
#if ENC1_A >= 0 && ENC1_B >= 0
  beginEncoder(ENC1_A, ENC1_B, ENC1_SW, enc1);
  attachInterrupt(digitalPinToInterrupt(ENC1_A), readEncoder1ISR, CHANGE);
  attachInterrupt(digitalPinToInterrupt(ENC1_B), readEncoder1ISR, CHANGE);
#endif
#if ENC2_A >= 0 && ENC2_B >= 0
  beginEncoder(ENC2_A, ENC2_B, ENC2_SW, enc2);
  attachInterrupt(digitalPinToInterrupt(ENC2_A), readEncoder2ISR, CHANGE);
  attachInterrupt(digitalPinToInterrupt(ENC2_B), readEncoder2ISR, CHANGE);
#endif

#if IR_PIN >= 0
  pinMode(IR_PIN, INPUT_PULLUP);
#if DECODE_HASH
  irrecv.setUnknownThreshold(IR_MIN_UNKNOWN_SIZE);
#endif
  applyIrSensitivity(AppConfig::instance());
  irrecv.enableIRIn(true);
#endif

  if (!inputTaskStarted) {
    BaseType_t ok = xTaskCreatePinnedToCore(
      inputTaskEntry,
      "input",
      INPUT_TASK_STACK,
      nullptr,
      INPUT_TASK_PRIORITY,
      &inputTaskHandle,
      INPUT_TASK_CORE
    );
    if (ok == pdPASS) {
      inputTaskStarted = true;
      Serial.printf("[input] task started on core %d priority %u\n",
                    INPUT_TASK_CORE,
                    static_cast<unsigned>(INPUT_TASK_PRIORITY));
    } else {
      inputTaskHandle = nullptr;
      Serial.println("[input] task start failed, using main loop fallback");
    }
  }
}

void InputController::loop() {
  if (inputTaskStarted && xTaskGetCurrentTaskHandle() != inputTaskHandle) return;

  AppConfig& config = AppConfig::instance();
  loopIrStationNumberInput();

  if (pendingVolumeTarget >= 0) {
    uint8_t currentVolume = PlayerState::instance().snapshot().volume;
    if (currentVolume == pendingVolumeTarget || millis() - pendingVolumeTargetMs > 700) {
      pendingVolumeTarget = -1;
    }
  }

  if (!config.encoderEnabled && stationPickerActive) {
    closeStationPicker();
  }

  if (HardwareCapabilities::encoder1Available && config.encoderEnabled) {
    loopEncoderOne();
  }

  if (HardwareCapabilities::encoder2Available && config.encoderEnabled && config.secondEncoderEnabled) {
    if (stationPickerActive) closeStationPicker();
    loopEncoderTwo();
  }

#if IR_PIN >= 0
  applyIrSensitivity(config);
  if (config.irEnabled && irrecv.decode(&irResults)) {
    uint64_t code = 0;
    bool repeat = false;
    updateIrLearningWindow(config.irActionLearning);
    if (decodedIrCode(irResults, code, repeat)) {
      handleIrCode(code, repeat);
    }
    irrecv.resume();
  }
#endif
}
