#include "../../src/config/ir_remote_policy.h"
using namespace IrRemotePolicy;
static_assert(PROFILES.size() == 4 && ACTIONS.size() == 31);
static_assert(profileIndex("rcnec21") == 0 && profileIndex("custom") == 3);
static_assert(profileIndex("arbitrary") == -1);
static_assert(actionIndex("volUp") == 3 && actionIndex("unknown") == -1);
static_assert(validCode("0") && validCode("18446744073709551615"));
static_assert(!validCode("18446744073709551616") && !validCode("-1") && !validCode("1e5"));
static_assert(!validCode("0xFFFF") && !validCode("1.0") && !validCode(""));
constexpr bool independentBanks() {
  Banks banks{};
  banks[0][0] = 18446744073709551615ULL;
  banks[1][0] = 123;
  banks[3][0] = 456;
  return banks[0][0] == UINT64_MAX && banks[1][0] == 123 && banks[2][0] == 0 && banks[3][0] == 456;
}
static_assert(independentBanks());
