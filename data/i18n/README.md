# SimpleRadio Web UI Languages / A SimpleRadio webes felület nyelvei

## English

The web UI language is selected at build time from `src/config/hardware_config.h`:

```cpp
#define UI_LANGUAGE hu
```

Built-in values are `hu`, `en`, and the alias `eng`.

To add a language:

1. Copy `src/i18n/lang_template.h` to `src/i18n/lang_xx.h`.
2. Copy `data/i18n/template.js` to `data/i18n/xx.js`.
3. Translate both files. The web template includes every static and dynamic text
   key, including the system subpages. Keep keys and `{placeholders}` intact and
   change the template bundle's `lang: "xx"` to the new language code.
4. Set `#define UI_LANGUAGE xx`.
5. Rebuild firmware and LittleFS/data.

`data/i18n.js` is generated automatically by PlatformIO and is intentionally not committed.
`data/i18n-catalog.js` maps the HTML source copy to dictionary keys. Do not
translate this catalog: translate the corresponding dictionary values instead.
The web UI and LCD use the same build-time language; there is no runtime language
switch. Native browser date/time picker controls follow the browser's language.

## Magyar

A webes felület nyelvét fordításkor kell kiválasztani a
`src/config/hardware_config.h` fájlban:

```cpp
#define UI_LANGUAGE hu
```

A beépített értékek: `hu`, `en`, valamint az angol `eng` aliasa.

Új nyelv hozzáadása:

1. Másold a `src/i18n/lang_template.h` fájlt `src/i18n/lang_xx.h` néven.
2. Másold a `data/i18n/template.js` fájlt `data/i18n/xx.js` néven.
3. Fordítsd le mindkét fájlt, és tartsd meg a kulcsokat és a `{helyőrzőket}`.
   A webes sablon a Rendszer aloldalainak összes szövegét is tartalmazza.
   A sablon `lang: "xx"` értékét is írd át az új nyelvkódra.
4. Állítsd a `#define UI_LANGUAGE xx` értékét az új nyelvkódra.
5. Fordítsd újra a firmware-t és a LittleFS/data képet.

A `data/i18n.js` fájlt a PlatformIO automatikusan állítja elő, ezért nem kerül a repóba.
A `data/i18n-catalog.js` a HTML szövegeit köti a szótár kulcsaihoz; ezt nem kell
lefordítani. A megfelelő nyelvi szótár értékeit fordítsd. Az LCD és a webfelület
nyelve továbbra is közös, fordításkor kiválasztott beállítás. A böngésző saját
dátum- és időválasztója a böngésző nyelvét követi.
