# SimpleRadio

[Magyar dokumentáció](README.hu.md)

**SimpleRadio** is an ESP32-S3 internet-radio firmware with a modern web interface and a dedicated LCD player view. It targets a self-built radio with I2S audio, physical controls and optional smart-home integration.

> Current version: **0.8.1** · ESP32-S3 N16R8 · LittleFS · English and Hungarian UI

![SimpleRadio LCD player](.screenshots/lcd/player1.jpg)

## Highlights

- LCD player with station artwork, metadata, volume screen, station picker, VU/footer modes and idle clocks.
- Web UI for playback, station editing and search, EQ/balance, display settings, encoders, IR remote, WiFi, MQTT and OTA.
- MP3, AAC/AAC+, FLAC, OGG/Vorbis, Opus and other stream formats supported by `ESP32-audioI2S`.
- Artwork from local files, station URLs, ICY metadata or Radio Browser; LCD-ready cache keeps repeated playback responsive.
- One or two rotary encoders, optional IR receiver and optional front-panel RGB LED. The UI automatically disables controls for hardware not enabled in the firmware profile.
- MQTT discovery and an optional [Home Assistant Lovelace card](home-assistant/README.md).

## Hardware profile

The tested target is an **ESP32-S3 N16R8** with an **ILI9488 480x320 SPI display** and I2S output (for example, two MAX98357A modules for stereo). ST7796 480x320 and ILI9341 320x240 profiles are also available.

Before the first build, configure the language, display, pins and optional hardware in [`src/config/hardware_config.h`](src/config/hardware_config.h). The shipped profile uses one rotary encoder and an IR receiver.

## Install and update

Open the project in VS Code with PioArduino or PlatformIO, configure `hardware_config.h`, then upload both firmware and the data image:

```powershell
pio run
pio run -t upload
pio run -t uploadfs
pio device monitor -b 115200
```

The first installation requires both uploads. Re-upload the data image after changing files under `data/`; C++ changes only require a firmware upload. If no WiFi is stored, the radio starts the `ESP32-WebRadio` access point for provisioning.

After the first wired upload, firmware and data updates are available from the System page. A data OTA replaces LittleFS; WiFi, configuration, state and stations are backed up, while the artwork cache is regenerated.

`secrets.ini` is optional and intentionally ignored by Git. Create it from [`secrets.example.ini`](secrets.example.ini) only for local build-time overrides such as fixed test WiFi, MQTT credentials or a custom OTA password.

## Screenshots

### LCD in use

| Player | Player with artwork |
| --- | --- |
| ![LCD player](.screenshots/lcd/player1.jpg) | ![LCD player with artwork](.screenshots/lcd/player2.jpg) |
| Station picker | Volume |
| ![LCD station picker](.screenshots/lcd/station_picker.jpg) | ![LCD volume screen](.screenshots/lcd/volume.jpg) |

### Web interface

| Player | Stations |
| --- | --- |
| ![Player page](.screenshots/en/player.png) | ![Stations page](.screenshots/en/stations.png) |
| Sound | Display |
| ![Sound page](.screenshots/en/sound.png) | ![Display page](.screenshots/en/display.png) |
| Controls | Remote control |
| ![Controls page](.screenshots/en/controls.png) | ![Remote control page](.screenshots/en/ir.png) |
| System | |
| ![System page](.screenshots/en/system.png) | |

## Project structure

```text
data/             Web UI, languages, default stations and provisioning page
home-assistant/   Lovelace card and Home Assistant setup
src/              Firmware: audio, display, inputs, MQTT, stations and web server
tools/            Build helpers
```

## License

SimpleRadio is licensed under the [GNU GPL v3](LICENSE). Direct dependencies keep their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
