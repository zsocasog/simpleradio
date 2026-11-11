#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
bool replaceFileWhenReadersClose(const String& source, const String& target);

bool writeJsonAtomic(const char* path, const JsonDocument& doc, bool pretty = false);
bool readJsonWithBackup(const char* path, JsonDocument& doc);
