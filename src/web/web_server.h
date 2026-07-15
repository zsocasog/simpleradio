#pragma once
#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>

void webServerBegin();
void webServerLoop();
bool queuePlayerCommand(const JsonDocument& cmd);
void requestStateSave();
bool broadcastState(bool forceDisplay = false);
