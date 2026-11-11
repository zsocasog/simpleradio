#pragma once
#include <Arduino.h>
#include "persisted_controls.h"

class StateStorage {
public:
  static StateStorage& instance();

  void load();
  bool save();

private:
  StateStorage() = default;
  PersistedControls::Cache persisted_;
};
