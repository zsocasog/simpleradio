#pragma once

class MqttController {
public:
  static MqttController& instance();

  void begin();
  void loop();
  bool enabled() const;
  bool connected() const;
  int state() const;
  const char* stateText() const;

private:
  MqttController() = default;
};
