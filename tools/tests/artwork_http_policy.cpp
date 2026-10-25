#include "../../src/artwork/artwork_http_policy.h"

using ArtworkHttpPolicy::BodyBoundary;
constexpr bool completeKnownBody() {
  BodyBoundary body;
  body.begin(3526, false);
  return !body.consume(0) && !body.consume(2048) && !body.consume(1000) &&
         body.consume(478) && !body.consume(1);
}
constexpr bool leaveFramingToHttpClient() {
  BodyBoundary body;
  body.begin(3526, true);
  if (body.consume(3526)) return false;
  body.begin(-1, false);
  if (body.consume(4096)) return false;
  body.begin(0, false);
  return !body.consume(1);
}
static_assert(completeKnownBody());
static_assert(leaveFramingToHttpClient());
static_assert(ArtworkHttpPolicy::MAX_METADATA_BYTES == 262144);
