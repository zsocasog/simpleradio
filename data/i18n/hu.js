(function () {
  function formatText(text, vars) {
    return String(text).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) =>
      vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : `{${key}}`
    );
  }

  function installSimpleRadioI18n() {
    const bundle = window.SR_I18N || {};
    const dict = bundle.dict || {};
    window.srT = (key, fallback, vars) =>
      formatText(Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : fallback || key, vars);
    window.srApplyI18n = (root = document) => {
      if (root === document && bundle.lang) document.documentElement.lang = bundle.lang;
      (bundle.staticText || []).forEach(([selector, text]) => {
        root.querySelectorAll(selector).forEach((node) => {
          node.textContent = text;
        });
      });
      (bundle.attrs || []).forEach(([selector, attr, value]) => {
        root.querySelectorAll(selector).forEach((node) => {
          node.setAttribute(attr, value);
        });
      });
      root.querySelectorAll("[data-i18n]").forEach((node) => {
        const key = node.dataset.i18n;
        if (key) node.textContent = window.srT(key, node.textContent);
      });
      const replaceText = bundle.replaceText || {};
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const trimmed = node.nodeValue.trim();
        if (trimmed && Object.prototype.hasOwnProperty.call(replaceText, trimmed)) {
          node.nodeValue = node.nodeValue.replace(trimmed, replaceText[trimmed]);
        }
      }
    };
    const apply = () => window.srApplyI18n(document);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", apply, { once: true });
    } else {
      apply();
    }
  }

  const dict = {
    "save.idle": "Mentés",
    "save.busy": "Mentés...",
    "save.done": "Mentve",
    "save.error": "Mentés sikertelen",
    "status.connecting": "Kapcsolódás...",
    "status.ready": "Kész",
    "status.unavailable": "Nem elérhető",
    "status.fetchFailed": "A státusz lekérdezése nem sikerült.",
    "status.playing": "Lejátszás",
    "status.stopped": "Megállítva",
    "status.playbackDetail": "{station} · hangerő {volume}% · {clients} web kliens",
    "status.version": "Verzió {version}",
    "status.versionPair": "Firmware {firmware} · WebUI {webui}",
    "stream.waitingForNetwork": "Nincs WiFi kapcsolat · újracsatlakozás...",
    "stream.connecting": "Kapcsolódás az adóhoz...",
    "stream.retrying": "A stream megszakadt · újrapróbálkozás...",
    "stream.retryingCount": "Sikertelen kapcsolódás · újrapróbálkozás ({count})",
    "stream.failed": "Az adó nem érhető el, az automatikus újrapróbálkozás ki van kapcsolva.",
    "status.storage": "Tárhely",
    "status.free": "szabad",
    "status.filesystemDetail": "LittleFS: {used} / {total} használatban · logócache: {cache} / {limit} küszöbérték · takarítási cél: {target}",
    "status.withAuth": "hitelesítéssel",
    "hardware.none": "Nincs",
    "hardware.encoderCount": "{count} enkóder",
    "hardware.encoderUnavailable": "Ebben a firmware hardverprofilban nincs enkóder.",
    "hardware.encoder2Unavailable": "A hardverprofil csak egy enkódert tartalmaz.",
    "hardware.frontLedUnavailable": "Az előlapi RGB LED nincs engedélyezve a firmware hardverprofiljában.",
    "hardware.irUnavailable": "Az IR-vevő nincs engedélyezve a firmware hardverprofiljában.",
    "state.noStation": "Nincs állomás",
    "state.noStationSelected": "Nincs kiválasztott állomás",
    "state.noMetadata": "Nincs metadata",
    "state.playbackPaused": "Lejátszás szünetel",
    "state.chooseStation": "Állomás kiválasztása",
    "status.connected": "Csatlakozva",
    "status.disconnected": "Nincs kapcsolat",
    "status.disabled": "Kikapcsolva",
    "status.wifiDisconnected": "A WiFi jelenleg nem csatlakozik.",
    "status.mqttDisabled": "Az MQTT nincs bekapcsolva.",
    "system.rebooting": "Újraindítás...",
    "system.reboot": "Újraindul",
    "system.rebootConfirm": "Biztosan újraindítod az ESP-t?",
    "duration.daysHours": "{days} nap {hours} óra",
    "duration.hoursMinutes": "{hours} óra {minutes} perc",
    "duration.minutes": "{minutes} perc",
    "stations.noSavedMatch": "Nincs találat a mentett állomások között.",
    "stations.savedCount": "{count} mentve",
    "stations.stationCount": "{count} állomás",
    "stations.play": "Lejátszás",
    "stations.edit": "Állomás szerkesztése",
    "stations.delete": "Állomás törlése",
    "stations.deleting": "Törlés...",
    "stations.dragReorder": "Húzással rendezés",
    "stations.moveUp": "Mozgatás feljebb",
    "stations.moveDown": "Mozgatás lejjebb",
    "stations.clearSavedSearch": "Mentett állomások keresés törlése",
    "search.searching": "Keresés...",
    "search.failed": "Keresés sikertelen",
    "search.noResults": "Nincs találat",
    "search.results": "{count} találat",
    "search.minChars": "Legalább 2 karakter",
    "search.allNeedsName": "Az összes országhoz írj be legalább 2 karaktert",
    "search.loadedMore": "{count} betöltve · görgess tovább",
    "search.loadingMore": "További találatok...",
    "search.more": "Továbbiak betöltése",
    "search.clear": "Keresés törlése",
    "search.networkError": "Hálózati hiba",
    "search.saving": "Mentés...",
    "search.saved": "Állomás mentve",
    "search.saveFailed": "Mentés sikertelen",
    "balance.center": "Közép",
    "balance.left": "Bal {value}%",
    "balance.right": "Jobb {value}%",
    "player.prevStation": "Előző állomás",
    "player.nextStation": "Következő állomás",
    "player.volume": "Hangerő",
    "player.volumeDown": "Hangerő csökkentése 5 százalékkal",
    "player.volumeDownTitle": "Hangerő -5%",
    "player.volumeUp": "Hangerő növelése 5 százalékkal",
    "player.volumeUpTitle": "Hangerő +5%",
    "player.play": "Play",
    "player.stop": "Stop",
    "display.footer.datetime": "Dátum és idő",
    "display.vuSensitivity": "VU érzékenység",
    "logos.preparing": "{count} logó előkészítése...",
    "logos.uploading": "{count} logó feltöltése...",
    "logos.uploadStatusError": "Feltöltési hiba: {status}",
    "logos.uploadedPartial": "{count}/{total} logó feltöltve.",
    "logos.uploaded": "{count} logó feltöltve.",
    "logos.uploadFailed": "Nem sikerült feltölteni: {error}",
    "logos.browseUploaded": "Tallózás a feltöltött logók között",
    "ir.pageTitle": "Távirányító",
    "ir.recorder": "Gombok tanítása",
    "ir.sensitivity": "IR érzékenység",
    "ir.currentCode": "Aktuális kód",
    "ir.clearCode": "Kód törlése",
    "ir.recordHelpActive": "Nyomd meg most a fizikai távirányító megfelelő gombját.",
    "ir.recordHelpIdle": "Válassz egy gombot, majd tanítsd be.",
    "ir.learning": "Tanítás: {action}",
    "ir.ready": "Készenlét",
    "ir.notLearned": "Nincs kód",
    "action.cancel": "Mégse",
    "ir.action.power": "Power / stop",
    "ir.action.volUp": "VOL+",
    "ir.action.hash": "FUNC / STOP",
    "ir.action.prev": "Előző állomás",
    "ir.action.toggle": "Play / pause",
    "ir.action.next": "Következő állomás",
    "ir.action.down": "Le / előző állomás",
    "ir.action.volDown": "VOL-",
    "ir.action.up": "Fel / következő állomás",
    "ir.action.digit0": "0",
    "ir.action.mute": "EQ / kijelzésváltás",
    "ir.action.list": "ST / REPT / állomáslista",
    "ir.action.digit1": "1",
    "ir.action.digit2": "2",
    "ir.action.digit3": "3",
    "ir.action.digit4": "4",
    "ir.action.digit5": "5",
    "ir.action.digit6": "6",
    "ir.action.digit7": "7",
    "ir.action.digit8": "8",
    "ir.action.digit9": "9",
    "ota.passwordMissing": "Add meg az OTA jelszót.",
    "ota.done": "{label} frissítés kész. Újracsatlakozva.",
    "ota.doneReload": "{label} frissítés kész. Frissítsd az oldalt, ha az ESP már elérhető.",
    "ota.confirmMissing": "Előbb kapcsold be a megerősítést.",
    "ota.uploading": "{label} feltöltése: {file}",
    "ota.waitingRestart": "{label} frissítés kész. Várakozás az újraindulásra...",
    "ota.failedStatus": "{label} frissítés sikertelen ({status})",
    "ota.networkError": "{label} feltöltési hálózati hiba.",
    "ota.aborted": "{label} feltöltés megszakítva.",
    "ota.incompatible": "A firmware és a WebUI/data nem kompatibilis. Telepítsd a megfelelő másik frissítést is.",
    "ota.versionMismatchCompatible": "A firmware és a WebUI verziója eltér, de az API-kompatibilitás rendben van.",
    "ota.warning": "A firmware frissítés után az ESP újraindul. A data frissítés teljes LittleFS cserét végez; a WiFi, config, állapot és állomáslista mentésre kerül. A cache újragenerálódik, a kézzel feltöltött logók akkor maradnak meg, ha benne vannak a feltöltött data image-ben.",
    "wifi.title": "WiFi beállítás",
    "wifi.help": "Válaszd ki a hálózatot, add meg a jelszót, majd mentsd a rádióra.",
    "wifi.network": "Hálózat",
    "wifi.password": "Jelszó",
    "wifi.scanning": "Hálózatok keresése...",
    "wifi.networksFound": "{count} hálózat található",
    "wifi.noNetworks": "Nem találtam hálózatot",
    "wifi.scanFailed": "Keresés sikertelen",
    "wifi.saving": "Mentés...",
    "wifi.saved": "Mentve. Újraindítás...",
    "wifi.savedMayReboot": "Mentve, a rádió újraindulhat",
    "wifi.saveFailed": "Mentés sikertelen"
  };

  window.SR_I18N = { lang: "hu", dict };
  installSimpleRadioI18n();
})();
