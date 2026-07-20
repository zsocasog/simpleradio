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

  // Copy this file to xx.js, translate the dictionary and static selectors,
  // then set #define UI_LANGUAGE xx in src/config/hardware_config.h.
  const dict = {
    "save.idle": "Save",
    "save.busy": "Saving...",
    "save.done": "Saved",
    "save.error": "Save failed",
    "status.connecting": "Connecting...",
    "status.ready": "Ready",
    "status.unavailable": "Unavailable",
    "status.fetchFailed": "Status request failed.",
    "status.playing": "Playing",
    "status.stopped": "Stopped",
    "status.playbackDetail": "{station} · volume {volume}% · {clients} web clients",
    "status.versionPair": "Firmware {firmware} · WebUI {webui}",
    "about.label": "About",
    "about.tagline": "ESP32 internet radio",
    "stream.waitingForNetwork": "WiFi lost · reconnecting...",
    "stream.connecting": "Connecting to station...",
    "stream.retrying": "Stream interrupted · retrying...",
    "stream.retryingCount": "Connection failed · retrying ({count})",
    "stream.failed": "Station unavailable and automatic retry is disabled.",
    "status.withAuth": "with authentication",
    "hardware.none": "None",
    "hardware.encoderCount": "{count} encoder",
    "hardware.encoderUnavailable": "No encoder is enabled in this firmware hardware profile.",
    "hardware.encoder2Unavailable": "The hardware profile contains one encoder only.",
    "hardware.frontLedUnavailable": "The front RGB LED is not enabled in this firmware hardware profile.",
    "hardware.irUnavailable": "The IR receiver is not enabled in this firmware hardware profile.",
    "state.noStation": "No station",
    "state.noStationSelected": "No station selected",
    "state.noMetadata": "No metadata",
    "state.playbackPaused": "Playback paused",
    "state.chooseStation": "Choose station",
    "status.connected": "Connected",
    "status.disconnected": "Disconnected",
    "status.disabled": "Disabled",
    "status.wifiDisconnected": "WiFi is currently not connected.",
    "status.mqttDisabled": "MQTT is disabled.",
    "system.rebooting": "Restarting...",
    "system.reboot": "Restarting",
    "system.rebootConfirm": "Restart the ESP now?",
    "duration.daysHours": "{days} days {hours} hours",
    "duration.hoursMinutes": "{hours} hours {minutes} min",
    "duration.minutes": "{minutes} min",
    "stations.noSavedMatch": "No saved stations match.",
    "stations.savedCount": "{count} saved",
    "stations.stationCount": "{count} stations",
    "stations.play": "Play",
    "stations.edit": "Edit station",
    "stations.delete": "Delete station",
    "stations.deleting": "Deleting...",
    "stations.dragReorder": "Drag to reorder",
    "stations.moveUp": "Move up",
    "stations.moveDown": "Move down",
    "stations.clearSavedSearch": "Clear saved station search",
    "search.searching": "Searching...",
    "search.failed": "Search failed",
    "search.noResults": "No results",
    "search.results": "{count} results",
    "search.minChars": "At least 2 characters",
    "search.allNeedsName": "Enter at least 2 characters to search all countries",
    "search.loadedMore": "{count} loaded · scroll for more",
    "search.loadingMore": "Loading more results...",
    "search.more": "Load more",
    "search.clear": "Clear search",
    "search.networkError": "Network error",
    "search.saving": "Saving...",
    "search.saved": "Station saved",
    "search.saveFailed": "Save failed",
    "balance.center": "Center",
    "balance.left": "Left {value}%",
    "balance.right": "Right {value}%",
    "player.prevStation": "Previous station",
    "player.nextStation": "Next station",
    "player.volume": "Volume",
    "player.volumeDown": "Decrease volume by 5 percent",
    "player.volumeDownTitle": "Volume -5%",
    "player.volumeUp": "Increase volume by 5 percent",
    "player.volumeUpTitle": "Volume +5%",
    "player.play": "Play",
    "player.stop": "Stop",
    "display.footer.datetime": "Date and time",
    "display.vuSensitivity": "VU sensitivity",
    "logos.preparing": "Preparing {count} logos...",
    "logos.uploading": "Uploading {count} logos...",
    "logos.uploadStatusError": "Upload error: {status}",
    "logos.uploadedPartial": "{count}/{total} logos uploaded.",
    "logos.uploaded": "{count} logos uploaded.",
    "logos.uploadFailed": "Upload failed: {error}",
    "logos.noReadableImages": "None of the selected images can be read.",
    "logos.browseUploaded": "Browse uploaded logos",
    "ir.pageTitle": "Remote control",
    "ir.recorder": "Button assignment",
    "ir.sensitivity": "IR sensitivity",
    "ir.currentCode": "Current code",
    "ir.clearCode": "Clear code",
    "ir.recordHelpActive": "Press the matching button on the remote now.",
    "ir.recordHelpIdle": "Select a button, then press it on the remote.",
    "ir.learning": "Waiting for {action}",
    "ir.ready": "Ready",
    "ir.notLearned": "No code",
    "action.cancel": "Cancel",
    "ir.action.power": "Power / stop",
    "ir.action.volUp": "VOL+",
    "ir.action.hash": "FUNC / STOP",
    "ir.action.prev": "Previous station",
    "ir.action.toggle": "Play / pause",
    "ir.action.next": "Next station",
    "ir.action.down": "Down / previous station",
    "ir.action.volDown": "VOL-",
    "ir.action.up": "Up / next station",
    "ir.action.digit0": "0",
    "ir.action.mute": "EQ / display mode",
    "ir.action.list": "ST / REPT / station list",
    "ir.action.digit1": "1",
    "ir.action.digit2": "2",
    "ir.action.digit3": "3",
    "ir.action.digit4": "4",
    "ir.action.digit5": "5",
    "ir.action.digit6": "6",
    "ir.action.digit7": "7",
    "ir.action.digit8": "8",
    "ir.action.digit9": "9",
    "ota.passwordMissing": "Enter the OTA password.",
    "ota.done": "{label} update complete. Reconnected.",
    "ota.doneReload": "{label} update complete. Refresh the page if the ESP is already reachable.",
    "ota.confirmMissing": "Enable the confirmation first.",
    "ota.uploading": "Uploading {label}: {file}",
    "ota.waitingRestart": "{label} update complete. Waiting for restart...",
    "ota.failedStatus": "{label} update failed ({status})",
    "ota.networkError": "{label} upload network error.",
    "ota.aborted": "{label} upload aborted.",
    "ota.incompatible": "The firmware and WebUI/data are incompatible. Install the matching companion update too.",
    "ota.versionMismatchCompatible": "Firmware and WebUI versions differ, but their API compatibility is valid.",
    "ota.warning": "The ESP restarts after a firmware update. A data update replaces the complete LittleFS image; WiFi, config, state and station list are backed up. The cache is regenerated, and manually uploaded logos remain only if they are included in the uploaded data image.",
    "wifi.title": "WiFi setup",
    "wifi.help": "Choose the network, enter the password, then save it to the radio.",
    "wifi.network": "Network",
    "wifi.password": "Password",
    "wifi.scanning": "Scanning networks...",
    "wifi.networksFound": "{count} networks found",
    "wifi.noNetworks": "No networks found",
    "wifi.scanFailed": "Scan failed",
    "wifi.saving": "Saving...",
    "wifi.saved": "Saved. Restarting...",
    "wifi.savedMayReboot": "Saved, the radio may restart",
    "wifi.saveFailed": "Save failed"
  };

  const staticText = [];
  const attrs = [];
  const replaceText = {};

  window.SR_I18N = { lang: "xx", dict, staticText, attrs, replaceText };
  installSimpleRadioI18n();
})();
