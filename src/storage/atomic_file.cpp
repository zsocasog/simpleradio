#include "atomic_file.h"
#include "buffered_writer.h"
#include "../diagnostics/runtime_probe.h"

#include <LittleFS.h>

static bool readJsonFile(const String& path, JsonDocument& doc) {
  if (!LittleFS.exists(path)) return false;

  File file = LittleFS.open(path, "r");
  if (!file) return false;

  DeserializationError err = deserializeJson(doc, file);
  file.close();
  return !err;
}

static void yieldFlashWriter() { vTaskDelay(1); }

bool readJsonWithBackup(const char* path, JsonDocument& doc) {
  if (!path || !path[0]) return false;

  String target(path);
  if (readJsonFile(target, doc)) return true;

  doc.clear();
  return readJsonFile(target + ".bak", doc);
}

bool writeJsonAtomic(const char* path, const JsonDocument& doc, bool pretty) {
  SR_PERF_SPAN(AtomicWrite);
  if (!path || !path[0]) return false;

  String target(path);
  String temp = target + ".tmp";
  String backup = target + ".bak";

  if (LittleFS.exists(temp)) LittleFS.remove(temp);

  File file = LittleFS.open(temp, "w");
  if (!file) return false;
  // Before the first write: do not retain the core's 4 KB stdio buffer in
  // internal RAM on top of our bounded JSON writer.
  file.setBufferSize(512);

  BufferedWriter<File> writer(file, yieldFlashWriter);
  size_t written = pretty ? serializeJsonPretty(doc, writer) : serializeJson(doc, writer);
  bool complete = writer.flush();
  file.flush();
  complete = complete && written > 0 && file.size() == written;
  file.close();

  if (!complete) {
    LittleFS.remove(temp);
    return false;
  }

  // This helper is LittleFS-specific. Its native replace-rename is atomic,
  // including when target already exists. Keep the old target in place until
  // the fully synced temporary file replaces it in one metadata transaction.
  // Moving the target to .bak first needlessly committed two extra changes.
  if (!LittleFS.rename(temp, target)) {
    LittleFS.remove(temp);
    return false;
  }

  if (LittleFS.exists(backup)) LittleFS.remove(backup);
  return true;
}
