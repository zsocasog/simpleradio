#pragma once

#include "display_model.h"
#include "../state/player_state.h"

class DisplayPresenter {
public:
  static DisplayModel build(const PlayerState& state);
};

