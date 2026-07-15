#pragma once
#include <Arduino.h>

class StateStorage {
public:
  static StateStorage& instance();

  void load();
  void save();

private:
  StateStorage() = default;
};
