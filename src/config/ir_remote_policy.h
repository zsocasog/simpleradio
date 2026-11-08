#pragma once
#include <array>
#include <cstdint>
#include <string_view>

namespace IrRemotePolicy {
constexpr std::array<std::string_view, 4> PROFILES = {"rcnec21", "car21", "nav17", "custom"};
constexpr std::array<std::string_view, 31> ACTIONS = {
  "prev", "next", "toggle", "volUp", "volDown", "mute", "power", "up", "down",
  "left", "right", "ok", "list", "back", "digit0", "digit1", "digit2", "digit3",
  "digit4", "digit5", "digit6", "digit7", "digit8", "digit9", "star", "hash",
  "station1", "station2", "station3", "station4", "station5"
};
constexpr size_t MAX_CUSTOM_BYTES = 6144;
constexpr size_t MAX_BUTTONS = 40;
constexpr int MAX_COLUMNS = 5;
constexpr int MAX_ROWS = 12;
constexpr int profileIndex(std::string_view value) {
  for (size_t i = 0; i < PROFILES.size(); ++i) if (PROFILES[i] == value) return i;
  return -1;
}
constexpr int actionIndex(std::string_view value) {
  for (size_t i = 0; i < ACTIONS.size(); ++i) if (ACTIONS[i] == value) return i;
  return -1;
}
constexpr bool validCode(std::string_view code) {
  if (code.empty() || code.size() > 20) return false;
  uint64_t value = 0;
  for (const char c : code) {
    if (c < '0' || c > '9' || value > (UINT64_MAX - (c - '0')) / 10) return false;
    value = value * 10 + (c - '0');
  }
  return true;
}
using Codes = std::array<uint64_t, ACTIONS.size()>;
using Banks = std::array<Codes, PROFILES.size()>;
} // namespace IrRemotePolicy
