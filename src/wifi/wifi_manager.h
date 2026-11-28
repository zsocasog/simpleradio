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
    bool loop();
    bool isConnected() const;
    WifiRunMode mode() const;
    bool matchesSetupHandoff(const String& id) const;
    String hostname() const;
    bool discoveryReady() const;
    const char* defaultHostname() const;
    static bool validHostname(const String& name);
    bool saveHostname(const String& name);

private:
    WifiManager() = default;
    bool loadCredentials();
    bool tryConnect();
    void startConfigPortal();
    void handleReconnect();

    WifiRunMode _mode = WifiRunMode::AP_CONFIG;
    bool _lastConnected = false;
    
};
