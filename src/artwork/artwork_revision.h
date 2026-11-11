#pragma once
#include <stdint.h>

// HTTP validators follow actual thumbnail commits/invalidations. No heap,
// image buffer or clock-resolution dependency; a reboot changes the session.
namespace ArtworkRevision {
void beginHttpSession(); // Once, before the web server accepts requests.
void changed();
uint32_t value();
uint64_t session();
class Publication {
public:
  Publication();
  ~Publication();
  Publication(const Publication&) = delete;
  Publication& operator=(const Publication&) = delete;
};
}
