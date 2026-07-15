#include "atomic_file.h"

#include <LittleFS.h>

static bool readJsonFile(const String& path, JsonDocument& doc) {
  if (!LittleFS.exists(path)) return false;

  File file = LittleFS.open(path, "r");
  if (!file) return false;

  DeserializationError err = deserializeJson(doc, file);
  file.close();
  return !err;
}

bool readJsonWithBackup(const char* path, JsonDocument& doc) {
  if (!path || !path[0]) return false;

  String target(path);
  if (readJsonFile(target, doc)) return true;

  doc.clear();
  return readJsonFile(target + ".bak", doc);
}

bool writeJsonAtomic(const char* path, const JsonDocument& doc, bool pretty) {
  if (!path || !path[0]) return false;

  String target(path);
  String temp = target + ".tmp";
  String backup = target + ".bak";

  if (LittleFS.exists(temp)) LittleFS.remove(temp);

  File file = LittleFS.open(temp, "w");
  if (!file) return false;

  size_t written = pretty ? serializeJsonPretty(doc, file) : serializeJson(doc, file);
  file.flush();
  file.close();

  if (!written) {
    LittleFS.remove(temp);
    return false;
  }

  if (LittleFS.exists(backup)) LittleFS.remove(backup);
  if (LittleFS.exists(target) && !LittleFS.rename(target, backup)) {
    LittleFS.remove(temp);
    return false;
  }

  if (!LittleFS.rename(temp, target)) {
    if (LittleFS.exists(backup)) LittleFS.rename(backup, target);
    LittleFS.remove(temp);
    return false;
  }

  if (LittleFS.exists(backup)) LittleFS.remove(backup);
  return true;
}
