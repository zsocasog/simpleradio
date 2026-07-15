#pragma once
#include <Arduino.h>

enum class WifiRunMode {
  STA_OK,
  AP_CONFIG
};

class WifiManager {
public:
    static WifiManager& instance();
    void begin();
    bool isConnected() const;
    WifiRunMode mode() const;

private:
    WifiManager() = default;
    bool loadCredentials();
    bool tryConnect();
    void startConfigPortal();
    void handleReconnect();

    WifiRunMode _mode = WifiRunMode::AP_CONFIG;
    
};