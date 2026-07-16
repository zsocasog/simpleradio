#pragma once

#include <Arduino.h>

struct WebUiCompatibilityInfo {
  bool manifestPresent = false;
  bool manifestValid = false;
  bool compatible = false;
  String webuiVersion;
  uint16_t minimumApiVersion = 0;
  uint16_t maximumApiVersion = 0;
  String reason = "missing_manifest";
};

namespace WebUiCompatibility {

void refresh();
const WebUiCompatibilityInfo& info();
String reasonText();

}  // namespace WebUiCompatibility
