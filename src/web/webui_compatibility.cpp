#include "webui_compatibility.h"

#include <ArduinoJson.h>
#include <LittleFS.h>

#include "../config/version.h"

namespace {

constexpr const char* BUILD_INFO_PATH = "/build-info.json";
WebUiCompatibilityInfo currentInfo;

}  // namespace

namespace WebUiCompatibility {

void refresh() {
  WebUiCompatibilityInfo next;

  if (!LittleFS.exists(BUILD_INFO_PATH)) {
    currentInfo = next;
    Serial.println("[webui] compatibility manifest missing");
    return;
  }

  next.manifestPresent = true;
  File file = LittleFS.open(BUILD_INFO_PATH, "r");
  if (!file) {
    next.reason = "invalid_manifest";
    currentInfo = next;
    Serial.println("[webui] compatibility manifest cannot be opened");
    return;
  }

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, file);
  file.close();
  if (error) {
    next.reason = "invalid_manifest";
    currentInfo = next;
    Serial.printf("[webui] compatibility manifest parse failed: %s\n", error.c_str());
    return;
  }

  next.webuiVersion = doc["webuiVersion"].as<String>();
  next.minimumApiVersion = doc["requiresFirmwareApi"]["min"] | 0;
  next.maximumApiVersion = doc["requiresFirmwareApi"]["max"] | 0;
  const int schemaVersion = doc["schemaVersion"] | 0;
  next.manifestValid = schemaVersion == 1 &&
                       next.webuiVersion.length() > 0 &&
                       next.minimumApiVersion > 0 &&
                       next.maximumApiVersion >= next.minimumApiVersion;
  if (!next.manifestValid) {
    next.reason = "invalid_manifest";
  } else if (WEB_API_VERSION < next.minimumApiVersion) {
    next.reason = "firmware_api_too_old";
  } else if (WEB_API_VERSION > next.maximumApiVersion) {
    next.reason = "webui_api_too_old";
  } else {
    next.compatible = true;
    next.reason = "compatible";
  }

  currentInfo = next;
  Serial.printf("[webui] firmware=%s api=%u, webui=%s api=%u..%u, compatible=%s\n",
                APP_VERSION,
                static_cast<unsigned>(WEB_API_VERSION),
                currentInfo.webuiVersion.length() ? currentInfo.webuiVersion.c_str() : "unknown",
                static_cast<unsigned>(currentInfo.minimumApiVersion),
                static_cast<unsigned>(currentInfo.maximumApiVersion),
                currentInfo.compatible ? "yes" : "no");
}

const WebUiCompatibilityInfo& info() {
  return currentInfo;
}

String reasonText() {
  if (currentInfo.reason == "missing_manifest") return "A WebUI verzioinformacioja hianyzik.";
  if (currentInfo.reason == "invalid_manifest") return "A WebUI verzioinformacioja ervenytelen.";
  if (currentInfo.reason == "firmware_api_too_old") return "A firmware tul regi ehhez a WebUI-hoz.";
  if (currentInfo.reason == "webui_api_too_old") return "A WebUI/data tul regi ehhez a firmware-hez.";
  return "A firmware es a WebUI kompatibilis.";
}

}  // namespace WebUiCompatibility
