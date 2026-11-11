#include "picker_logo_loader.h"
#include "picker_logo_mailbox.h"
#include "picker_logo_math.h"
#include "artwork_cache.h"
#include "lcd_thumbnail_ram.h"

#include <LittleFS.h>
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <new>
#include <utility>

namespace PickerLogoLoader {
namespace {
struct Job {
  uint32_t ticket = 0;
  String source;
  String knownPath;
  time_t knownModified = 0;
  bool knownReady = false;
  int sourceSide = 0;
  int targetSide = 0;
  Result result;
};
PickerLogo::Mailbox<Job> mailbox;
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

bool current(uint32_t ticket) {
  portENTER_CRITICAL(&mux);
  const bool value = mailbox.current(ticket);
  portEXIT_CRITICAL(&mux);
  return value;
}

void load(Job& job) {
  if (!current(job.ticket)) return;
  String path;
  // Reuse prepared local station pixels only: this never starts a download,
  // changes PlayerState, searches for an album, or rewrites a cache file.
  if (!ArtworkCache::instance().findExistingLcdArtworkPath(job.source, path) || !path.length()) return;
  LcdThumbnailRam::File file(LittleFS.mountpoint(), path.c_str());
  if (!file) return;
  const time_t modified = file.getLastWrite();
  if (job.knownReady && path == job.knownPath && modified == job.knownModified) return;
  uint8_t header[8];
  if (!PickerLogoMath::validHeader(header, file.read(header, sizeof(header)), job.sourceSide, file.size())) return;
  const size_t bytes = static_cast<size_t>(job.targetSide) * job.targetSide * sizeof(uint16_t);
  job.result.pixels = static_cast<uint16_t*>(heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!job.result.pixels) return;
  auto read = [&](uint8_t* buffer, size_t count) { return file.read(buffer, count); };
  for (int y = 0; y < job.targetSide; ++y) {
    if (!current(job.ticket) ||
        !PickerLogoMath::readRow(read, job.result.pixels, y, job.sourceSide, job.targetSide)) {
      free(job.result.releasePixels());
      return;
    }
    if (y % 2 == 1) vTaskDelay(1);
  }
  // No partially converted image is ever published, even after cancellation.
  job.result.path = std::move(path);
  job.result.modified = modified;
}
} // namespace

Result::~Result() { free(pixels); }

uint32_t request(const String& source, const String& knownPath, time_t knownModified,
                 bool knownReady, int sourceSide, int targetSide) {
  if (!source.length() || !PickerLogoMath::validGeometry(sourceSide, targetSide)) return 0;
  Job* job = new (std::nothrow) Job();
  if (!job) return 0;
  job->source = source;
  job->knownPath = knownPath;
  job->knownModified = knownModified;
  job->knownReady = knownReady;
  job->sourceSide = sourceSide;
  job->targetSide = targetSide;
  portENTER_CRITICAL(&mux);
  const uint32_t ticket = mailbox.enqueue(job);
  portEXIT_CRITICAL(&mux);
  if (!ticket) delete job;
  return ticket;
}

bool pending() {
  portENTER_CRITICAL(&mux);
  const bool value = mailbox.pending();
  portEXIT_CRITICAL(&mux);
  return value;
}

void process() {
  portENTER_CRITICAL(&mux);
  Job* job = mailbox.claim();
  portEXIT_CRITICAL(&mux);
  if (!job) return;
  load(*job);
  portENTER_CRITICAL(&mux);
  Job* retired = mailbox.finish(job);
  portEXIT_CRITICAL(&mux);
  delete retired;
}

bool take(uint32_t ticket, Result& result) {
  portENTER_CRITICAL(&mux);
  Job* job = mailbox.take(ticket);
  portEXIT_CRITICAL(&mux);
  if (!job) return false;
  free(result.releasePixels());
  result.path = std::move(job->result.path);
  result.modified = job->result.modified;
  result.pixels = job->result.releasePixels();
  delete job;
  return true;
}

void cancel() {
  portENTER_CRITICAL(&mux);
  const auto retired = mailbox.cancel();
  portEXIT_CRITICAL(&mux);
  delete retired.pending;
  delete retired.completed;
}
} // namespace PickerLogoLoader
