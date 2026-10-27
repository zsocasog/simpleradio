let ws;
let wsReconnectTimer;
let wsHeartbeatTimer;
let lastWsMessageAt = 0;
let stations = [];
let currentStationId = -1;
let playing = false;
let renderedStationId = null;
let renderedStationCount = -1;
let renderedStationFilter = "";
let configSaveTimer;
let configSaveStatusTimer;
let configSaving = false;
let configSavePending = false;
let deferredConfigAction = {};
let configSaveDeferred = false;
const sliderGestures = new Map();
const sliderDirty = new Map();
let sliderRevision = 0;
let playerPreviewTimer = null;
let playerPreviewPending = {};
let sliderEditAnnounced = false;
const playerSliderFields = {
  volume: "volume", soundEqLow: "eqLow", soundEqMid: "eqMid", soundEqHigh: "eqHigh", soundBalance: "balance"
};
let meterSensitivityTimer;
let meterSensitivityFlight = null;
let meterSensitivityPending = null;
let meterSensitivityEditing = false;
let meterSensitivityDirty = false;
let meterSensitivityRevision = 0;
let searchTimer;
let searchAbortController;
let onlineSearchObserver;
let onlineSearchOffset = 0;
let onlineSearchHasMore = false;
let onlineSearchLoading = false;
let onlineSearchQueryKey = "";
let onlineSearchVisibleCount = 0;
let onlineSearchSeen = new Set();
let irPollTimer;
let systemStatusTimer;
let currentConfig = {};
let hardwareCapabilities = {
  schemaVersion: 0,
  transientPlayerControls: false,
  encoderCount: 0,
  encoder1: { available: false, hasButton: false },
  encoder2: { available: false, hasButton: false },
  frontRgbLed: { available: false, type: "none", inverted: false },
  ir: { available: false }
};
let selectedIrAction = "";
let configLoaded = false;
let stationAssetRevision = Date.now();
let draggedStationId = null;
let uploadedLogos = [];
let savedStationFilter = "";
const browserArtworkCache = new Map();

const views = ["player", "stations", "sound", "display", "controls", "ir", "system"];
const RADIO_BROWSER_SEARCH_URL = "https://de1.api.radio-browser.info/json/stations/search";
const ONLINE_SEARCH_PAGE_SIZE = 16;
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const t = (key, fallback, vars) =>
  window.srT ? window.srT(key, fallback, vars) : String(fallback || key).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) =>
    vars && Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : `{${name}}`
  );
const WS_HEARTBEAT_MS = 3000;
const WS_STALE_MS = 9000;
const themePresets = {
  green: { accent: "#a9f7bf", strong: "#69e58d", accentRgb: "169, 247, 191", strongRgb: "105, 229, 141" },
  amber: { accent: "#f5ce74", strong: "#dca84f", accentRgb: "245, 206, 116", strongRgb: "220, 168, 79" },
  blue: { accent: "#84b2ff", strong: "#5d8df0", accentRgb: "132, 178, 255", strongRgb: "93, 141, 240" },
  cyan: { accent: "#70e1eb", strong: "#42c8d8", accentRgb: "112, 225, 235", strongRgb: "66, 200, 216" },
  red: { accent: "#f20202", strong: "#b80000", accentRgb: "242, 2, 2", strongRgb: "184, 0, 0" }
};

function normalizeThemeAccent(theme) {
  if (theme === "ruby") return "red";
  return theme === "custom" || themePresets[theme] ? theme : "green";
}

const irLayout = [
  { action: "power", label: "Power / stop", text: "PWR", cls: "red" },
  { action: "volUp", label: "VOL+", text: "VOL+" },
  { action: "hash", label: "FUNC / STOP", text: "FUNC\nSTOP" },
  { action: "prev", label: "Previous station", text: "|<<" },
  { action: "toggle", label: "Play / pause", text: ">||" },
  { action: "next", label: "Next station", text: ">>|" },
  { action: "down", label: "Down / previous station", text: "▼" },
  { action: "volDown", label: "VOL-", text: "VOL-" },
  { action: "up", label: "Up / next station", text: "▲" },
  { action: "digit0", label: "0", text: "0", cls: "white" },
  { action: "mute", label: "EQ / display mode", text: "EQ" },
  { action: "list", label: "ST / REPT / station list", text: "ST/\nREPT" },
  { action: "digit1", label: "1", text: "1", cls: "white" },
  { action: "digit2", label: "2", text: "2", cls: "white" },
  { action: "digit3", label: "3", text: "3", cls: "white" },
  { action: "digit4", label: "4", text: "4", cls: "white" },
  { action: "digit5", label: "5", text: "5", cls: "white" },
  { action: "digit6", label: "6", text: "6", cls: "white" },
  { action: "digit7", label: "7", text: "7", cls: "white" },
  { action: "digit8", label: "8", text: "8", cls: "white" },
  { action: "digit9", label: "9", text: "9", cls: "white" }
];

const irActions = irLayout.filter(Boolean);
const inactiveIrActions = ["left", "right", "ok", "back", "star", "station1", "station2", "station3", "station4", "station5"];

function irActionLabel(item) {
  return t(`ir.action.${item.action}`, item.label);
}

function $(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function applyLanguage(root = document) {
  if (window.srApplyI18n) window.srApplyI18n(root);
}

function setValue(id, value) {
  const node = $(id);
  if (node) node.value = value;
}

function sliderIsProtected(id) {
  if (id === "themeCustomColorText" || id === "themeAccent") id = "themeCustomColor";
  if (id === "frontLedColorText") id = "frontLedColor";
  return sliderGestures.has(id) || sliderDirty.has(id);
}

function setConfigValue(id, value) {
  if (!sliderIsProtected(id)) setValue(id, value);
}

function beginSliderGesture(node) {
  if (!sliderGestures.has(node.id)) sliderGestures.set(node.id, { node, changed: false, pointer: null, keys: new Set() });
  announceSliderEditing(true);
  if (configSaveTimer) {
    clearTimeout(configSaveTimer);
    configSaveTimer = null;
    configSaveDeferred = true;
  }
  return sliderGestures.get(node.id);
}

function announceSliderEditing(editing) {
  if (!hardwareCapabilities.transientPlayerControls || sliderEditAnnounced === editing) return;
  if (sendCommand({ controlEdit: editing })) sliderEditAnnounced = editing;
}

function resetPlayerSliderCommits() {
  sliderEditAnnounced = false;
  for (const [id, dirty] of sliderDirty) if (playerSliderFields[id]) delete dirty.sentRevision;
}

function trackSliderInput(node) {
  beginSliderGesture(node).changed = true;
  if (node.id !== "displayVuSensitivity") sliderDirty.set(node.id, { value: node.value, revision: ++sliderRevision });
  if (!playerSliderFields[node.id]) {
    configSaveDeferred = true;
    setConfigSaveState("pending");
  }
}

function finishSliderGesture(node) {
  const gesture = sliderGestures.get(node.id);
  if (!gesture) return;
  sliderGestures.delete(node.id);
  if (gesture.changed && node.id === "displayVuSensitivity") {
    return commitMeterSensitivity().finally(flushReleasedSliders);
  }
  flushReleasedSliders();
}

function queuePlayerPreview(values) {
  Object.assign(playerPreviewPending, values);
  if (playerPreviewTimer === null) playerPreviewTimer = setTimeout(flushPlayerPreview, 80);
}

function flushPlayerPreview() {
  clearTimeout(playerPreviewTimer);
  playerPreviewTimer = null;
  if (!Object.keys(playerPreviewPending).length) return true;
  // Older firmware safely falls back to release-only commands, never a stream
  // of supposedly transient commands which it would actually persist.
  if (!hardwareCapabilities.transientPlayerControls) { playerPreviewPending = {}; return true; }
  if (sliderGestures.size || meterSensitivityEditing) announceSliderEditing(true);
  if (!sendCommand({ ...playerPreviewPending, persist: false })) return false;
  playerPreviewPending = {};
  return true;
}

function sendPlayerControls(values, preview = false) {
  if (preview) { queuePlayerPreview(values); return; }
  for (const field of Object.keys(values)) delete playerPreviewPending[field];
  for (const [id, field] of Object.entries(playerSliderFields)) if (field in values) sliderDirty.delete(id);
  sendCommand(values);
}

function flushReleasedSliders() {
  if (sliderGestures.size || meterSensitivityEditing) return;
  const controls = {};
  const revisions = new Map();
  for (const [id, field] of Object.entries(playerSliderFields)) {
    const dirty = sliderDirty.get(id);
    if (dirty && dirty.sentRevision !== dirty.revision) {
      controls[field] = Number(dirty.value);
      revisions.set(id, dirty.revision);
    }
  }
  if (Object.keys(controls).length && flushPlayerPreview() && sendCommand({ ...controls, persist: true })) {
    for (const [id, revision] of revisions) {
      const dirty = sliderDirty.get(id);
      if (dirty?.revision === revision) dirty.sentRevision = revision;
    }
  }
  if (configSaveDeferred) queueConfigSave();
  announceSliderEditing(false);
}

function acknowledgePlayerSliders(state) {
  for (const [id, field] of Object.entries(playerSliderFields)) {
    const dirty = sliderDirty.get(id);
    if (dirty && dirty.sentRevision === dirty.revision && Number(state[field]) === Number(dirty.value)) sliderDirty.delete(id);
  }
}

function acknowledgeConfigSliders(saved, submitted, revisions) {
  for (const [id, revision] of revisions) {
    if (playerSliderFields[id]) continue;
    if (sliderDirty.get(id)?.revision === revision && String(saved[id]) === String(submitted[id])) sliderDirty.delete(id);
  }
}

function initSliderControls() {
  const sliderKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);
  document.querySelectorAll('input[type="range"], input[type="color"]').forEach(node => {
    node.addEventListener("pointerdown", event => {
      if (node.type === "range" && !(event.button > 0)) beginSliderGesture(node).pointer = event.pointerId;
    });
    node.addEventListener("input", () => trackSliderInput(node), true);
    node.addEventListener("keydown", event => {
      if (node.type === "range" && sliderKeys.has(event.key)) beginSliderGesture(node).keys.add(event.key);
    });
    node.addEventListener("change", () => {
      const gesture = sliderGestures.get(node.id);
      if (gesture && gesture.pointer === null && !gesture.keys.size) finishSliderGesture(node);
    });
    node.addEventListener("blur", () => finishSliderGesture(node));
  });
  const releasePointer = event => {
    for (const gesture of [...sliderGestures.values()]) {
      if (gesture.pointer === event.pointerId) {
        gesture.pointer = null;
        if (!gesture.keys.size) finishSliderGesture(gesture.node);
      }
    }
  };
  document.addEventListener("pointerup", releasePointer, true);
  document.addEventListener("pointercancel", releasePointer, true);
  document.addEventListener("keyup", event => {
    for (const gesture of [...sliderGestures.values()]) {
      if (gesture.keys.delete(event.key) && !gesture.keys.size && gesture.pointer === null) finishSliderGesture(gesture.node);
    }
  }, true);
  const finishAll = () => {
    for (const gesture of [...sliderGestures.values()]) finishSliderGesture(gesture.node);
  };
  window.addEventListener("blur", finishAll);
  document.addEventListener("visibilitychange", () => { if (document.hidden) finishAll(); });
}

function hexToRgb(color) {
  const hex = normalizeHexColor(color);
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ];
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map(value => clampNumber(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function themePresetFromColor(value) {
  const accent = normalizeHexColor(value);
  const [r, g, b] = hexToRgb(accent);
  const strong = rgbToHex(r * 0.78, g * 0.78, b * 0.78);
  const [sr, sg, sb] = hexToRgb(strong);
  return {
    accent,
    strong,
    accentRgb: `${r}, ${g}, ${b}`,
    strongRgb: `${sr}, ${sg}, ${sb}`
  };
}

function applyThemeAccent(theme) {
  const normalized = normalizeThemeAccent(theme);
  const customColor = normalizeHexColor($("themeCustomColor")?.value || $("themeCustomColorText")?.value || currentConfig.themeCustomColor || "#a9f7bf");
  const preset = normalized === "custom" ? themePresetFromColor(customColor) : (themePresets[normalized] || themePresets.green);
  const root = document.documentElement;
  root.style.setProperty("--accent", preset.accent);
  root.style.setProperty("--accent-strong", preset.strong);
  root.style.setProperty("--accent-rgb", preset.accentRgb);
  root.style.setProperty("--accent-strong-rgb", preset.strongRgb);
  if ($("themeAccent") && $("themeAccent").value !== normalized) $("themeAccent").value = normalized;
  syncThemeCustomControls();
  drawVolumeCurvePreview();
}

function syncThemeAccent() {
  applyThemeAccent($("themeAccent")?.value || "green");
}

function rememberButtonLabel(button) {
  if (!button) return "";
  if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent.trim() || t("save.idle", "Mentés");
  return button.dataset.idleLabel;
}

function setButtonFeedback(button, state, label) {
  if (!button) return;
  const idleLabel = rememberButtonLabel(button);
  const labels = {
    idle: idleLabel,
    busy: label || t("save.busy", "Mentés..."),
    success: label || t("save.done", "Mentve"),
    error: label || t("save.error", "Hiba")
  };

  button.textContent = labels[state] || idleLabel;
  button.disabled = state === "busy";
  button.setAttribute("aria-busy", state === "busy" ? "true" : "false");
  button.classList.toggle("is-saving", state === "busy");
  button.classList.toggle("is-saved", state === "success");
  button.classList.toggle("is-error", state === "error");
}

function restoreButtonFeedback(button, delay = 1200) {
  if (!button) return;
  setTimeout(() => setButtonFeedback(button, "idle"), delay);
}

function configSaveButtons() {
  return Array.from(document.querySelectorAll("[data-config-save]"));
}

function setConfigSaveState(state) {
  clearTimeout(configSaveStatusTimer);
  configSaveButtons().forEach(button => setButtonFeedback(button, state === "pending" ? "busy" : state));
  updateLastFmDeleteButton();

  if (state === "success" || state === "error") {
    configSaveStatusTimer = setTimeout(() => {
      configSaveButtons().forEach(button => setButtonFeedback(button, "idle"));
    }, state === "success" ? 1200 : 1800);
  }
}

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function showDisconnectedState(message = t("status.connecting", "Kapcsolódás...")) {
  playing = false;
  updatePlayButtons();
  setText("playState", "STOP");
  setText("meta", message);
}

function stopWsHeartbeat() {
  clearInterval(wsHeartbeatTimer);
  wsHeartbeatTimer = undefined;
}

function sendHeartbeat() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  if (lastWsMessageAt && Date.now() - lastWsMessageAt > WS_STALE_MS) {
    showDisconnectedState();
    ws.close();
    return;
  }

  try {
    ws.send(JSON.stringify({ ping: Date.now() }));
  } catch (err) {
    showDisconnectedState();
    ws.close();
  }
}

function connectWS() {
  clearTimeout(wsReconnectTimer);
  stopWsHeartbeat();
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    lastWsMessageAt = Date.now();
    setText("connectionInfo", t("status.connected", "Csatlakozva"));
    sendHeartbeat();
    wsHeartbeatTimer = setInterval(sendHeartbeat, WS_HEARTBEAT_MS);
    if (sliderGestures.size || meterSensitivityEditing) announceSliderEditing(true);
    flushPlayerPreview();
    flushReleasedSliders();
  };
  ws.onclose = () => {
    resetPlayerSliderCommits();
    stopWsHeartbeat();
    showDisconnectedState();
    wsReconnectTimer = setTimeout(connectWS, 1000);
  };
  ws.onerror = () => {
    if (ws) ws.close();
  };
  ws.onmessage = event => {
    try {
      lastWsMessageAt = Date.now();
      const payload = JSON.parse(event.data);
      if (payload && payload.pong) return;
      updateUI(payload);
    } catch (err) {
      console.warn("Bad websocket payload", err);
    }
  };
}

function sendCommand(cmd) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(cmd));
  return true;
}

function showView(view) {
  views.forEach(name => {
    $(`${name}View`).classList.toggle("hidden", name !== view);
    $(`${name}Tab`).classList.toggle("active", name === view);
  });

  if (view === "sound") {
    requestAnimationFrame(drawVolumeCurvePreview);
  }

  if (view === "system") {
    refreshSystemStatus();
    clearInterval(systemStatusTimer);
    systemStatusTimer = undefined;
  } else {
    clearInterval(systemStatusTimer);
    systemStatusTimer = undefined;
  }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms) {
  let seconds = Math.floor(Number(ms || 0) / 1000);
  const days = Math.floor(seconds / 86400);
  seconds -= days * 86400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  if (days) return t("duration.daysHours", "{days} nap {hours} óra", { days, hours });
  if (hours) return t("duration.hoursMinutes", "{hours} óra {minutes} perc", { hours, minutes });
  return t("duration.minutes", "{minutes} perc", { minutes });
}

async function loadWebUiBranding() {
  try {
    const response = await fetch("/build-info.json", { cache: "no-store" });
    if (!response.ok) return;
    const buildInfo = await response.json();
    const version = String(buildInfo.webuiVersion || "").trim();
    if (version) setText("footerVersion", `v${version}`);
  } catch (_) {
    // The footer remains useful without a version while the device is offline.
  }
}

function setStatusCard(id, state) {
  const node = $(id);
  if (!node) return;
  node.classList.toggle("good", state === "good");
  node.classList.toggle("warn", state === "warn");
  node.classList.toggle("bad", state === "bad");
}

async function refreshSystemStatus() {
  try {
    const response = await fetch("/api/system/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`System status failed: ${response.status}`);
    renderSystemStatus(await response.json());
  } catch (err) {
    console.warn("System status failed", err);
    setText("statusWifi", t("status.unavailable", "Nem elérhető"));
    setText("statusWifiDetail", t("status.fetchFailed", "A státusz lekérdezése nem sikerült."));
    setStatusCard("statusWifiCard", "bad");
  }
}

function renderSystemStatus(status) {
  const playback = status.status || {};
  const wifi = status.wifi || {};
  const mqtt = status.mqtt || {};
  const system = status.system || {};
  const webui = status.webui || {};

  setText("statusPlayback", playback.playing ? t("status.playing", "Lejátszás") : t("status.stopped", "Megállítva"));
  setText(
    "statusPlaybackDetail",
    t("status.playbackDetail", "{station} · hangerő {volume}% · {clients} web kliens", {
      station: playback.station || t("state.noStationSelected", "Nincs kiválasztott állomás"),
      volume: Number(playback.volume || 0),
      clients: Number(playback.clients || 0)
    })
  );
  setStatusCard("statusPlaybackCard", playback.playing ? "good" : "");

  const quality = Number(wifi.quality || 0);
  setText("statusWifi", wifi.connected ? `${quality}%` : t("status.disconnected", "Nincs kapcsolat"));
  setText("statusWifiDetail", wifi.connected ? `${wifi.ssid || "-"} · ${wifi.rssi || 0} dBm · ${wifi.ip || "-"}` : t("status.wifiDisconnected", "A WiFi jelenleg nem csatlakozik."));
  const wifiMeter = $("statusWifiMeter");
  if (wifiMeter) wifiMeter.style.width = `${Math.max(0, Math.min(100, quality))}%`;
  setStatusCard("statusWifiCard", wifi.connected ? (quality >= 55 ? "good" : quality >= 35 ? "warn" : "bad") : "bad");

  setText("statusMqtt", mqtt.configured ? (mqtt.connected ? t("status.connected", "Csatlakozva") : t("status.disconnected", "Nincs kapcsolat")) : t("status.disabled", "Kikapcsolva"));
  setText("statusMqttDetail", mqtt.configured ? `${mqtt.stateText || "-"} · ${mqtt.host || "-"}:${mqtt.port || ""} · ${mqtt.rootTopic || "-"}${mqtt.hasAuth ? ` · ${t("status.withAuth", "hitelesítéssel")}` : ""}` : t("status.mqttDisabled", "Az MQTT nincs bekapcsolva."));
  setStatusCard("statusMqttCard", !mqtt.configured ? "" : mqtt.connected ? "good" : "warn");

  const filesystem = status.filesystem || {};
  const totalBytes = Number(filesystem.totalBytes || 0);
  const usedBytes = Number(filesystem.usedBytes || 0);
  const freeBytes = Number(filesystem.freeBytes || 0);
  const cacheBytes = Number(filesystem.artworkCacheBytes || 0);
  const cacheLimitBytes = Number(filesystem.artworkCacheLimitBytes || 0);
  const cacheTargetBytes = Number(filesystem.artworkCacheTargetBytes || 0);
  const freePercent = totalBytes > 0 ? Math.round((freeBytes * 100) / totalBytes) : 0;
  setText("statusFilesystemLabel", t("status.storage", "Tárhely"));
  setText("statusFilesystem", totalBytes > 0 ? `${formatBytes(freeBytes)} ${t("status.free", "szabad")}` : t("status.unavailable", "Nem elérhető"));
  setText(
    "statusFilesystemDetail",
    totalBytes > 0
      ? t("status.filesystemDetail", "LittleFS: {used} / {total} használatban · logócache: {cache} / {limit} küszöbérték · takarítási cél: {target}", {
          used: formatBytes(usedBytes),
          total: formatBytes(totalBytes),
          cache: formatBytes(cacheBytes),
          limit: formatBytes(cacheLimitBytes),
          target: formatBytes(cacheTargetBytes)
        })
      : t("status.fetchFailed", "A státusz lekérdezése nem sikerült.")
  );
  const filesystemMeter = $("statusFilesystemMeter");
  if (filesystemMeter) filesystemMeter.style.width = `${Math.max(0, Math.min(100, freePercent))}%`;
  setStatusCard("statusFilesystemCard", totalBytes <= 0 ? "bad" : freePercent <= 15 ? "bad" : freePercent <= 30 ? "warn" : "good");

  setText("statusSystem", `${system.chipModel || "ESP32"} · ${system.cpuMhz || 0} MHz`);
  const firmwareVersion = system.version || "-";
  const webuiVersion = webui.version || "-";
  setText("statusSystemDetail", `${t("status.versionPair", "Firmware {firmware} · WebUI {webui}", { firmware: firmwareVersion, webui: webuiVersion })} · Uptime: ${formatDuration(system.uptimeMs)} · reset: ${system.resetReasonText || "-"} · flash: ${formatBytes(system.flashSize)} · SDK: ${system.sdk || "-"}`);
  setText("statusAboutVersion", t("status.versionPair", "Firmware {firmware} · WebUI {webui}", { firmware: firmwareVersion, webui: webuiVersion }));
  setText("footerVersion", webuiVersion === "-" ? "v-" : `v${webuiVersion}`);
  setText("otaVersion", `FW v${firmwareVersion}`);
  setText("otaWebUiVersion", `WebUI v${webuiVersion}`);
  const compatibility = $("otaCompatibility");
  if (compatibility) {
    compatibility.classList.remove("hidden", "warn", "error");
    if (!webui.manifestPresent || !webui.manifestValid || webui.compatible === false) {
      compatibility.classList.add("error");
      compatibility.textContent = t("ota.incompatible", "A firmware és a WebUI/data nem kompatibilis. Telepítsd a megfelelő másik frissítést is.");
    } else if (firmwareVersion !== webuiVersion) {
      compatibility.classList.add("warn");
      compatibility.textContent = t("ota.versionMismatchCompatible", "A firmware és a WebUI verziója eltér, de az API-kompatibilitás rendben van.");
    } else {
      compatibility.classList.add("hidden");
      compatibility.textContent = "";
    }
  }
  setStatusCard("statusSystemCard", system.resetReason === 4 ? "warn" : "good");
}

async function requestSystemReboot() {
  const button = $("rebootButton");
  if (!confirm(t("system.rebootConfirm", "Biztosan újraindítod az ESP-t?"))) return;

  setButtonFeedback(button, "busy", t("system.rebooting", "Újraindítás..."));
  try {
    const response = await fetch("/api/system/reboot", { method: "POST" });
    if (!response.ok) throw new Error(`Reboot failed: ${response.status}`);
    setButtonFeedback(button, "success", t("system.reboot", "Újraindul"));
    showDisconnectedState(t("system.rebooting", "Újraindítás..."));
  } catch (err) {
    console.warn("Reboot failed", err);
    setButtonFeedback(button, "error", t("save.error", "Hiba"));
    restoreButtonFeedback(button, 1800);
  }
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[ch]));
}

function percentFrom255(value) {
  return `${Math.round((Number(value || 0) / 255) * 100)}%`;
}

function dbLabel(value) {
  const n = Number(value || 0);
  return `${n > 0 ? "+" : ""}${n} dB`;
}

function balanceLabel(value) {
  const n = Number(value || 0);
  if (n === 0) return t("balance.center", "Center");
  return n < 0
    ? t("balance.left", "Left {value}%", { value: Math.abs(n) })
    : t("balance.right", "Right {value}%", { value: n });
}

function volumeCurveDb(curve, t) {
  const x = Math.max(0, Math.min(1, Number(t) || 0));
  if (x <= 0) return -60;
  if (curve === "linear") return -60 + 60 * x;
  if (curve === "log") return -60 + 60 * x * x;
  return -112 * x * x * x + 172 * x * x - 60;
}

function drawVolumeCurvePreview() {
  const canvas = $("volumeCurvePreview");
  if (!canvas) return;
  const curve = $("volumeCurve")?.value || "soft";
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(220, Math.round(rect.width * dpr));
  const height = Math.max(110, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue("--surface")?.trim() || "#101614";
  const line = styles.getPropertyValue("--line")?.trim() || "#24312d";
  const accent = styles.getPropertyValue("--accent")?.trim() || "#9cf5b5";
  const accentRgb = styles.getPropertyValue("--accent-rgb")?.trim() || "156, 245, 181";
  const muted = styles.getPropertyValue("--muted")?.trim() || "#9ba9a1";
  const pad = 18 * dpr;
  const graphW = width - pad * 2;
  const graphH = height - pad * 2;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = line;
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.moveTo(pad, pad);
  ctx.lineTo(pad, height - pad);
  ctx.lineTo(width - pad, height - pad);
  ctx.stroke();

  ctx.strokeStyle = `rgba(${accentRgb}, 0.15)`;
  ctx.beginPath();
  for (let i = 1; i <= 3; i++) {
    const y = pad + (graphH * i) / 4;
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
  }
  ctx.stroke();

  ctx.strokeStyle = accent;
  ctx.lineWidth = 3 * dpr;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    const db = volumeCurveDb(curve, t);
    const x = pad + graphW * t;
    const y = height - pad - graphH * ((db + 60) / 60);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = muted;
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText("0%", pad, height - pad + 4 * dpr);
  ctx.textAlign = "right";
  ctx.fillText("100%", width - pad, height - pad + 4 * dpr);
}

function syncVolumeCurve() {
  drawVolumeCurvePreview();
}

function irKey(action) {
  return `ir${action.charAt(0).toUpperCase()}${action.slice(1)}`;
}

function togglePlay() {
  if (!playing && currentStationId < 0) {
    setText("meta", t("state.chooseStation", "Állomás kiválasztása"));
    return;
  }
  sendCommand({ play: !playing });
}

function setVolume(v, preview = false) {
  const value = clampNumber(parseInt(v, 10), 0, 100, 50);
  setValue("volume", value);
  setText("volValue", `${value}%`);
  sendPlayerControls({ volume: value }, preview);
}

function changeVolume(delta) {
  setVolume(numberValue("volume", 50) + delta);
}

function numberValue(id, fallback = 0) {
  const node = $(id);
  if (!node) return fallback;
  const value = parseInt(node.value, 10);
  return Number.isNaN(value) ? fallback : value;
}

function eqValue(band) {
  const ids = {
    low: ["soundEqLow", "eqLow"],
    mid: ["soundEqMid", "eqMid"],
    high: ["soundEqHigh", "eqHigh"]
  }[band] || [];
  for (const id of ids) {
    if ($(id)) return numberValue(id);
  }
  return 0;
}

function setEq(preview = false) {
  const low = eqValue("low");
  const mid = eqValue("mid");
  const high = eqValue("high");
  syncEqLabels(low, mid, high);
  sendPlayerControls({ eqLow: low, eqMid: mid, eqHigh: high }, preview);
}

function mirrorEq(band, value, preview = false) {
  const map = {
    low: ["eqLow", "soundEqLow"],
    mid: ["eqMid", "soundEqMid"],
    high: ["eqHigh", "soundEqHigh"]
  };
  map[band].forEach(id => setValue(id, value));
  setEq(preview);
}

function resetTone() {
  ["eqLow", "eqMid", "eqHigh", "soundEqLow", "soundEqMid", "soundEqHigh"].forEach(id => setValue(id, 0));
  setEq();
  setBalance(0);
}

function setBalance(v, preview = false) {
  const value = parseInt(v, 10);
  syncBalance(value);
  sendPlayerControls({ balance: value }, preview);
}

function syncBalance(value) {
  setValue("balance", value);
  setValue("soundBalance", value);
  setText("balanceValue", balanceLabel(value));
  setText("soundBalanceValue", balanceLabel(value));
}

function mirrorBalance(v, preview = false) {
  setBalance(v, preview);
}

function selectStation(id) {
  sendCommand({ station: id, play: true });
}

function prevStation() {
  if (!stations.length) return;
  let idx = stations.findIndex(s => s.id === currentStationId);
  idx = idx <= 0 ? stations.length - 1 : idx - 1;
  selectStation(stations[idx].id);
}

function nextStation() {
  if (!stations.length) return;
  let idx = stations.findIndex(s => s.id === currentStationId);
  idx = (idx + 1) % stations.length;
  selectStation(stations[idx].id);
}

function stationInitial(name) {
  return String(name || "SR").trim().slice(0, 2).toUpperCase();
}

function logoUrl(path, key = "") {
  if (!path) return "";
  const value = String(path);
  if (/^https?:\/\//i.test(value)) return value;

  const separator = value.includes("?") ? "&" : "?";
  const cacheKey = [key, stationAssetRevision].filter(Boolean).join("|");
  return `${value}${separator}sr=${encodeURIComponent(cacheKey || stationAssetRevision)}`;
}

function stationRow(station, compact = false, index = 0, total = 0) {
  const row = document.createElement("div");
  row.className = `station-item${station.id === currentStationId ? " active" : ""}`;
  row.dataset.stationId = station.id;
  if (compact) {
    row.classList.add("compact-row");
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.title = station.name || "";
    row.onclick = () => selectStation(station.id);
    row.onkeydown = event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectStation(station.id);
      }
    };
  }

  let grip;
  if (!compact) {
    row.draggable = true;
    row.setAttribute("draggable", "true");
    row.classList.add("draggable");

    grip = document.createElement("span");
    grip.className = "drag-handle";
    grip.title = t("stations.dragReorder", "Drag to reorder");
    grip.setAttribute("aria-hidden", "true");
    grip.textContent = "⋮⋮";

    row.addEventListener("dragstart", event => {
      draggedStationId = station.id;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(station.id));
    });
    row.addEventListener("dragend", () => {
      draggedStationId = null;
      row.classList.remove("dragging", "drop-before", "drop-after");
      clearStationDropTargets();
    });
    row.addEventListener("dragover", event => {
      if (!draggedStationId || draggedStationId === station.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      clearStationDropTargets(row);
      row.classList.toggle("drop-before", dragInsertBefore(row, event.clientY));
      row.classList.toggle("drop-after", !dragInsertBefore(row, event.clientY));
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("drop-before", "drop-after");
    });
    row.addEventListener("drop", event => {
      event.preventDefault();
      if (!draggedStationId || draggedStationId === station.id) return;
      const before = dragInsertBefore(row, event.clientY);
      reorderDraggedStation(station.id, before);
    });
  }

  const badge = document.createElement("span");
  badge.className = "station-badge";
  badge.textContent = stationInitial(station.name);
  if (station.logo) {
    const badgeUrl = logoUrl(station.logo, `${station.id}|${station.logo}`);
    badge.classList.add("has-logo");
    badge.style.backgroundImage = `url("${String(badgeUrl).replace(/"/g, "%22")}")`;
    badge.textContent = "";
  }

  const number = document.createElement("span");
  number.className = "station-number";
  const stationNumber = index + 1;
  const stationNumberLabel = String(stationNumber).padStart(2, "0");
  number.textContent = `#${stationNumberLabel}`;
  number.title = `#${stationNumber}`;

  const info = document.createElement("div");
  info.className = "station-info";
  info.innerHTML = compact
    ? `<span class="item-title">${escapeHtml(station.name)}</span>`
    : `<span class="item-title">${escapeHtml(station.name)}</span><span class="item-meta">#${stationNumber} · ${escapeHtml(station.url)}</span>`;

  const actions = document.createElement("div");
  actions.className = "item-actions";

  if (!compact) {
    const play = document.createElement("button");
    play.type = "button";
    play.textContent = "►";
    play.title = t("stations.play", "Lejátszás");
    play.onclick = () => selectStation(station.id);
    actions.appendChild(play);

    const up = document.createElement("button");
    up.type = "button";
    up.className = "icon-only reorder-btn";
    up.textContent = "↑";
    up.title = t("stations.moveUp", "Move up");
    up.setAttribute("aria-label", t("stations.moveUp", "Move up"));
    up.disabled = index <= 0;
    up.onclick = () => moveStation(station.id, -1, up);

    const down = document.createElement("button");
    down.type = "button";
    down.className = "icon-only reorder-btn";
    down.textContent = "↓";
    down.title = t("stations.moveDown", "Move down");
    down.setAttribute("aria-label", t("stations.moveDown", "Move down"));
    down.disabled = index >= total - 1;
    down.onclick = () => moveStation(station.id, 1, down);

    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "✎";
    edit.title = t("stations.edit", "Állomás szerkesztése");
    edit.onclick = () => editStation(station);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "❌";
    del.title = t("stations.delete", "Állomás törlése");
    del.onclick = () => deleteStation(station.id, del);
    actions.append(up, down, edit, del);
  }

  if (grip) {
    row.append(grip, number, badge, info, actions);
  } else {
    row.append(number, badge, info, actions);
  }
  return row;
}

function clearStationDropTargets(except) {
  document.querySelectorAll(".station-item.drop-before, .station-item.drop-after").forEach(row => {
    if (row !== except) row.classList.remove("drop-before", "drop-after");
  });
}

function dragInsertBefore(row, clientY) {
  const rect = row.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2;
}

async function reorderDraggedStation(targetId, insertBefore) {
  const fromId = draggedStationId;
  draggedStationId = null;
  clearStationDropTargets();

  const nextStations = stations.slice();
  const fromIndex = nextStations.findIndex(station => station.id === fromId);
  if (fromIndex < 0) return;

  const [moved] = nextStations.splice(fromIndex, 1);
  let targetIndex = nextStations.findIndex(station => station.id === targetId);
  if (targetIndex < 0) return;
  if (!insertBefore) targetIndex += 1;
  nextStations.splice(targetIndex, 0, moved);

  const nextOrder = nextStations.map(station => station.id).join(",");
  const currentOrder = stations.map(station => station.id).join(",");
  if (nextOrder === currentOrder) return;

  stations = nextStations;
  renderStations(true);

  try {
    const response = await fetch("/api/station/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ order: nextOrder })
    });
    if (!response.ok) throw new Error(`Reorder failed: ${response.status}`);
    await loadStations();
  } catch (err) {
    console.warn("Station reorder failed", err);
    await loadStations();
  }
}

function renderStations(force = false) {
  if (!force &&
      renderedStationId === currentStationId &&
      renderedStationCount === stations.length &&
      renderedStationFilter === savedStationFilter) {
    return;
  }

  const quick = $("stations");
  const manager = $("stationManager");
  if (quick) quick.innerHTML = "";
  if (manager) manager.innerHTML = "";
  setText("stationCount", t("stations.savedCount", "{count} mentve", { count: stations.length }));
  setText("stationManagerCount", t("stations.stationCount", "{count} állomás", { count: stations.length }));

  const normalizedFilter = savedStationFilter.trim().toLocaleLowerCase("hu-HU");
  const visibleStations = normalizedFilter
    ? stations.filter(station => `${station.name || ""} ${station.url || ""}`.toLocaleLowerCase("hu-HU").includes(normalizedFilter))
    : stations;

  stations.forEach((station, index) => {
    if (quick) quick.appendChild(stationRow(station, true, index, stations.length));
  });

  if (manager) {
    visibleStations.forEach(station => {
      const originalIndex = stations.findIndex(item => item.id === station.id);
      manager.appendChild(stationRow(station, false, originalIndex, stations.length));
    });
    if (!visibleStations.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = t("stations.noSavedMatch", "Nincs találat a mentett állomások között.");
      manager.appendChild(empty);
    }
  }

  renderedStationId = currentStationId;
  renderedStationCount = stations.length;
  renderedStationFilter = savedStationFilter;
}

function filterSavedStations() {
  savedStationFilter = $("savedStationSearch")?.value || "";
  renderStations(true);
}

function clearSavedStationSearch() {
  const input = $("savedStationSearch");
  if (input) input.value = "";
  savedStationFilter = "";
  renderStations(true);
}

function stationStreamUrl(result) {
  return result.url_resolved || result.url || "";
}

function remoteUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function canvasToBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}

function pngLogoFilename(filename) {
  const clean = String(filename || "logo").replace(/[\\/]/g, "-").replace(/\.[^.]+$/, "");
  return `${clean || "logo"}.png`;
}

async function logoPngBlob(url) {
  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  const size = 150;
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#070909";
  ctx.fillRect(0, 0, size, size);

  const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight, 1);
  const width = Math.round(img.naturalWidth * scale);
  const height = Math.round(img.naturalHeight * scale);
  const x = Math.round((size - width) / 2);
  const y = Math.round((size - height) / 2);
  ctx.drawImage(img, x, y, width, height);

  const blob = await canvasToBlob(canvas);
  if (!blob) throw new Error("Logo conversion failed");
  return blob;
}

async function logoPngBlobFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    return await logoPngBlob(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadStationLogo(stationId, logoUrl) {
  if (!stationId || !remoteUrl(logoUrl)) return "";

  try {
    const blob = await logoPngBlob(logoUrl);
    const response = await fetch(`/api/logo/upload?id=${encodeURIComponent(stationId)}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: blob
    });
    if (!response.ok) return "";
    const data = await response.json();
    return data.path || "";
  } catch (err) {
    console.warn("Logo normalization failed", err);
    return "";
  }
}

async function cacheArtworkViaBrowser(state) {
  const sourceUrl = state?.streamLogoUrl || state?.stationLogo || "";
  const cachedPath = String(state?.cachedArtworkPath || "");
  if (!remoteUrl(sourceUrl) || (cachedPath && !cachedPath.toLowerCase().endsWith(".sr565"))) return;

  const cached = browserArtworkCache.get(sourceUrl);
  const now = Date.now();
  if (cached?.state === "pending" || cached?.state === "ok") return;
  if (cached?.state === "error" && now - cached.at < 60000) return;

  browserArtworkCache.set(sourceUrl, { state: "pending", at: now });
  try {
    const blob = await logoPngBlob(sourceUrl);
    const response = await fetch(`/api/artwork/cache?url=${encodeURIComponent(sourceUrl)}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: blob
    });
    if (!response.ok) throw new Error(`Artwork cache failed: ${response.status}`);
    browserArtworkCache.set(sourceUrl, { state: "ok", at: Date.now() });
  } catch (err) {
    console.warn("Browser artwork cache failed", err);
    browserArtworkCache.set(sourceUrl, { state: "error", at: Date.now() });
  }
}

function setLogoUploadStatus(text, state = "") {
  const status = $("logoUploadStatus");
  if (!status) return;
  status.textContent = text;
  status.classList.toggle("is-busy", state === "busy");
  status.classList.toggle("is-ok", state === "ok");
  status.classList.toggle("is-error", state === "error");
}

function renderLogoChoices() {
  const picker = $("editLogoPicker");
  if (!picker) return;

  const current = $("editLogo")?.value || "";
  picker.innerHTML = `<option value="">${escapeHtml(t("logos.browseUploaded", "Browse uploaded logos"))}</option>`;
  uploadedLogos.forEach(item => {
    const option = document.createElement("option");
    option.value = item.path;
    option.textContent = item.name || item.path;
    picker.appendChild(option);
  });
  picker.value = uploadedLogos.some(item => item.path === current) ? current : "";
}

async function loadLogoChoices() {
  const picker = $("editLogoPicker");
  if (picker) picker.disabled = true;

  try {
    const response = await fetch("/api/logos");
    if (!response.ok) throw new Error(`Logo list failed: ${response.status}`);
    const data = await response.json();
    uploadedLogos = data.logos || [];
  } catch (err) {
    console.warn("Logo list failed", err);
    uploadedLogos = [];
  } finally {
    renderLogoChoices();
    if (picker) picker.disabled = false;
  }
}

function selectUploadedLogo() {
  const value = $("editLogoPicker")?.value || "";
  if (value) setValue("editLogo", value);
}

async function uploadBulkLogos(fileList) {
  const files = Array.from(fileList || []).filter(file => file && file.size);
  if (!files.length) return;

  const form = new FormData();
  setLogoUploadStatus(t("logos.preparing", "{count} logó előkészítése...", { count: files.length }), "busy");

  try {
    let preparedCount = 0;
    for (const file of files) {
      try {
        const blob = await logoPngBlobFromFile(file);
        form.append("logos", blob, pngLogoFilename(file.name));
        preparedCount++;
      } catch (err) {
        console.warn(`Logo preparation failed: ${file.name}`, err);
      }
    }

    if (!preparedCount) {
      throw new Error(t("logos.noReadableImages", "A kiválasztott képek egyike sem olvasható."));
    }

    setLogoUploadStatus(t("logos.uploading", "{count} logó feltöltése...", { count: preparedCount }), "busy");
    const response = await fetch("/api/logos/upload", {
      method: "POST",
      body: form
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || t("logos.uploadStatusError", "Feltöltési hiba: {status}", { status: response.status }));
    stationAssetRevision = Date.now();
    renderStations();
    await loadLogoChoices();
    const count = Number(data.count || 0);
    const label = count !== files.length
      ? t("logos.uploadedPartial", "{count}/{total} logó feltöltve.", { count, total: files.length })
      : t("logos.uploaded", "{count} logó feltöltve.", { count: files.length });
    setLogoUploadStatus(label, "ok");
  } catch (err) {
    console.warn("Logo upload failed", err);
    setLogoUploadStatus(t("logos.uploadFailed", "Nem sikerült feltölteni: {error}", { error: err.message || err }), "error");
  } finally {
    const input = $("logoBulkInput");
    if (input) input.value = "";
  }
}

function initLogoDropZone() {
  const drop = $("logoDropZone");
  const input = $("logoBulkInput");
  if (!drop || !input) return;

  input.onchange = () => uploadBulkLogos(input.files);
  ["dragenter", "dragover"].forEach(type => {
    drop.addEventListener(type, event => {
      event.preventDefault();
      drop.classList.add("drag-over");
    });
  });
  ["dragleave", "drop"].forEach(type => {
    drop.addEventListener(type, event => {
      event.preventDefault();
      drop.classList.remove("drag-over");
    });
  });
  drop.addEventListener("drop", event => uploadBulkLogos(event.dataTransfer.files));
}

function setOtaStatus(text, state = "") {
  const status = $("otaStatus");
  if (!status) return;
  status.textContent = text;
  status.classList.toggle("is-busy", state === "busy");
  status.classList.toggle("is-ok", state === "ok");
  status.classList.toggle("is-error", state === "error");
}

function setOtaProgress(percent) {
  const bar = $("otaProgressBar");
  if (!bar) return;
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  bar.style.width = `${safe}%`;
}

function waitForOtaReconnect(label) {
  const started = Date.now();
  const timeoutMs = 90000;

  const poll = async () => {
    if (Date.now() - started > timeoutMs) {
      setOtaStatus(t("ota.doneReload", "{label} frissítés kész. Frissítsd az oldalt, ha az ESP már elérhető.", { label }), "ok");
      return;
    }

    try {
      const response = await fetch(`/api/system/status?ota=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`status ${response.status}`);
      setOtaProgress(0);
      setOtaStatus(t("ota.done", "{label} frissítés kész. Újracsatlakozva.", { label }), "ok");
      const confirm = $("otaConfirm");
      const password = $("otaPassword");
      if (confirm) confirm.checked = false;
      if (password) password.value = "";
      setTimeout(() => window.location.reload(), 500);
      return;
    } catch (_) {
      setTimeout(poll, 1500);
    }
  };

  setTimeout(poll, 4500);
}

function uploadOtaFile(kind, file) {
  if (!file) return;
  if (!$("otaConfirm")?.checked) {
    setOtaStatus(t("ota.confirmMissing", "Előbb kapcsold be a megerősítést."), "error");
    return;
  }

  const password = $("otaPassword")?.value || "";
  if (!password) {
    setOtaStatus(t("ota.passwordMissing", "Add meg az OTA jelszót."), "error");
    return;
  }

  const params = new URLSearchParams({ confirm: "1" });
  const endpoint = kind === "filesystem" ? `/api/ota/filesystem?${params}` : `/api/ota/firmware?${params}`;
  const label = kind === "filesystem" ? "Data / LittleFS" : "Firmware";
  const xhr = new XMLHttpRequest();

  setOtaProgress(0);
  setOtaStatus(t("ota.uploading", "{label} feltöltése: {file}", { label, file: file.name }), "busy");

  xhr.upload.onprogress = event => {
    if (!event.lengthComputable) return;
    setOtaProgress((event.loaded / event.total) * 100);
  };

  xhr.onload = () => {
    let data = {};
    try {
      data = JSON.parse(xhr.responseText || "{}");
    } catch (_) {
      data = {};
    }

    if (xhr.status >= 200 && xhr.status < 300 && data.ok) {
      setOtaProgress(100);
      setOtaStatus(t("ota.waitingRestart", "{label} frissítés kész. Várakozás az újraindulásra...", { label }), "busy");
      waitForOtaReconnect(label);
      return;
    }

    setOtaStatus(data.error || t("ota.failedStatus", "{label} frissítés sikertelen ({status})", { label, status: xhr.status }), "error");
  };

  xhr.onerror = () => setOtaStatus(t("ota.networkError", "{label} feltöltési hálózati hiba.", { label }), "error");
  xhr.onabort = () => setOtaStatus(t("ota.aborted", "{label} feltöltés megszakítva.", { label }), "error");
  xhr.open("POST", endpoint, true);
  xhr.setRequestHeader("Content-Type", "application/octet-stream");
  xhr.setRequestHeader("X-SimpleRadio-OTA-Password", password);
  xhr.send(file);
}

function initOtaUploads() {
  const firmwareInput = $("otaFirmwareInput");
  const fsInput = $("otaFilesystemInput");
  const firmwareDrop = $("otaFirmwareDrop");
  const fsDrop = $("otaFilesystemDrop");

  if (firmwareInput) {
    firmwareInput.onchange = () => {
      uploadOtaFile("firmware", firmwareInput.files?.[0]);
      firmwareInput.value = "";
    };
  }

  if (fsInput) {
    fsInput.onchange = () => {
      uploadOtaFile("filesystem", fsInput.files?.[0]);
      fsInput.value = "";
    };
  }

  const bindDrop = (drop, kind) => {
    if (!drop) return;
    ["dragenter", "dragover"].forEach(type => {
      drop.addEventListener(type, event => {
        event.preventDefault();
        drop.classList.add("drag-over");
      });
    });
    ["dragleave", "drop"].forEach(type => {
      drop.addEventListener(type, event => {
        event.preventDefault();
        drop.classList.remove("drag-over");
      });
    });
    drop.addEventListener("drop", event => uploadOtaFile(kind, event.dataTransfer.files?.[0]));
  };

  bindDrop(firmwareDrop, "firmware");
  bindDrop(fsDrop, "filesystem");
}

async function postStation(data) {
  const response = await fetch("/api/station/save", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data)
  });
  if (!response.ok) return null;
  return response.json();
}

async function saveStationData(data) {
  const saved = await postStation(data);
  if (!saved) return null;

  const localLogo = await uploadStationLogo(saved.id, data.logo);
  if (localLogo && localLogo !== data.logo) {
    await postStation({ ...data, id: String(saved.id), logo: localLogo });
  }

  return saved;
}

function queueOnlineSearch() {
  clearTimeout(searchTimer);
  resetOnlineSearchState();
  searchTimer = setTimeout(() => searchOnlineStations(false), 520);
}

function clearStationSearch() {
  const input = $("searchName");
  if (!input) return;
  input.value = "";
  resetOnlineSearchState();
  setText("searchStatus", "");
  input.focus();
}

function countryCodeFromInput(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

function resetOnlineSearchState(clearResults = true) {
  clearTimeout(searchTimer);
  if (searchAbortController) searchAbortController.abort();
  searchAbortController = null;
  if (onlineSearchObserver) onlineSearchObserver.disconnect();
  onlineSearchObserver = null;
  onlineSearchOffset = 0;
  onlineSearchHasMore = false;
  onlineSearchLoading = false;
  onlineSearchQueryKey = "";
  onlineSearchVisibleCount = 0;
  onlineSearchSeen = new Set();
  if (clearResults) $("searchResults").innerHTML = "";
}

function onlineStationKey(result) {
  return String(result.stationuuid || stationStreamUrl(result) || `${result.name || ""}|${result.countrycode || ""}`);
}

function loadMoreOnlineStations() {
  searchOnlineStations(true);
}

function openStationSearch() {
  showView("stations");
  const drawer = $("stationSearchDrawer");
  const editor = $("stationEditorDrawer");
  if (editor) editor.open = false;
  if (drawer) drawer.open = true;
  const input = $("searchName");
  if (input) setTimeout(() => input.focus(), 0);
}

function openStationEditor() {
  showView("stations");
  const drawer = $("stationEditorDrawer");
  const search = $("stationSearchDrawer");
  if (search) search.open = false;
  if (drawer) drawer.open = true;
  loadLogoChoices();
  const input = $("editName");
  if (input) setTimeout(() => input.focus(), 0);
}

function initStationDrawers() {
  const search = $("stationSearchDrawer");
  const editor = $("stationEditorDrawer");
  if (search) {
    search.addEventListener("toggle", () => {
      if (search.open && editor) editor.open = false;
    });
  }
  if (editor) {
    editor.addEventListener("toggle", () => {
      if (editor.open && search) search.open = false;
    });
  }
}

async function searchOnlineStations(append = false) {
  const country = countryCodeFromInput($("searchCountry").value);
  const name = $("searchName").value.trim();
  const queryKey = `${country}|${name.toLocaleLowerCase()}`;

  if (!country && name.length < 2) {
    if (!append) resetOnlineSearchState();
    setText("searchStatus", t("search.allNeedsName", "Az összes országhoz írj be legalább 2 karaktert"));
    return;
  }
  if (name.length > 0 && name.length < 2) {
    if (!append) resetOnlineSearchState();
    setText("searchStatus", t("search.minChars", "Legalább 2 karakter"));
    return;
  }

  if (append) {
    if (onlineSearchLoading || !onlineSearchHasMore || queryKey !== onlineSearchQueryKey) return;
  } else {
    resetOnlineSearchState();
    onlineSearchQueryKey = queryKey;
  }

  const controller = new AbortController();
  searchAbortController = controller;
  onlineSearchLoading = true;
  renderSearchMoreControl();

  setText(
    "searchStatus",
    append
      ? t("search.loadingMore", "További találatok...")
      : t("search.searching", "Keresés...")
  );
  try {
    const params = new URLSearchParams({
      limit: String(ONLINE_SEARCH_PAGE_SIZE),
      offset: String(onlineSearchOffset),
      hidebroken: "true",
      order: "clickcount",
      reverse: "true"
    });
    if (country) params.set("countrycode", country);
    if (name) params.set("name", name);

    const response = await fetch(`${RADIO_BROWSER_SEARCH_URL}?${params}`, {
      signal: controller.signal
    });
    if (!response.ok) {
      setText("searchStatus", t("search.failed", "Keresés sikertelen"));
      return;
    }
    const results = await response.json();
    if (controller !== searchAbortController || queryKey !== onlineSearchQueryKey) return;

    onlineSearchOffset += results.length;
    const uniqueResults = results.filter(result => {
      const streamUrl = stationStreamUrl(result);
      if (!result.name || !streamUrl) return false;
      const key = onlineStationKey(result);
      if (onlineSearchSeen.has(key)) return false;
      onlineSearchSeen.add(key);
      return true;
    });
    renderSearchResults(uniqueResults, append);
    onlineSearchVisibleCount += uniqueResults.length;
    onlineSearchHasMore = results.length === ONLINE_SEARCH_PAGE_SIZE;

    if (!onlineSearchVisibleCount) {
      setText("searchStatus", t("search.noResults", "Nincs találat"));
    } else if (onlineSearchHasMore) {
      setText("searchStatus", t("search.loadedMore", "{count} betöltve · görgess tovább", { count: onlineSearchVisibleCount }));
    } else {
      setText("searchStatus", t("search.results", "{count} találat", { count: onlineSearchVisibleCount }));
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    setText("searchStatus", t("search.networkError", "Hálózati hiba"));
  } finally {
    if (controller === searchAbortController) {
      searchAbortController = null;
      onlineSearchLoading = false;
      renderSearchMoreControl();
    }
  }
}

function renderSearchResults(results, append = false) {
  const list = $("searchResults");
  list.querySelector(".search-more")?.remove();
  if (!append) list.innerHTML = "";
  results.forEach(result => {
    const streamUrl = stationStreamUrl(result);
    if (!result.name || !streamUrl) return;

    const row = document.createElement("div");
    row.className = "result-item";

    const badge = document.createElement("span");
    badge.className = "station-badge";
    badge.textContent = stationInitial(result.name);
    if (result.favicon) {
      badge.classList.add("has-logo");
      badge.style.backgroundImage = `url("${String(result.favicon).replace(/"/g, "%22")}")`;
      badge.textContent = "";
    }

    const tags = [result.countrycode, result.codec].filter(Boolean).join(" / ");
    const info = document.createElement("div");
    info.innerHTML = `<span class="item-title">${escapeHtml(result.name)}</span><span class="item-meta">${escapeHtml(tags)}</span><span class="item-meta">${escapeHtml(streamUrl)}</span>`;

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const save = document.createElement("button");
    save.type = "button";
    save.textContent = t("save.idle", "Mentés");
    save.onclick = () => saveOnlineStation(result, save);
    actions.appendChild(save);

    row.append(badge, info, actions);
    list.appendChild(row);
  });
}

function renderSearchMoreControl() {
  const list = $("searchResults");
  list.querySelector(".search-more")?.remove();
  if (onlineSearchObserver) onlineSearchObserver.disconnect();
  onlineSearchObserver = null;
  if (!onlineSearchHasMore) return;

  const more = document.createElement("button");
  more.type = "button";
  more.className = "search-more ghost-btn";
  more.disabled = onlineSearchLoading;
  more.textContent = onlineSearchLoading
    ? t("search.loadingMore", "További találatok...")
    : t("search.more", "Továbbiak betöltése");
  more.onclick = loadMoreOnlineStations;
  list.appendChild(more);

  if (!onlineSearchLoading && "IntersectionObserver" in window) {
    onlineSearchObserver = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMoreOnlineStations();
    }, { rootMargin: "240px 0px" });
    onlineSearchObserver.observe(more);
  }
}

async function saveOnlineStation(result, button) {
  setButtonFeedback(button, "busy");
  setText("searchStatus", t("search.saving", "Mentés..."));
  const saved = await saveStationData({
    id: "",
    name: result.name || "",
    url: stationStreamUrl(result),
    logo: result.favicon || ""
  });

  if (saved) {
    setButtonFeedback(button, "success");
    setText("searchStatus", t("search.saved", "Állomás mentve"));
    await loadStations();
  } else {
    setButtonFeedback(button, "error");
    setText("searchStatus", t("search.saveFailed", "Mentés sikertelen"));
  }
  restoreButtonFeedback(button, saved ? 1400 : 2200);
}

function editStation(station) {
  setValue("editId", station.id);
  setValue("editName", station.name || "");
  setValue("editUrl", station.url || "");
  setValue("editLogo", station.logo || "");
  openStationEditor();
  renderLogoChoices();
  setTimeout(() => $("stationEditorDrawer")?.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
}

function clearStationForm(openEditor = true) {
  ["editId", "editName", "editUrl", "editLogo"].forEach(id => setValue(id, ""));
  renderLogoChoices();
  if (openEditor) openStationEditor();
}

async function saveStation(event) {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector("button[type='submit']");
  setButtonFeedback(button, "busy");

  try {
    const saved = await saveStationData({
      id: $("editId").value,
      name: $("editName").value,
      url: $("editUrl").value,
      logo: $("editLogo").value
    });

    if (saved) {
      setButtonFeedback(button, "success");
      clearStationForm(false);
      await loadStations();
    } else {
      setButtonFeedback(button, "error");
    }
    restoreButtonFeedback(button, saved ? 1400 : 2200);
  } catch (err) {
    console.warn("Station save failed", err);
    setButtonFeedback(button, "error");
    restoreButtonFeedback(button, 2200);
  }
}

async function deleteStation(id, button) {
  setButtonFeedback(button, "busy", t("stations.deleting", "Törlés..."));
  try {
    const response = await fetch("/api/station/delete", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id })
    });
    if (!response.ok) throw new Error(`Delete failed: ${response.status}`);
    await wait(350);
    await loadStations();
  } catch (err) {
    console.warn("Station delete failed", err);
    setButtonFeedback(button, "error");
    restoreButtonFeedback(button, 2200);
  }
}

async function moveStation(id, direction, button) {
  setButtonFeedback(button, "busy", "...");
  try {
    const response = await fetch("/api/station/move", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id, direction })
    });
    if (!response.ok) throw new Error(`Move failed: ${response.status}`);
    await loadStations();
  } catch (err) {
    console.warn("Station move failed", err);
    setButtonFeedback(button, "error");
    restoreButtonFeedback(button, 1800);
  }
}

function minutesToTime(value) {
  const minutes = Number(value || 0);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function timeToMinutes(value) {
  const [hh, mm] = String(value || "00:00").split(":").map(part => parseInt(part, 10) || 0);
  return hh * 60 + mm;
}

function setPercentLabel(id) {
  setText(`${id}Value`, percentFrom255($(id).value));
}

function setRawPercentLabel(id) {
  const value = clampNumber(parseInt($(id).value, 10), 0, 999, 100);
  setText(`${id}Value`, `${value}%`);
}

function syncEncoderSensitivity(value) {
  const sensitivity = clampNumber(parseInt(value, 10), 1, 8, 8);
  setValue("encoderSensitivity", sensitivity);
  setText("encoderSensitivityValue", `${sensitivity}/8`);
}

function setHardwarePanelState(panelId, badgeId, noticeId, available, badgeText, noticeText) {
  const panel = $(panelId);
  const badge = $(badgeId);
  const notice = $(noticeId);
  if (panel) panel.classList.toggle("is-hardware-unavailable", !available);
  if (badge) {
    badge.textContent = badgeText;
    badge.classList.toggle("is-unavailable", !available);
  }
  if (notice) {
    notice.textContent = noticeText || "";
    notice.classList.toggle("hidden", available || !noticeText);
  }
}

function syncEncoderControls() {
  const encoder1Available = !!hardwareCapabilities.encoder1?.available;
  const encoder2Available = !!hardwareCapabilities.encoder2?.available;
  const enabledToggle = $("encoderEnabled");
  const secondToggle = $("secondEncoderEnabled");
  const enabled = encoder1Available && !!enabledToggle?.checked;

  if (enabledToggle) {
    enabledToggle.disabled = !encoder1Available;
    if (!encoder1Available) enabledToggle.checked = false;
  }
  if (secondToggle) {
    secondToggle.disabled = !enabled || !encoder2Available;
    if (!encoder2Available || !enabled) secondToggle.checked = false;
  }

  ["encoderSensitivity", "encoderVolumeStep", "encoderLongPressMs"].forEach(id => {
    const control = $(id);
    if (control) control.disabled = !enabled;
  });

  ["encoderVolumePanel", "encoderStationPanel"].forEach(id => {
    const panel = $(id);
    if (panel) panel.classList.toggle("is-hardware-unavailable", !encoder1Available);
  });
  syncEncoderAutoPlay();
}

function syncIrSensitivity(value) {
  const sensitivity = clampNumber(parseInt(value, 10), 15, 60, 40);
  setValue("irSensitivity", sensitivity);
  setText("irSensitivityValue", `${sensitivity}%`);
}

function syncEncoderAutoPlay() {
  const toggle = $("encoderAutoPlayStation");
  const delay = $("encoderAutoPlayMs");
  if (!toggle || !delay) return;
  const encoderEnabled = !!hardwareCapabilities.encoder1?.available && !!$("encoderEnabled")?.checked;
  toggle.disabled = !encoderEnabled;
  delay.disabled = !encoderEnabled || !toggle.checked;
}

function syncDisplayIdleMode() {
  const enabled = $("displayIdleEnabled").checked;
  const mode = $("displayIdleMode").value || "dim";
  $("displayIdleMode").disabled = !enabled;
  $("displayIdleBlank").checked = enabled && mode === "blank";
  $("displayClockEnabled").checked = enabled && mode === "clock";
  $("displayClockOptions").classList.toggle("hidden", !enabled || mode !== "clock");
}

function syncDisplayFooterMode() {
  const footerMode = $("displayFooterMode").value || "volume";
  const vuField = $("displayVuStyleField");
  const vuSensitivityField = $("displayVuSensitivityField");
  if (vuField) vuField.classList.toggle("hidden", footerMode !== "vu");
  if (vuSensitivityField) vuSensitivityField.classList.toggle("hidden", footerMode !== "vu" && footerMode !== "spectrum");
}

function normalizeHexColor(value, fallback = "#a9f7bf") {
  const color = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : fallback;
}

function validHexColor(value) {
  const color = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : "";
}

function syncThemeCustomControls() {
  const customField = $("themeCustomColorField");
  if (customField) customField.classList.toggle("hidden", normalizeThemeAccent($("themeAccent")?.value || "green") !== "custom");
}

function syncThemeCustomColorFromPicker() {
  const color = normalizeHexColor($("themeCustomColor")?.value, "#a9f7bf");
  setValue("themeCustomColorText", color);
  if ($("themeAccent")) setValue("themeAccent", "custom");
  applyThemeAccent("custom");
}

function syncThemeCustomColorFromText() {
  const color = validHexColor($("themeCustomColorText")?.value);
  if (!color) return;
  setValue("themeCustomColor", color);
  setValue("themeCustomColorText", color);
  if (normalizeThemeAccent($("themeAccent")?.value || "green") === "custom") applyThemeAccent("custom");
}

function syncFrontLedColorFromPicker() {
  const color = normalizeHexColor($("frontLedColor")?.value, "#a9f7bf");
  setValue("frontLedColorText", color);
}

function syncFrontLedColorFromText() {
  const color = validHexColor($("frontLedColorText")?.value);
  if (!color) return;
  setValue("frontLedColor", color);
  setValue("frontLedColorText", color);
}

function syncFrontLedColorText() {
  syncFrontLedColorFromText();
}

function syncFrontLedControls() {
  const available = !!hardwareCapabilities.frontRgbLed?.available;
  const enabledToggle = $("frontLedEnabled");
  if (enabledToggle) {
    enabledToggle.disabled = !available;
    if (!available) enabledToggle.checked = false;
  }
  const enabled = available && (enabledToggle?.checked ?? false);
  const useTheme = $("frontLedUseTheme")?.checked ?? true;
  const theme = $("frontLedUseTheme");
  const brightness = $("frontLedBrightness");
  const standbyBrightness = $("frontLedStandbyBrightness");
  const color = $("frontLedColor");
  const colorText = $("frontLedColorText");

  if (theme) theme.disabled = !enabled;
  if (brightness) brightness.disabled = !enabled;
  if (standbyBrightness) standbyBrightness.disabled = !enabled;
  if (color) color.disabled = !enabled || useTheme;
  if (colorText) colorText.disabled = !enabled || useTheme;
}

function syncIrHardwareControls() {
  const available = !!hardwareCapabilities.ir?.available;
  const enabled = $("irEnabled");
  const sensitivity = $("irSensitivity");
  if (enabled) {
    enabled.disabled = !available;
    if (!available) enabled.checked = false;
  }
  if (sensitivity) sensitivity.disabled = !available;
  const workbench = $("irWorkbench");
  if (workbench) workbench.classList.toggle("is-hardware-unavailable", !available);
  document.querySelectorAll("#irWorkbench button").forEach(button => {
    button.disabled = !available;
  });
}

function applyHardwareCapabilitiesToUI() {
  const encoderCount = Number(hardwareCapabilities.encoderCount || 0);
  const encoder1Available = !!hardwareCapabilities.encoder1?.available;
  const encoder2Available = !!hardwareCapabilities.encoder2?.available;
  setHardwarePanelState(
    "encoderHardwarePanel",
    "encoderHardwareBadge",
    "encoderHardwareNotice",
    encoder1Available,
    encoder1Available
      ? t("hardware.encoderCount", "{count} enkóder", { count: encoderCount })
      : t("hardware.none", "Nincs"),
    t("hardware.encoderUnavailable", "Ebben a firmware hardverprofilban nincs enkóder.")
  );
  setText(
    "encoder2HardwareHint",
    encoder2Available ? "" : t("hardware.encoder2Unavailable", "A hardverprofil csak egy enkódert tartalmaz.")
  );

  const ledAvailable = !!hardwareCapabilities.frontRgbLed?.available;
  const ledType = String(hardwareCapabilities.frontRgbLed?.type || "none");
  const ledTypeLabel = ledType === "pwm" ? "PWM" : ledType === "neopixel" ? "NeoPixel" : t("hardware.none", "Nincs");
  setHardwarePanelState(
    "frontLedPanel",
    "frontLedHardwareBadge",
    "frontLedHardwareNotice",
    ledAvailable,
    ledTypeLabel,
    t("hardware.frontLedUnavailable", "Az előlapi RGB LED nincs engedélyezve a firmware hardverprofiljában.")
  );

  const irAvailable = !!hardwareCapabilities.ir?.available;
  const irNotice = $("irHardwareNotice");
  if (irNotice) {
    irNotice.textContent = t("hardware.irUnavailable", "Az IR-vevő nincs engedélyezve a firmware hardverprofiljában.");
    irNotice.classList.toggle("hidden", irAvailable);
  }

  syncEncoderControls();
  syncFrontLedControls();
  syncIrHardwareControls();
}

function collectConfig() {
  const dualEncoder = !!hardwareCapabilities.encoder2?.available && $("secondEncoderEnabled").checked;
  syncDisplayIdleMode();
  syncDisplayFooterMode();
  syncThemeCustomColorFromText();
  syncFrontLedColorFromText();
  const data = {
    displayInvert: $("displayInvert").checked ? "1" : "0",
    brightness: $("brightness").value,
    displayIdleEnabled: $("displayIdleEnabled").checked ? "1" : "0",
    displayIdleBlank: $("displayIdleBlank").checked ? "1" : "0",
    displayIdleSeconds: $("displayIdleSeconds").value,
    displayIdleBrightness: $("displayIdleBrightness").value,
    displayClockEnabled: $("displayClockEnabled").checked ? "1" : "0",
    displayClockStyle: $("displayClockStyle").value,
    displayFooterMode: $("displayFooterMode").value,
    displayArtworkMode: $("displayArtworkMode").value,
    displayVuStyle: $("displayVuStyle").value,
    displayVuSensitivity: $("displayVuSensitivity").value,
    themeAccent: normalizeThemeAccent($("themeAccent").value),
    themeCustomColor: normalizeHexColor($("themeCustomColor").value),
    timeZone: $("timeZone").value,
    autoBrightness: $("autoBrightness").checked ? "1" : "0",
    dayStartMinute: String(timeToMinutes($("dayStartTime").value)),
    nightStartMinute: String(timeToMinutes($("nightStartTime").value)),
    dayBrightness: $("dayBrightness").value,
    nightBrightness: $("nightBrightness").value,
    irEnabled: $("irEnabled").checked ? "1" : "0",
    irSensitivity: $("irSensitivity").value,
    irActionLearning: $("irActionLearning").value,
    encoderEnabled: $("encoderEnabled").checked ? "1" : "0",
    secondEncoderEnabled: dualEncoder ? "1" : "0",
    encoderMode: dualEncoder ? "dual_volume_station" : "single_volume_picker",
    encoderSensitivity: $("encoderSensitivity").value,
    encoderVolumeStep: $("encoderVolumeStep").value,
    encoderLongPressMs: $("encoderLongPressMs").value,
    encoderAutoPlayStation: $("encoderAutoPlayStation").checked ? "1" : "0",
    encoderAutoPlayMs: $("encoderAutoPlayMs").value,
    mqttEnabled: $("mqttEnabled").checked ? "1" : "0",
    mqttHost: $("mqttHost").value,
    mqttPort: $("mqttPort").value,
    mqttUser: $("mqttUser").value,
    mqttPassword: $("mqttPassword").value,
    mqttRootTopic: $("mqttRootTopic").value,
    streamRetryEnabled: $("streamRetryEnabled").checked ? "1" : "0",
    streamRetryMs: $("streamRetryMs").value,
    autoStart: $("autoStart").checked ? "1" : "0",
    volumeCurve: $("volumeCurve").value,
    frontLedEnabled: $("frontLedEnabled").checked ? "1" : "0",
    frontLedUseTheme: $("frontLedUseTheme").checked ? "1" : "0",
    frontLedBrightness: $("frontLedBrightness").value,
    frontLedStandbyBrightness: $("frontLedStandbyBrightness").value,
    frontLedColor: normalizeHexColor($("frontLedColor").value)
  };
  const lastFmApiKey = $("lastFmApiKey").value.trim();
  if (lastFmApiKey) data.lastFmApiKey = lastFmApiKey;
  irActions.forEach(item => {
    data[irKey(item.action)] = String(currentConfig[irKey(item.action)] || "0");
  });
  inactiveIrActions.forEach(action => {
    data[irKey(action)] = "0";
  });
  return data;
}

async function postConfig(action = {}) {
  configSaveTimer = null;
  Object.assign(deferredConfigAction, action);
  if (meterSensitivityEditing || sliderGestures.size) {
    configSaveDeferred = true;
    setConfigSaveState("pending");
    return false;
  }
  if (configSaving) {
    configSavePending = true;
    setConfigSaveState("pending");
    return false;
  }

  configSaving = true;
  configSaveDeferred = false;
  setConfigSaveState("busy");
  let savedOk = false;

  try {
    const submittedConfig = { ...collectConfig(), ...deferredConfigAction };
    deferredConfigAction = {};
    const submittedSensitivityRevision = meterSensitivityRevision;
    const submittedSliderRevisions = new Map([...sliderDirty].map(([id, dirty]) => [id, dirty.revision]));
    if (submittedConfig.clearLastFmApiKey === "1") delete submittedConfig.lastFmApiKey;
    const response = await fetch("/api/config/save", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(submittedConfig)
    });
    if (!response.ok) throw new Error(`Config save failed: ${response.status}`);
    const savedConfig = await response.json();
    acknowledgeConfigSliders(savedConfig, submittedConfig, submittedSliderRevisions);
    if (!meterSensitivityEditing && submittedSensitivityRevision === meterSensitivityRevision &&
        Number(savedConfig.displayVuSensitivity) === Number(submittedConfig.displayVuSensitivity)) {
      meterSensitivityDirty = false;
    }
    applyConfigToUI(savedConfig);
    const keyStatus = $("lastFmApiKeyStatus");
    if (submittedConfig.lastFmApiKey) {
      setText("lastFmApiKeyStatus", "A Last.fm API-kulcs sikeresen elmentve.");
      keyStatus?.classList.add("is-saved");
      keyStatus?.classList.remove("is-error");
    } else if (submittedConfig.clearLastFmApiKey === "1") {
      setText("lastFmApiKeyStatus", savedConfig.hasLastFmApiKey
        ? "A weben mentett kulcs törölve. Az előre megadott firmware-kulcs aktív."
        : "A mentett Last.fm API-kulcs törölve.");
      keyStatus?.classList.toggle("is-saved", !!savedConfig.hasLastFmApiKey);
      keyStatus?.classList.remove("is-error");
    }
    savedOk = true;
    return true;
  } catch (err) {
    console.warn("Config save failed", err);
    setText("lastFmApiKeyStatus", "A mentés nem sikerült. Ellenőrizd a kapcsolatot, majd próbáld újra.");
    $("lastFmApiKeyStatus")?.classList.add("is-error");
    $("lastFmApiKeyStatus")?.classList.remove("is-saved");
    return false;
  } finally {
    configSaving = false;
    if (configSavePending) {
      configSavePending = false;
      postConfig();
    } else if (configSaveDeferred || sliderGestures.size || meterSensitivityEditing) {
      setConfigSaveState("pending");
    } else {
      setConfigSaveState(savedOk ? "success" : "error");
    }
  }
}

function queueConfigSave() {
  clearTimeout(configSaveTimer);
  setConfigSaveState("pending");
  if (meterSensitivityEditing || sliderGestures.size) { configSaveDeferred = true; return; }
  configSaveTimer = setTimeout(postConfig, 140);
}

function previewMeterSensitivity() {
  meterSensitivityEditing = true;
  meterSensitivityDirty = true;
  ++meterSensitivityRevision;
  clearTimeout(configSaveTimer);
  setRawPercentLabel("displayVuSensitivity");
  meterSensitivityPending = $("displayVuSensitivity").value;
  clearTimeout(meterSensitivityTimer);
  meterSensitivityTimer = setTimeout(flushMeterSensitivity, 80);
}

function flushMeterSensitivity() {
  if (meterSensitivityFlight) return meterSensitivityFlight;
  meterSensitivityFlight = (async () => {
    while (meterSensitivityPending !== null) {
      const value = meterSensitivityPending;
      meterSensitivityPending = null;
      try {
        const response = await fetch("/api/display/sensitivity", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ value })
        });
        if (!response.ok) throw new Error("Sensitivity preview failed");
      } catch (err) {
        console.warn("Sensitivity preview failed", err);
      }
    }
  })().finally(() => { meterSensitivityFlight = null; });
  return meterSensitivityFlight;
}

async function commitMeterSensitivity() {
  if (!meterSensitivityEditing) return;
  const revision = meterSensitivityRevision;
  clearTimeout(meterSensitivityTimer);
  await flushMeterSensitivity();
  if (revision !== meterSensitivityRevision) return;
  meterSensitivityEditing = false;
  queueConfigSave();
}

function saveConfigNow() {
  clearTimeout(configSaveTimer);
  postConfig();
}

function updateLastFmDeleteButton() {
  const button = $("deleteLastFmApiKey");
  if (!button) return;
  button.disabled = configSaving || !currentConfig.hasSavedLastFmApiKey;
  button.setAttribute("aria-busy", configSaving ? "true" : "false");
}

function deleteSavedLastFmKey() {
  if (configSaving || !currentConfig.hasSavedLastFmApiKey) return;
  clearTimeout(configSaveTimer);
  return postConfig({ clearLastFmApiKey: "1" });
}

function setLastFmKeyPending() {
  const status = $("lastFmApiKeyStatus");
  if (!status) return;
  setText("lastFmApiKeyStatus", "A kulcs még nincs elmentve — kattints az API-kulcs mentése gombra.");
  status.classList.remove("is-saved", "is-error");
}

function syncEqLabels(low, mid, high) {
  [["eqLow", low], ["soundEqLow", low], ["eqMid", mid], ["soundEqMid", mid], ["eqHigh", high], ["soundEqHigh", high]].forEach(([id, value]) => {
    setValue(id, value);
    setText(`${id}Value`, dbLabel(value));
  });
}

function renderRemote() {
  const remote = $("irRemote");
  remote.innerHTML = "";
  irLayout.forEach(item => {
    if (!item) {
      const spacer = document.createElement("span");
      spacer.className = "remote-spacer";
      remote.appendChild(spacer);
      return;
    }

    const button = document.createElement("button");
    const code = String(currentConfig[irKey(item.action)] || "0");
    button.type = "button";
    button.className = `remote-btn ${item.cls || ""}${item.round ? " round" : ""}${selectedIrAction === item.action ? " active" : ""}${code !== "0" ? " learned" : ""}`;
    button.textContent = item.text;
    button.title = irActionLabel(item);
    button.disabled = !hardwareCapabilities.ir?.available;
    button.onclick = () => startIrLearning(item.action);
    remote.appendChild(button);
  });
}

function renderIrMappedList() {
  const list = $("irMappedList");
  list.innerHTML = "";
  irActions.forEach(item => {
    const code = String(currentConfig[irKey(item.action)] || "0");
    const row = document.createElement("div");
    row.className = `mapped-pill${code !== "0" ? " learned" : ""}`;
    row.innerHTML = `<strong>${escapeHtml(irActionLabel(item))}</strong><small>${code !== "0" ? escapeHtml(code) : t("ir.notLearned", "Nincs kód")}</small>`;
    list.appendChild(row);
  });
}

function updateIrPanel() {
  const learning = currentConfig.irActionLearning || "";
  const activeAction = learning || selectedIrAction;
  const active = irActions.find(item => item.action === activeAction);
  const code = active ? String(currentConfig[irKey(active.action)] || "0") : "0";

  setText("irPanelTitle", active ? irActionLabel(active) : t("ir.recorder", "Gombok tanítása"));
  setText("irPanelHelp", active ? t("ir.recordHelpActive", "Nyomd meg most a fizikai távirányító megfelelő gombját.") : t("ir.recordHelpIdle", "Válassz egy gombot, majd tanítsd be."));
  setText("irLearnStatus", learning ? t("ir.learning", "Tanítás: {action}", { action: active ? irActionLabel(active) : learning }) : t("ir.ready", "Készenlét"));
  setText("irPrimaryCode", code !== "0" ? code : t("ir.notLearned", "Nincs kód"));
  renderRemote();
  renderIrMappedList();
  syncIrHardwareControls();
}

function startIrLearning(action) {
  if (!hardwareCapabilities.ir?.available) return;
  if (!configLoaded) {
    loadConfig().then(() => startIrLearning(action));
    return;
  }
  selectedIrAction = action;
  $("irEnabled").checked = true;
  $("irActionLearning").value = action;
  saveConfigNow();
  clearInterval(irPollTimer);
  irPollTimer = setInterval(loadConfig, 1000);
}

function cancelIrLearning() {
  selectedIrAction = "";
  $("irActionLearning").value = "";
  clearInterval(irPollTimer);
  saveConfigNow();
}

function clearSelectedIr() {
  const action = selectedIrAction || currentConfig.irActionLearning;
  if (!action) return;
  currentConfig[irKey(action)] = "0";
  $("irActionLearning").value = "";
  selectedIrAction = action;
  saveConfigNow();
}

function applyConfigToUI(config) {
  currentConfig = config;
  configLoaded = true;
  if (!config.irActionLearning) clearInterval(irPollTimer);

  $("displayInvert").checked = !!config.displayInvert;
  setConfigValue("brightness", config.brightness || 0);
  setPercentLabel("brightness");
  $("displayIdleEnabled").checked = !!config.displayIdleEnabled;
  $("displayIdleBlank").checked = !!config.displayIdleBlank;
  setConfigValue("displayIdleSeconds", config.displayIdleSeconds || 120);
  setConfigValue("displayIdleBrightness", config.displayIdleBrightness ?? 16);
  setPercentLabel("displayIdleBrightness");
  $("displayClockEnabled").checked = !!config.displayClockEnabled;
  setConfigValue("displayClockStyle", config.displayClockStyle || "digital");
  setConfigValue("displayFooterMode", config.displayFooterMode || "volume");
  setConfigValue("displayArtworkMode", config.displayArtworkMode || "logo");
  setConfigValue("lastFmApiKey", "");
  $("lastFmApiKey").placeholder = config.hasSavedLastFmApiKey
    ? "Van mentett kulcs — üresen hagyva megmarad"
    : config.hasLastFmApiKey ? "Előre megadott kulcs aktív — új kulcs beillesztése" : "API-kulcs beillesztése";
  setText("lastFmApiKeyStatus", config.hasSavedLastFmApiKey
    ? "API-kulcs elmentve. A mező biztonsági okból nem jeleníti meg."
    : config.hasLastFmApiKey ? "A firmware-ben előre megadott API-kulcs aktív."
      : "A kulcs nincs megadva.");
  updateLastFmDeleteButton();
  $("lastFmApiKeyStatus")?.classList.toggle("is-saved", !!config.hasLastFmApiKey);
  $("lastFmApiKeyStatus")?.classList.remove("is-error");
  setConfigValue("displayVuStyle", config.displayVuStyle || "bars");
  if (!meterSensitivityEditing && !meterSensitivityDirty) setConfigValue("displayVuSensitivity", config.displayVuSensitivity || 100);
  setRawPercentLabel("displayVuSensitivity");
  const themeColor = normalizeHexColor(config.themeCustomColor || "#a9f7bf");
  setConfigValue("themeCustomColor", themeColor);
  setConfigValue("themeCustomColorText", themeColor);
  setConfigValue("themeAccent", config.themeAccent || "green");
  syncThemeAccent();
  syncDisplayFooterMode();
  setConfigValue("timeZone", config.timeZone || "CET-1CEST,M3.5.0/2,M10.5.0/3");
  const idleMode = config.displayClockEnabled ? "clock" : (config.displayIdleBlank ? "blank" : "dim");
  setConfigValue("displayIdleMode", idleMode);
  syncDisplayIdleMode();
  $("autoBrightness").checked = !!config.autoBrightness;
  setConfigValue("dayStartTime", minutesToTime(config.dayStartMinute ?? 420));
  setConfigValue("nightStartTime", minutesToTime(config.nightStartMinute ?? 1320));
  setConfigValue("dayBrightness", config.dayBrightness || 0);
  setPercentLabel("dayBrightness");
  setConfigValue("nightBrightness", config.nightBrightness || 0);
  setPercentLabel("nightBrightness");

  $("irEnabled").checked = !!config.irEnabled;
  setConfigValue("irSensitivity", config.irSensitivity || 40);
  syncIrSensitivity($("irSensitivity").value);
  setConfigValue("irActionLearning", config.irActionLearning || "");
  if (config.irActionLearning) selectedIrAction = config.irActionLearning;
  updateIrPanel();

  $("encoderEnabled").checked = !!config.encoderEnabled;
  $("secondEncoderEnabled").checked = !!config.secondEncoderEnabled;
  setConfigValue("encoderSensitivity", config.encoderSensitivity || 8);
  syncEncoderSensitivity($("encoderSensitivity").value);
  setConfigValue("encoderVolumeStep", config.encoderVolumeStep || 5);
  setConfigValue("encoderLongPressMs", config.encoderLongPressMs || 700);
  $("encoderAutoPlayStation").checked = config.encoderAutoPlayStation !== false;
  setConfigValue("encoderAutoPlayMs", config.encoderAutoPlayMs || 2500);
  syncEncoderControls();

  $("mqttEnabled").checked = !!config.mqttEnabled;
  setConfigValue("mqttHost", config.mqttHost || "");
  setConfigValue("mqttPort", config.mqttPort || 1883);
  setConfigValue("mqttUser", config.mqttUser || "");
  setConfigValue("mqttPassword", config.mqttPassword || "");
  setConfigValue("mqttRootTopic", config.mqttRootTopic || "simpleradio");
  $("streamRetryEnabled").checked = config.streamRetryEnabled !== false;
  setConfigValue("streamRetryMs", config.streamRetryMs || 5000);
  $("autoStart").checked = !!config.autoStart;
  setConfigValue("volumeCurve", config.volumeCurve || "soft");
  syncVolumeCurve();
  $("frontLedEnabled").checked = !!config.frontLedEnabled;
  $("frontLedUseTheme").checked = config.frontLedUseTheme !== false;
  setConfigValue("frontLedBrightness", config.frontLedBrightness ?? 128);
  setPercentLabel("frontLedBrightness");
  setConfigValue("frontLedStandbyBrightness", config.frontLedStandbyBrightness ?? 13);
  setPercentLabel("frontLedStandbyBrightness");
  const ledColor = normalizeHexColor(config.frontLedColor || "#a9f7bf");
  setConfigValue("frontLedColor", ledColor);
  setConfigValue("frontLedColorText", ledColor);
  syncFrontLedControls();
}

async function loadConfig() {
  const response = await fetch("/api/config");
  if (response.ok) applyConfigToUI(await response.json());
}

async function loadHardwareCapabilities() {
  try {
    const response = await fetch("/api/hardware", { cache: "no-store" });
    if (!response.ok) throw new Error(`Hardware capabilities failed: ${response.status}`);
    hardwareCapabilities = await response.json();
  } catch (err) {
    console.warn("Hardware capabilities failed", err);
  }
  applyHardwareCapabilitiesToUI();
}

async function loadDeviceConfig() {
  await loadHardwareCapabilities();
  await loadConfig();
}

async function loadStations() {
  const response = await fetch("/api/stations");
  const data = await response.json();
  stations = data.stations || [];
  stationAssetRevision = Date.now();
  renderStations(true);
}

function applyArtworkNode(node, path, key, fallbackText = "SR") {
  if (!node) return;
  const nextKey = path ? `${path}|${key || ""}` : `fallback|${fallbackText}`;
  if (node.dataset.artworkKey === nextKey) return;
  node.dataset.artworkKey = nextKey;

  if (path) {
    const separator = String(path).includes("?") ? "&" : "?";
    const cacheSafePath = `${path}${separator}sr=${encodeURIComponent(key || stationAssetRevision)}`;
    node.style.backgroundImage = `url("${String(cacheSafePath).replace(/"/g, "%22")}")`;
    node.textContent = "";
    node.classList.add("has-logo");
  } else {
    node.style.backgroundImage = "";
    node.textContent = fallbackText;
    node.classList.remove("has-logo");
  }
}

function updateCover(state) {
  const cachedPath = String(state.cachedArtworkPath || "");
  const webCachedPath = cachedPath.toLowerCase().endsWith(".sr565") ? "" : cachedPath;
  const albumPath = String(state.albumArtworkPath || "");
  const webAlbumPath = albumPath.toLowerCase().endsWith(".sr565") ? "" : albumPath;
  const useAlbum = currentConfig.displayArtworkMode === "album";
  const path = (useAlbum && state.hasStreamImage && webCachedPath) ||
    (useAlbum && webAlbumPath) || webCachedPath || state.streamLogoUrl || state.stationLogo || "";
  const logoKey = [
    state.stationId,
    state.cachedArtworkPath || "",
    state.albumArtworkPath || "",
    state.streamLogoUrl || "",
    state.stationLogo || "",
  ].join("|");
  const fallback = stationInitial(state.station || "SR");

  applyArtworkNode($("webCoverArt"), path, logoKey, fallback);
  applyArtworkNode($("brandMark"), path, logoKey, fallback);
  cacheArtworkViaBrowser(state);
}

function updatePlayButtons() {
  const text = playing ? t("player.stop", "Stop") : t("player.play", "Play");
  const chip = $("playState");
  setText("playState", playing ? "PLAY" : "STOP");
  if (chip) chip.classList.toggle("is-playing", playing);

  ["playButton", "playButtonSmall"].forEach(id => {
    const button = $(id);
    if (!button) return;
    button.setAttribute("aria-label", text);
    button.title = text;
    if (id === "playButtonSmall") button.textContent = text;
    button.classList.toggle("is-playing", playing);
  });
}

function streamConnectionMessage(state) {
  const connectionState = state.streamConnectionState || "idle";
  if (connectionState === "waiting_for_network") return t("stream.waitingForNetwork", "Nincs WiFi kapcsolat · újracsatlakozás...");
  if (connectionState === "connecting") return t("stream.connecting", "Kapcsolódás az adóhoz...");
  if (connectionState === "retry_waiting") {
    const failures = Number(state.streamConnectFailures || 0);
    return failures > 0
      ? t("stream.retryingCount", "Sikertelen kapcsolódás · újrapróbálkozás ({count})", { count: failures })
      : t("stream.retrying", "A stream megszakadt · újrapróbálkozás...");
  }
  if (connectionState === "failed") return t("stream.failed", "Az adó nem érhető el, az automatikus újrapróbálkozás ki van kapcsolva.");
  return "";
}

function updateUI(state) {
  acknowledgePlayerSliders(state);
  const previousStationId = currentStationId;
  playing = !!state.playing;
  currentStationId = state.stationId;
  const stationSelectionChanged = previousStationId !== currentStationId;
  updatePlayButtons();

  setText("connectionInfo", state.station || t("state.noStation", "Nincs állomás"));
  const shownVolume = sliderIsProtected("volume") ? numberValue("volume", state.volume) : state.volume;
  setValue("volume", shownVolume);
  setText("volValue", `${shownVolume}%`);

  const low = sliderIsProtected("soundEqLow") ? eqValue("low") : state.eqLow || 0;
  const mid = sliderIsProtected("soundEqMid") ? eqValue("mid") : state.eqMid || 0;
  const high = sliderIsProtected("soundEqHigh") ? eqValue("high") : state.eqHigh || 0;
  syncEqLabels(low, mid, high);
  syncBalance(sliderIsProtected("soundBalance") ? numberValue("soundBalance") : state.balance || 0);

  const connectionMessage = playing ? streamConnectionMessage(state) : "";
  const meta = playing ? [state.artist, state.title].filter(Boolean).join(" - ") : "";
  setText("meta", playing ? (connectionMessage || meta || t("state.noMetadata", "Nincs metadata")) : t("state.playbackPaused", "Lejátszás szünetel"));
  setText("current-station", state.station || t("state.chooseStation", "Állomás kiválasztása"));
  updateCover(state);
  if (stationSelectionChanged) renderStations();
}

applyLanguage();
renderRemote();
initLogoDropZone();
initOtaUploads();
initStationDrawers();
initSliderControls();
window.addEventListener("resize", () => requestAnimationFrame(drawVolumeCurvePreview));
applyHardwareCapabilitiesToUI();
loadWebUiBranding();
loadLogoChoices();
loadStations();
loadDeviceConfig();
connectWS();
