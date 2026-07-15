# SimpleRadio Home Assistant setup

This project publishes MQTT topics under the configured root topic, default
`simpleradio`.

## Firmware side

1. In the SimpleRadio web UI, enable MQTT.
2. Set the MQTT host to the Mosquitto broker IP or hostname.
3. Keep port `1883`, unless your broker uses a different port.
4. Keep root topic `simpleradio`, unless you intentionally changed it.

If your Mosquitto broker requires a username and password, add these build flags
in your local `secrets.ini`:

```ini
build_flags =
    -D MQTT_USER=\"your_mqtt_user\"
    -D MQTT_PASS=\"your_mqtt_password\"
```

Then rebuild and upload the firmware.

## Home Assistant side

Home Assistant 2026.7 / HA OS 18.x uses MQTT discovery with the default
`homeassistant` prefix. After the radio connects to Mosquitto, it publishes
discovery payloads for these entities:

- `switch.simpleradio_playback`
- `number.simpleradio_volume`
- `number.simpleradio_balance`
- `sensor.simpleradio_station`
- `sensor.simpleradio_stations`
- `sensor.simpleradio_title`
- `sensor.simpleradio_artist`
- `button.simpleradio_previous_station`
- `button.simpleradio_next_station`
- `button.simpleradio_reboot`

Entity IDs can differ if Home Assistant has already created entities with the
same names. Check Settings > Devices & services > MQTT > SimpleRadio.

## Custom Lovelace card

Copy `simple-radio-card.js` to Home Assistant:

```text
/config/www/simple-radio-card.js
```

Add a dashboard resource. Use a versioned URL so the browser cannot keep serving
an older cached card script:

```yaml
url: /local/simple-radio-card.js?v=10
type: module
```

Then add this card to a dashboard. Replace `radio_url` with the IP or hostname
of the radio, so local logo paths such as `/logos/station-8.png` can be loaded.

```yaml
type: custom:simple-radio-card-v2
radio_url: http://192.168.1.50
station_entity: sensor.simpleradio_station
title_entity: sensor.simpleradio_title
artist_entity: sensor.simpleradio_artist
playback_entity: switch.simpleradio_playback
volume_entity: number.simpleradio_volume
stations_entity: sensor.simpleradio_stations
previous_button_entity: button.simpleradio_previous_station
next_button_entity: button.simpleradio_next_station
command_topic: simpleradio/command
```

The station picker is collapsed by default. It loads stations from
`sensor.simpleradio_stations`, includes a search field, and tapping a station
publishes `play <station id>` to `command_topic`.

If you see an error such as `extra keys not allowed @ data['target']`, Home
Assistant is still running an older cached card version. The `v2` card type and
the versioned resource URL are there specifically to avoid that. Increase the
query-string version after replacing the card file, for example `?v=10`.

## Manual MQTT test

In Home Assistant, go to Settings > Devices & services > MQTT > Configure, then
listen to:

```text
simpleradio/#
```

Expected topics:

- `simpleradio/status` - retained JSON state
- `simpleradio/stations` - retained JSON station list
- `simpleradio/volume` - retained volume percentage
- `simpleradio/balance` - retained balance percentage
- `simpleradio/availability` - retained `online` or broker LWT `offline`
- `simpleradio/command` - command topic

Useful command payloads:

```text
play
stop
toggle
prev
next
vol 35
balance 0
play 8
reboot
```

## Magyar útmutató

### Szükséges-e a `secrets.ini`?

Nem, a Home Assistant alap használatához nem szükséges. A következőket a
SimpleRadio webes **Rendszer** oldalán kell beállítani:

1. Kapcsold be az MQTT-t.
2. Add meg a Mosquitto broker címét és portját.
3. Hagyd meg a `simpleradio` root topicot, vagy használd ugyanazt a saját
   értéket a Home Assistant kártya `command_topic` beállításában.

A `secrets.ini` csak akkor kell, ha a broker felhasználónevet és jelszót kér.
Ilyenkor a fájl helyi példányában add meg a fordítási flag-eket:

```ini
[env:esp32-s3-devkitc1-n16r8]
build_src_flags =
    -D MQTT_USER=\"mqtt_felhasznalo\"
    -D MQTT_PASS=\"mqtt_jelszo\"
```

Ugyanez a fájl használható fix teszt-WiFihez vagy egyedi OTA-jelszóhoz is.
A `secrets.ini` a Git által figyelmen kívül hagyott fájl, ezért ne töltsd fel a
GitHubra. A benne lévő értékek fordításkor bekerülnek a firmware-be, ezért a
firmware binárisát is kezeld bizalmasan, ha valódi jelszavakat használsz.

Ha a broker nem kér hitelesítést, nincs szükség `secrets.ini` fájlra és MQTT
fordítási flag-ekre.

### Home Assistant beállítása

Az MQTT bekapcsolása és az első sikeres brokerkapcsolat után a SimpleRadio
automatikusan közzéteszi a discovery-adatokat. A kártya telepítéséhez másold a
`simple-radio-card.js` fájlt a Home Assistant `/config/www/` mappájába, majd
add hozzá erőforrásként, például:

```yaml
url: /local/simple-radio-card.js?v=10
type: module
```

A kártya konfigurációjában a `radio_url` legyen az ESP IP-címe vagy hostneve.
Erre azért van szükség, hogy a helyi LCD-logó útvonalak, például
`/logos/station-8.png`, a böngészőből is betölthetők legyenek.

Ha frissítés után régi felület jelenik meg, növeld az URL végén a `?v=` értéket,
majd töltsd újra a dashboardot.
