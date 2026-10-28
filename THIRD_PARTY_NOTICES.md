# Third-party notices

SimpleRadio uses the following direct PlatformIO dependencies. These
dependencies are downloaded during the build from the sources and versions
listed in `platformio.ini`; their original copyright and license terms remain
unchanged.

## ESP32-audioI2S

- Source: [schreibfaul1/ESP32-audioI2S](https://github.com/schreibfaul1/ESP32-audioI2S)
- Pinned revision: `6053353399376439b42f42f1626225bb6fad0f28`
- License: GNU General Public License v3.0

This is the main audio dependency and includes the decoder and audio
processing functionality used by the firmware. Its license is also the reason
SimpleRadio is distributed under GPLv3.

## LovyanGFX

- Source: [lovyan03/LovyanGFX](https://github.com/lovyan03/LovyanGFX)
- Version: `1.2.25`
- License: FreeBSD license for the main library; bundled components and fonts
  retain their own notices.

## AsyncTCP

- Source: [ESP32Async/AsyncTCP](https://github.com/ESP32Async/AsyncTCP)
- Version: `3.4.10`
- License: GNU Lesser General Public License v3.0

## ESPAsyncWebServer

- Source: [ESP32Async/ESPAsyncWebServer](https://github.com/ESP32Async/ESPAsyncWebServer)
- Version: `3.9.6`
- License: GNU Lesser General Public License v3.0

## ArduinoJson

- Source: [bblanchon/ArduinoJson](https://github.com/bblanchon/ArduinoJson)
- Version: `7.4.2`
- License: MIT

## PubSubClient

- Source: [knolleary/PubSubClient](https://github.com/knolleary/PubSubClient)
- Version: `2.8.0`
- License: MIT

## IRremoteESP8266

- Source: [crankyoldgit/IRremoteESP8266](https://github.com/crankyoldgit/IRremoteESP8266)
- Version: `2.9.0`
- License: GNU Lesser General Public License v2.1

## Attribution and source availability

### Tabler Icons (web interface)

- Source: [tabler/tabler-icons](https://github.com/tabler/tabler-icons)
- Bundled revision: `ed177a085b652fe04ec4f37ced867c94621e7840`
- License: MIT, Copyright (c) 2020–2026 Paweł Kuna
- Selected outline symbols are bundled in `data/icons.svg`; the full license is
  included in `data/licenses/tabler-icons.txt` and distributed with the web UI.

The project was inspired by [e2002/yoRadio](https://github.com/e2002/yoradio),
which is GPL-3.0 licensed. Any code copied from an upstream project must keep
the upstream copyright and license notices.

The `lib_deps` entries are intentionally pinned in `platformio.ini` so that a
build can reproduce the intended dependency set. The `.pio` directory is a
local build directory and is not part of this repository.
