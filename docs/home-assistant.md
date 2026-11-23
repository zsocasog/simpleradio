# SimpleRadio in Home Assistant

## MQTT setup / MQTT beállítása

Enable MQTT in the radio’s web interface under **System → Connections**. Enter the broker address, port (typically `1883`) and credentials if required. The default root topic is `simpleradio`. With the MQTT integration connected to the same broker, Home Assistant discovers the radio automatically. Check the device under **Settings → Devices & services → MQTT** for its actual entity IDs.

A rádió webfelületén a **Rendszer → Kapcsolatok** alatt kapcsold be az MQTT-t. Add meg a broker címét, portját (általában `1883`) és – ha szükséges – a bejelentkezési adatokat. Az alapértelmezett gyökértéma `simpleradio`. Ha a Home Assistant MQTT-integrációja ugyanahhoz a brokerhez kapcsolódik, automatikusan felismeri a rádiót. A tényleges entitásazonosítókat a **Beállítások → Eszközök és szolgáltatások → MQTT** alatt találod.

## Dashboard card / Irányítópultkártya

Copy [simple-radio-card.js](../home-assistant/simple-radio-card.js) into Home Assistant’s `/config/www/` folder. Register it as a dashboard resource with the type **JavaScript module**, then add a manual card using the example below.

Másold a [simple-radio-card.js](../home-assistant/simple-radio-card.js) fájlt a Home Assistant `/config/www/` mappájába. Vedd fel **JavaScript-modul** típusú erőforrásként, majd az alábbi példa alapján adj hozzá egy kézi kártyát.

**Resource / Erőforrás**

```yaml
url: /local/simple-radio-card.js?v=13
type: module
```

**Card / Kártya**

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

### Notes

- Use the radio’s address for `radio_url` so the browser can load local artwork. If an HTTPS dashboard blocks HTTP images, use an HTTPS reverse proxy for the radio.
- Adjust entity IDs and `command_topic` to match your MQTT setup. To follow the radio’s display theme, add `sync_theme: true`.
- After replacing the card script, increase the `?v=` value in the resource URL and reload the dashboard.

### Megjegyzések

- A `radio_url` mezőbe a rádió címét írd, hogy a böngésző be tudja tölteni a képeket. Ha a HTTPS-en megnyitott irányítópult blokkolja a HTTP-képeket, használj HTTPS reverse proxyt a rádióhoz.
- Az entitásazonosítókat és a `command_topic` értékét igazítsd a saját MQTT-beállításaidhoz. A rádió kijelzőtémáját a `sync_theme: true` beállítással követheti a kártya.
- A kártyafájl cseréje után növeld az erőforrás URL-jében a `?v=` értéket, majd töltsd újra az irányítópultot.

## MQTT diagnostics / MQTT ellenőrzése

Listen on `simpleradio/#` in the Home Assistant MQTT integration. The radio publishes `status`, `stations`, `volume`, `balance` and `availability` under this root topic. Send commands such as `play`, `stop`, `toggle`, `prev`, `next`, `vol 35`, `balance 0`, `play 8` or `reboot` to `simpleradio/command`.

A Home Assistant MQTT-integrációjában a `simpleradio/#` témára feliratkozva ellenőrizheted a rádió üzeneteit. A fenti példaparancsokat a `simpleradio/command` témára küldheted.
