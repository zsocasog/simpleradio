# SimpleRadio languages / Nyelvek

## English

Set `UI_LANGUAGE` in [hardware_config.h](../src/config/hardware_config.h) to `en` (also `eng`) or `hu`. The LCD and web interface share this build-time setting.

1. Copy the [LCD template](../src/i18n/lang_template.h) to `src/i18n/lang_xx.h` and the [web template](../data/i18n/template.js) to `data/i18n/xx.js`.
2. Translate the values in both files. Keep keys and `{placeholders}` intact, and set the web template’s `lang` field to `"xx"`.
3. Set `#define UI_LANGUAGE xx`, then rebuild and upload both the firmware and the LittleFS image. PlatformIO generates `data/i18n.js` from the selected dictionary.

The [web catalog](../data/i18n-catalog.js) maps HTML text to dictionary keys. Add translations in your new dictionary file.

## Magyar

A [hardware_config.h](../src/config/hardware_config.h) fájlban a `UI_LANGUAGE` értéke lehet `hu`, illetve `en` vagy `eng`. Az LCD és a webfelület ugyanazt a fordításkor kiválasztott nyelvet használja.

1. Másold az [LCD-sablont](../src/i18n/lang_template.h) `src/i18n/lang_xx.h` néven, a [webes sablont](../data/i18n/template.js) pedig `data/i18n/xx.js` néven.
2. Fordítsd le az értékeket mindkét fájlban. Tartsd meg a kulcsokat és a `{helyőrzőket}`, a webes sablon `lang` mezőjébe pedig írd az új nyelvkódot (`"xx"`).
3. Állítsd be a `#define UI_LANGUAGE xx` értéket, majd fordítsd újra és töltsd fel a firmware-t és a LittleFS-képet is. A `data/i18n.js` fájlt a PlatformIO állítja elő a kiválasztott fordításból.

A [webes katalógus](../data/i18n-catalog.js) a HTML szövegeit kapcsolja össze a szótár kulcsaival. A fordítást az új szótárfájlban add meg.
