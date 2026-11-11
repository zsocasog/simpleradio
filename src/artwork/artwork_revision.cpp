#include "artwork_revision.h"
#include <atomic>
#include <esp_random.h>

namespace {
std::atomic<uint32_t> generation{1};
std::atomic<uint32_t> publishers{0};
uint64_t httpSession = 0;
}
namespace ArtworkRevision {
void beginHttpSession() { httpSession = (uint64_t(esp_random()) << 32) | esp_random(); }
void changed() { generation.fetch_add(1); }
uint32_t value() {
  if (publishers.load()) return 0;
  const uint32_t revision = generation.load();
  return publishers.load() ? 0 : revision;
}
uint64_t session() { return httpSession; }
Publication::Publication() { publishers.fetch_add(1); }
Publication::~Publication() { generation.fetch_add(1); publishers.fetch_sub(1); }
}
