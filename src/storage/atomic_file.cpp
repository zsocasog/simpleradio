#include "atomic_file.h"
#include "buffered_writer.h"
#include "write_only_file.h"
#include "rename_retry.h"
#include "../diagnostics/runtime_probe.h"

#include <LittleFS.h>

static bool readJsonFile(const String& path, JsonDocument& doc) {
  if (!ReadOnlyStorage::exists(LittleFS.mountpoint(), path.c_str())) return false;

  File file = LittleFS.open(path, "r");
  if (!file) return false;

  DeserializationError err = deserializeJson(doc, file);
  file.close();
  return !err;
}

static void yieldFlashWriter() { vTaskDelay(1); }

bool replaceFileWhenReadersClose(const String& source, const String& target) {
  return AtomicReplace::retryBusy([&] { return LittleFS.rename(source, target); },
                                 [] { return millis(); }, [] { vTaskDelay(1); }, 1500);
}

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

  if (ReadOnlyStorage::exists(LittleFS.mountpoint(), temp.c_str())) LittleFS.remove(temp);

  WriteOnlyStorage::File file(LittleFS.mountpoint(), temp.c_str());
  if (!file) return false;
  BufferedWriter<WriteOnlyStorage::File> writer(file, yieldFlashWriter);
  size_t written = pretty ? serializeJsonPretty(doc, writer) : serializeJson(doc, writer);
  bool complete = writer.flush();
  const bool synced = file.flush();
  complete = complete && synced && written > 0 && file.size() == written;
  const bool closed = file.close();
  complete = complete && closed;

  if (!complete) {
    LittleFS.remove(temp);
    return false;
  }

  // This helper is LittleFS-specific. Its native replace-rename is atomic,
  // including when target already exists. Keep the old target in place until
  // the fully synced temporary file replaces it in one metadata transaction.
  // Moving the target to .bak first needlessly committed two extra changes.
  if (!replaceFileWhenReadersClose(temp, target)) {
    LittleFS.remove(temp);
    return false;
  }

  if (ReadOnlyStorage::exists(LittleFS.mountpoint(), backup.c_str())) LittleFS.remove(backup);
  return true;
}
