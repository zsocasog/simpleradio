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
3. Translate both files.
4. Set `#define UI_LANGUAGE xx`.
5. Rebuild firmware and LittleFS/data.

`data/i18n.js` is generated automatically by PlatformIO and is intentionally not committed.

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
3. Fordítsd le mindkét fájlt, és tartsd meg a kulcsokat és a helyőrzőket.
4. Állítsd a `#define UI_LANGUAGE xx` értékét az új nyelvkódra.
5. Fordítsd újra a firmware-t és a LittleFS/data képet.

A `data/i18n.js` fájlt a PlatformIO automatikusan állítja elő, ezért nem kerül a repóba.
