(function (root) {
  "use strict";
  const keys = ["frontLedType", "frontLedCount", "frontLedDataPin", "frontLedRedPin", "frontLedGreenPin", "frontLedBluePin", "frontLedInverted", "frontLedOrder"];
  const defaults = { frontLedType: "none", frontLedCount: 1, frontLedDataPin: 48, frontLedRedPin: 40, frontLedGreenPin: 39, frontLedBluePin: 38, frontLedInverted: false, frontLedOrder: "GRB" };
  const orders = ["RGB", "RBG", "GRB", "GBR", "BRG", "BGR"];
  const normalized = value => Object.fromEntries(keys.map(key => [key, key === "frontLedInverted" ? !!value[key] : key.endsWith("Pin") || key === "frontLedCount" ? Number(value[key] ?? defaults[key]) : String(value[key] ?? defaults[key])]));
  const same = (a, b) => keys.every(key => a[key] === b[key]);
  function preview(count, start, reverse, volume = 50) {
    count = Math.max(1, Math.min(64, Math.trunc(Number(count) || 1)));
    const first = (Math.max(1, Math.trunc(Number(start) || 1)) - 1) % count;
    const filled = Math.ceil(count * Math.max(0, Math.min(100, Number(volume) || 0)) / 100);
    return Array.from({ length: count }, (_, physical) => ({
      first: physical === first,
      lit: (reverse ? (first + count - physical) % count : (physical + count - first) % count) < filled
    }));
  }
  function validate(value, hardware) {
    if (!["none", "pwm", "neopixel"].includes(value.frontLedType) || !orders.includes(value.frontLedOrder)) return "invalid";
    if (!Number.isInteger(value.frontLedCount) || value.frontLedCount < 1 || value.frontLedCount > Number(hardware.maxCount || 64)) return "countError";
    const pin = key => Number.isInteger(value[key]) && (hardware.pins || []).includes(value[key]);
    if (value.frontLedType === "neopixel" && !pin("frontLedDataPin")) return "pinError";
    if (value.frontLedType === "pwm") {
      const channels = ["frontLedRedPin", "frontLedGreenPin", "frontLedBluePin"];
      if (!channels.every(pin)) return "pinError";
      if (new Set(channels.map(key => value[key])).size !== 3) return "duplicatePins";
    }
    return "";
  }
  if (typeof module === "object" && module.exports) module.exports = { keys, defaults, normalized, same, validate, preview };
  if (!root.document) return;
  const $ = id => root.document.getElementById(id);
  const tr = (key, vars) => root.srT ? root.srT("led." + key, key, vars) : key;
  let cap = {}, saved = normalized(defaults), active = normalized(defaults), dirty = false, saving = false, initialized = false;
  let volumeConfig = {};
  function volumePreview() {
    const strip = volumeConfig.frontLedType === "neopixel";
    const count = Math.max(1, Math.min(64, Number(volumeConfig.frontLedCount) || 1));
    const panel = $("frontLedVolumeControls");
    panel.classList.toggle("hidden", !cap.volumeCue);
    const enabled = !!$("frontLedVolumeEnabled").checked;
    root.document.querySelectorAll("[data-led-volume-geometry]").forEach(row => row.classList.toggle("hidden", !strip || !enabled));
    $("frontLedVolumeHelp").textContent = tr(strip && count > 1 ? "volumeStripHelp" : "volumeSingleHelp");
    const start = $("frontLedStartPixel");
    if (start.options.length !== count) {
      const selected = Math.max(1, Math.min(count, Number(volumeConfig.frontLedStartPixel) || 1));
      start.replaceChildren();
      for (let i = 1; i <= count; i++) { const option = root.document.createElement("option"); option.value = String(i); option.textContent = String(i); start.append(option); }
      start.value = String(selected);
    }
    const view = $("frontLedVolumePreview"); view.classList.toggle("hidden", !strip || !enabled);
    $("frontLedVolumePreviewLabel").classList.toggle("hidden", !strip || !enabled);
    view.replaceChildren();
    if (strip && enabled) for (const item of preview(count, start.value, $("frontLedReverse").value === "1")) {
      const dot = root.document.createElement("i"); dot.classList.toggle("is-lit", item.lit); dot.classList.toggle("is-first", item.first); view.append(dot);
    }
  }
  function values() {
    const value = Object.fromEntries(keys.map(key => [key, $(key).value]));
    value.frontLedInverted = value.frontLedInverted === "1";
    return normalized(value);
  }
  function write(value) {
    for (const key of keys) {
      const node = $(key), text = key === "frontLedInverted" ? value[key] ? "1" : "0" : String(value[key]);
      if (key.endsWith("Pin") && ![...node.options].some(option => option.value === text)) {
        const option = root.document.createElement("option"); option.value = text;
        option.textContent = value[key] < 0 ? tr("choosePin") : "GPIO " + text + " (" + tr("unavailablePin") + ")";
        node.append(option);
      }
      node.value = text;
    }
  }
  function refresh(message = "", error = false) {
    if (!initialized) return;
    const value = values(), issue = validate(value, cap);
    $("frontLedSetup").classList.toggle("hidden", !cap.runtimeConfig);
    root.document.querySelectorAll("[data-led-type]").forEach(row => row.classList.toggle("hidden", row.dataset.ledType !== value.frontLedType));
    for (const key of keys) $(key).disabled = saving || !cap.runtimeConfig;
    $("saveLedHardware").disabled = saving || !dirty || !!issue || !cap.runtimeConfig;
    $("cancelLedHardware").disabled = saving || !dirty;
    $("saveLedHardware").setAttribute("aria-busy", String(saving));
    const pending = !same(saved, active);
    $("rebootLedHardware").classList.toggle("hidden", !pending || dirty || saving);
    const status = $("frontLedSetupStatus");
    status.textContent = message || (dirty ? tr(issue || "unsaved") : pending ? tr("rebootRequired") : cap.ready === false ? tr("driverError", { reason: cap.error || "hardware" }) : tr("ready"));
    status.classList.toggle("is-error", error || (dirty && !!issue) || cap.ready === false);
    if (cap.runtimeConfig) {
      $("frontLedPanel").classList.remove("is-hardware-unavailable");
      $("frontLedHardwareNotice").classList.add("hidden");
      const label = saved.frontLedType === "pwm" ? "RGB" : saved.frontLedType === "neopixel" ? "WS2812 · " + saved.frontLedCount : tr("none");
      $("frontLedHardwareBadge").textContent = label;
      $("frontLedHardwareBadge").classList.toggle("is-unavailable", saved.frontLedType === "none");
    }
    volumePreview();
  }
  async function save() {
    if (saving || !dirty || validate(values(), cap)) return;
    // Hardware is one explicit transaction. An ordinary color/brightness save
    // never includes this draft, even while a hardware form is being edited.
    if (configSaving || sliderGestures.size) { refresh(tr("wait")); return; }
    const submitted = values(); saving = true; refresh(tr("saving"));
    const action = { ...submitted, frontLedInverted: submitted.frontLedInverted ? "1" : "0" };
    let ok = false;
    try { ok = await postConfig(action); } finally { saving = false; }
    if (ok) { saved = normalized(currentConfig); dirty = false; write(saved); refresh(); }
    else refresh(tr("saveError"), true);
  }
  function init() {
    if (initialized || !$("frontLedSetup")) return;
    initialized = true;
    for (const key of keys) $(key).addEventListener("input", () => { dirty = !same(values(), saved); refresh(); });
    for (const key of ["frontLedVolumeEnabled", "frontLedStartPixel", "frontLedReverse"]) $(key).addEventListener("input", volumePreview);
    $("saveLedHardware").addEventListener("click", save);
    $("cancelLedHardware").addEventListener("click", () => { dirty = false; write(saved); refresh(); });
    $("rebootLedHardware").addEventListener("click", () => requestSystemReboot());
  }
  root.SRLedSettings = {
    hardware(hardware) {
      init(); cap = hardware || {};
      active = normalized({ frontLedType: cap.type, frontLedCount: cap.count, frontLedDataPin: cap.dataPin, frontLedRedPin: cap.redPin,
        frontLedGreenPin: cap.greenPin, frontLedBluePin: cap.bluePin, frontLedInverted: cap.inverted, frontLedOrder: cap.order });
      for (const key of keys.filter(key => key.endsWith("Pin"))) {
        const node = $(key); node.replaceChildren();
        const empty = root.document.createElement("option"); empty.value = "-1"; empty.textContent = tr("choosePin"); node.append(empty);
        for (const pin of cap.pins || []) { const option = root.document.createElement("option"); option.value = String(pin); option.textContent = "GPIO " + pin; node.append(option); }
      }
      $("frontLedCount").max = String(cap.maxCount || 64); write(saved); refresh();
    },
    configuration(config) {
      init(); saved = normalized(config); volumeConfig = config;
      if (!dirty && !saving) write(saved);
      refresh();
    }
  };
})(typeof window === "object" ? window : globalThis);
