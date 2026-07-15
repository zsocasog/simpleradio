#pragma once

class InputController {
public:
  static InputController& instance();

  void begin();
  void loop();

private:
  InputController() = default;
};
