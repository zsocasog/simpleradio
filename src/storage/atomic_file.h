#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

bool writeJsonAtomic(const char* path, const JsonDocument& doc, bool pretty = false);
bool readJsonWithBackup(const char* path, JsonDocument& doc);
