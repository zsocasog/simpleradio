/* SimpleRadio interface: same device APIs and shared firmware/LCD theme. */
(function () {
  "use strict";
  const U = window.SRUI = { ready: false, ordering: false, localTab: "overview", connectionKind: "", committing: "", draft: {}, file: null, otaBusy: false };
  const id = name => document.getElementById(name);
  const tr = (key, fallback, vars) => window.srT ? window.srT(key, fallback, vars) : fallback;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const visible = (node, show) => { if (node) { node.hidden = !show; node.classList.toggle("hidden", !show); } };
  const make = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const addMarkup = (parent, html) => { const template = document.createElement("template"); template.innerHTML = html; parent.appendChild(template.content); };
  const scriptSource = document.currentScript?.getAttribute("src") || "";
  const assetQuery = scriptSource.includes("?") ? "?" + scriptSource.split("?")[1].split("#")[0] : "";
  U.icon = name => '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="' + esc("icons.svg" + assetQuery + "#" + name) + '"></use></svg>';
  const disclosureLabel = (node, label) => { node.innerHTML = U.icon("chevron-right") + '<span>' + esc(label) + '</span>'; };
  const button = (label, iconName, action, className = "quiet-button") => {
    const n = make("button", className); n.type = "button"; n.setAttribute("aria-label", label); n.title = label;
    n.innerHTML = (iconName ? U.icon(iconName) : "") + '<span>' + esc(label) + '</span>'; n.onclick = action; return n;
  };
  const iconButton = (n, name) => {
    if (!n) return; n.dataset.uiIcon = name; n.dataset.idleLabel = n.title || n.getAttribute("aria-label") || n.textContent.trim();
    n.setAttribute("aria-label", n.dataset.idleLabel); n.innerHTML = U.icon(name); n.classList.add("ui-icon-button");
  };
  U.feedback = (n, state, label) => {
    if (!n.dataset.uiIcon) return false;
    n.innerHTML = U.icon(({ busy: "refresh", success: "check", error: "x" })[state] || n.dataset.uiIcon);
    n.disabled = state === "busy"; n.setAttribute("aria-busy", String(state === "busy"));
    n.title = label || (state === "idle" ? n.dataset.idleLabel : tr("save." + ({ success: "done", error: "error", busy: "busy" }[state] || "idle"), n.dataset.idleLabel));
    n.classList.toggle("is-saving", state === "busy"); n.classList.toggle("is-error", state === "error");
    return true;
  };
  function dialog(name, title) {
    const n = make("dialog", "side-dialog"); n.id = name;
    const head = make("header", "dialog-head"); const h = make("h2", "", title); h.id = name + "Title";
    n.setAttribute("aria-labelledby", h.id); head.append(h, button(tr("ui.close", "Bezárás"), "x", () => n.close(), "ui-icon-button"));
    const body = make("div", "dialog-body"); n.append(head, body); document.body.appendChild(n);
    n.addEventListener("click", e => { if (e.target === n && e.clientX < n.getBoundingClientRect().left) n.close(); });
    return n;
  }
  function openDialog(n) {
    if (!n.open) { n.showModal(); document.body.classList.add("has-dialog"); }
  }
  function closeMenus(except) {
    document.querySelectorAll(".station-menu[open]").forEach(n => { if (n !== except) n.open = false; });
  }
  U.toggleOrdering = () => {
    U.ordering = !U.ordering; closeMenus();
    id("stationOrderButton").setAttribute("aria-pressed", String(U.ordering));
    id("stationOrderButton").innerHTML = U.icon(U.ordering ? "check" : "arrows-sort") + '<span>' + esc(U.ordering ? tr("ui.orderDone", "Rendezés kész") : tr("ui.reorder", "Sorrend módosítása")) + "</span>";
    renderStations(true);
  };
  U.stationRow = (row, station, compact, index) => {
    row.setAttribute("data-user-content", "");
    row.classList.add("clean-station"); row.title = station.name || "";
    if (compact) {
      if (station.id === currentStationId) {
        const playing = make("span", "station-playing"); playing.innerHTML = U.icon("chart-bar");
        playing.hidden = !U.lastPlayer?.playing;
        row.appendChild(playing);
      }
      return;
    }
    row.draggable = U.ordering; row.setAttribute("draggable", String(U.ordering));
    const grip = row.querySelector(".drag-handle"); visible(grip, U.ordering); if (grip) grip.innerHTML = U.icon("grip-vertical");
    const meta = row.querySelector(".item-meta"); if (meta) meta.remove();
    const number = row.querySelector(".station-number"); if (number) number.textContent = String(index + 1).padStart(2, "0");
    const actions = row.querySelector(".item-actions");
    const [play, up, down, edit, del] = [...actions.children];
    iconButton(play, "player-play"); iconButton(up, "arrow-up"); iconButton(down, "arrow-down");
    visible(up, U.ordering); visible(down, U.ordering);
    const menu = make("details", "station-menu"); const summary = make("summary", "ui-icon-button");
    summary.setAttribute("aria-label", tr("ui.moreActions", "További műveletek")); summary.innerHTML = U.icon("dots");
    const pop = make("div", "station-menu-items"); pop.setAttribute("role", "group");
    const label = (n, name, text) => { n.className = "menu-action"; n.innerHTML = U.icon(name) + "<span>" + esc(text) + "</span>"; const run = n.onclick; n.onclick = e => { menu.open = false; run(e); }; };
    label(edit, "pencil", tr("ui.edit", "Szerkesztés"));
    label(del, "trash", tr("ui.delete", "Törlés")); del.classList.add("danger");
    pop.append(edit, button(tr("ui.move", "Áthelyezés"), "arrows-sort", () => { U.toggleOrdering(); id("stationOrderButton").focus(); }, "menu-action"), del);
    menu.append(summary, pop); actions.append(menu);
    menu.addEventListener("toggle", () => { if (menu.open) closeMenus(menu); });
  };
  function buildStations() {
    const actions = document.querySelector("#stationsView .page-actions");
    const order = button(tr("ui.reorder", "Sorrend módosítása"), "arrows-sort", U.toggleOrdering);
    order.id = "stationOrderButton"; order.setAttribute("aria-pressed", "false"); actions.prepend(order);
    U.stationDialog = dialog("stationToolsDialog", tr("ui.addStation", "Állomás hozzáadása"));
    const body = U.stationDialog.querySelector(".dialog-body");
    const tabs = make("div", "drawer-tabs");
    for (const [kind, key, fallback] of [["search", "ui.onlineSearch", "Online kereső"], ["editor", "ui.manualStation", "Kézi hozzáadás"], ["logos", "ui.logos", "Logók"]]) {
      const b = button(tr(key, fallback), "", () => U.stationDrawer(kind)); b.dataset.drawerTab = kind; tabs.appendChild(b);
    }
    body.appendChild(tabs);
    const tools = document.querySelector(".station-tools");
    body.appendChild(tools); U.stationPanels = { search: id("stationSearchDrawer"), editor: id("stationEditorDrawer"), logos: tools.querySelector("article.panel") };
    U.stationDialog.addEventListener("close", () => { document.body.classList.remove("has-dialog"); });
  }
  U.stationDrawer = kind => {
    if (!U.ready) return;
    Object.entries(U.stationPanels).forEach(([key, panel]) => { visible(panel, key === kind); if (panel.tagName === "DETAILS") panel.open = key === kind; });
    U.stationDialog.querySelectorAll("[data-drawer-tab]").forEach(n => n.classList.toggle("active", n.dataset.drawerTab === kind));
    U.stationDialog.querySelectorAll("[data-drawer-tab]").forEach(n => n.setAttribute("aria-pressed", String(n.dataset.drawerTab === kind)));
    id("stationToolsDialogTitle").textContent = kind === "editor" && id("editId").value ? tr("stations.edit", "Állomás szerkesztése") : tr("ui.addStation", "Állomás hozzáadása");
    openDialog(U.stationDialog);
    setTimeout(() => (kind === "search" ? id("searchName") : kind === "editor" ? id("editName") : id("logoDropZone"))?.focus(), 0);
  };
  function systemSection(name) {
    const n = make("section", "system-section"); n.id = "systemSection-" + name;
    n.setAttribute("role", "tabpanel"); n.setAttribute("aria-labelledby", "systemLocal-" + name); return n;
  }
  function buildSystem() {
    const root = id("systemView"); root.querySelector(".page-head [data-config-save]")?.remove();
    const tabs = make("nav", "system-local-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", tr("ui.systemSections", "Rendszer nézetei"));
    const sections = {};
    const labels = { overview: ["ui.overview", "Áttekintés"], connections: ["ui.connections", "Kapcsolatok"], update: ["ui.update", "Frissítés"] };
    for (const [name, [key, text]] of Object.entries(labels)) {
      const b = button(tr(key, text), "", () => U.systemTab(name)); b.id = "systemLocal-" + name;
      b.setAttribute("role", "tab"); b.setAttribute("aria-controls", "systemSection-" + name);
      b.addEventListener("keydown", e => {
        const names = Object.keys(labels); let i = names.indexOf(name);
        if (e.key === "ArrowRight") i = (i + 1) % names.length; else if (e.key === "ArrowLeft") i = (i + names.length - 1) % names.length;
        else if (e.key === "Home") i = 0; else if (e.key === "End") i = names.length - 1; else return;
        e.preventDefault(); U.systemTab(names[i]); id("systemLocal-" + names[i]).focus();
      });
      tabs.appendChild(b); sections[name] = systemSection(name);
    }
    root.querySelector(".page-head").after(tabs); Object.values(sections).forEach(n => root.appendChild(n));
    U.sections = sections;
    const oldReboot = id("rebootButton");
    const refreshStatus = root.querySelector('[onclick="refreshSystemStatus()"]');
    if (refreshStatus) root.querySelector(".page-head").appendChild(refreshStatus);
    const status = document.querySelector(".system-status-panel");
    sections.overview.appendChild(status); status.querySelector(".panel-head").remove();
    status.before(make("h2", "overview-heading", tr("status.title", "Állapot")));
    for (const [name, glyph] of [["statusWifiCard", "wifi"], ["statusMqttCard", "cloud"], ["statusFilesystemCard", "database"]]) {
      const mark = make("span", "metric-icon"); mark.innerHTML = U.icon(glyph); id(name).prepend(mark);
    }
    const wifiState = make("strong"); wifiState.id = "overviewWifiState"; id("statusWifi").before(wifiState);
    visible(id("statusPlaybackCard"), false);
    const technical = make("details", "disclosure technical-details");
    const techSummary = make("summary", "", tr("ui.systemInfo", "Rendszerinformációk")); technical.appendChild(techSummary);
    technical.id = "technicalDetails"; technical.append(id("statusSystemCard"), id("statusPlaybackCard"));
    visible(id("statusPlaybackCard"), true);
    const about = root.querySelector(".status-about-card"); technical.appendChild(about);
    for (const name of ["statusWifiDetail", "statusMqttDetail", "statusFilesystemDetail"]) {
      if (id(name)) technical.appendChild(id(name));
    }
    const versions = make("dl", "version-grid"); versions.innerHTML = '<div><dt>Firmware</dt><dd id="overviewFirmware">—</dd></div><div><dt>' + esc(tr("ui.webInterface", "Webfelület")) + '</dt><dd id="overviewWebui">—</dd></div><div><dt>' + esc(tr("ui.device", "Eszköz")) + '</dt><dd id="overviewChip">—</dd></div><div><dt>' + esc(tr("ui.uptime", "Futásidő")) + '</dt><dd id="overviewUptime">—</dd></div>'; status.after(versions);
    const integrations = make("div", "integration-list");
    addMarkup(integrations, '<h2>' + esc(tr("ui.integrations", "Integrációk")) + '</h2>');
    const service = (kind, title, infoId) => {
      const row = make("div", "integration-row");
      const name = make("strong", "service-name");
      name.innerHTML = U.icon(kind === "mqtt" ? "broadcast" : "brand-lastfm") + '<span>' + esc(title) + '</span>';
      row.appendChild(name);
      const statusText = make("span", "muted"); statusText.id = infoId;
      row.append(statusText, button(tr(kind === "mqtt" ? "ui.settings" : "ui.modify", kind === "mqtt" ? "Beállítások" : "Módosítás"), "chevron-right", () => U.openConnection(kind))); return row;
    };
    integrations.append(service("mqtt", "MQTT", "overviewMqtt"), service("lastfm", "Last.fm", "overviewLastfm")); sections.overview.appendChild(integrations);
    const overviewTools = make("div", "overview-tools");
    const github = about.querySelector(".status-about-link")?.cloneNode(true);
    if (github) {
      github.className = "overview-github";
      github.innerHTML = U.icon("brand-github") + '<span>GitHub</span>' + U.icon("external-link");
      overviewTools.appendChild(github);
    }
    sections.overview.append(technical, overviewTools);
    oldReboot?.removeAttribute("class"); oldReboot?.classList.add("quiet-button");
    if (oldReboot) {
      oldReboot.innerHTML = U.icon("power") + '<span>' + esc(oldReboot.textContent) + '</span>';
      overviewTools.appendChild(oldReboot);
    }
    const led = id("frontLedPanel"); const retry = id("streamRetryEnabled").closest(".settings-section");
    id("controlsView").querySelector(".settings-column:last-child").appendChild(retry);
    const ledDetails = make("details", "disclosure led-settings");
    const ledSummary = make("summary");
    ledSummary.innerHTML = U.icon("chevron-right") + U.icon("bulb") + '<span>' + esc(led.querySelector("h2").textContent) + '</span>';
    ledSummary.appendChild(id("frontLedHardwareBadge"));
    led.querySelector(".settings-section-head").remove();
    led.classList.remove("settings-column"); led.classList.add("led-fields");
    ledDetails.append(ledSummary, led);
    id("displayView").querySelector(".settings-column:last-child").appendChild(ledDetails);
    U.connectionDialog = dialog("connectionDialog", "");
    const lastfm = root.querySelector(".lastfm-settings-panel"), mqtt = id("mqttSettingsForm");
    U.connectionPanels = { mqtt, lastfm };
    U.connectionDialog.querySelector(".dialog-body").append(mqtt, lastfm);
    const connectionStatus = make("p", "connection-save-status"); connectionStatus.id = "connectionSaveStatus";
    connectionStatus.setAttribute("role", "status"); connectionStatus.setAttribute("aria-live", "polite");
    U.connectionDialog.querySelector(".dialog-body").appendChild(connectionStatus);
    const mqttSave = button(tr("ui.saveConnection", "Kapcsolat mentése"), "", () => U.saveConnection("mqtt"), "primary");
    const mqttCancel = button(tr("action.cancel", "Mégse"), "", () => U.connectionDialog.close());
    mqttSave.type = "submit"; mqttSave.onclick = null;
    mqtt.onsubmit = e => { e.preventDefault(); U.saveConnection("mqtt"); };
    const mqttActions = make("div", "button-row"); mqttActions.append(mqttSave, mqttCancel); mqtt.appendChild(mqttActions);
    U.connectionSave = { mqtt: mqttSave, lastfm: lastfm.querySelector("[data-config-save]") };
    U.connectionSave.lastfm.onclick = () => U.saveConnection("lastfm");
    const keyHelp = lastfm.querySelector("ol"); if (keyHelp) { const d = make("details", "disclosure"); d.append(make("summary", "", tr("ui.keyHelp", "Hogyan készíthetek API-kulcsot?")), keyHelp); lastfm.appendChild(d); }
    U.mqttFields = ["mqttEnabled", "mqttHost", "mqttPort", "mqttUser", "mqttPassword", "mqttRootTopic"];
    U.mqttFields.forEach(name => { id(name).onchange = null; id(name).addEventListener("input", captureConnectionDraft); id(name).addEventListener("change", captureConnectionDraft); });
    id("lastFmApiKey").addEventListener("input", captureConnectionDraft);
    id("lastFmApiKey").addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); U.saveConnection("lastfm"); } });
    U.connectionDialog.addEventListener("close", () => {
      U.connectionKind = ""; U.draft = {}; document.body.classList.remove("has-dialog");
      id("connectionSaveStatus").textContent = "";
      if (configLoaded) applyConfigToUI(currentConfig);
    });
    const connections = sections.connections;
    connections.append(make("h2", "", tr("ui.services", "Kapcsolatok és szolgáltatások")));
    connections.append(service("mqtt", "MQTT", "connectionMqtt"), service("lastfm", "Last.fm", "connectionLastfm"));
    const hint = make("p", "muted", tr("ui.connectionsHelp", "A szolgáltatás beállításai a Módosítás gombbal nyithatók meg.")); connections.appendChild(hint);
    const ota = root.querySelector(".ota-panel"); sections.update.appendChild(ota);
    const oldSurface = root.querySelector(":scope > .settings-surface"); oldSurface?.remove();
    buildUpdater(ota); U.systemTab(U.localTab);
  }
  U.systemTab = name => {
    if (!U.sections || !U.sections[name]) return;
    U.localTab = name;
    Object.entries(U.sections).forEach(([key, n]) => { visible(n, key === name); const b = id("systemLocal-" + key); b.classList.toggle("active", key === name); b.setAttribute("aria-selected", String(key === name)); b.tabIndex = key === name ? 0 : -1; });
  };
  function captureConnectionDraft() {
    if (!U.connectionKind) return;
    const names = U.connectionKind === "mqtt" ? U.mqttFields : ["lastFmApiKey"];
    names.forEach(name => { const n = id(name); U.draft[name] = n.type === "checkbox" ? n.checked : n.value; });
    U.syncConditional();
  }
  U.openConnection = async kind => {
    if (!configLoaded) { try { await loadConfig(); } catch (_) { return; } }
    if (!configLoaded) return;
    showView("system"); U.systemTab("connections"); U.connectionKind = kind;
    Object.entries(U.connectionPanels).forEach(([key, n]) => visible(n, key === kind));
    id("connectionDialogTitle").textContent = kind === "mqtt" ? tr("ui.mqttSettings", "MQTT beállításai") : tr("ui.lastfmSettings", "Last.fm API-kulcs");
    captureConnectionDraft(); openDialog(U.connectionDialog);
    setTimeout(() => id(kind === "mqtt" ? "mqttHost" : "lastFmApiKey")?.focus(), 0);
  };
  U.protectsConfig = name => U.ready && !!U.connectionKind && !U.committing && Object.prototype.hasOwnProperty.call(U.draft, name);
  U.configData = data => {
    if (U.committing !== "mqtt") {
      for (const name of U.mqttFields) data[name] = name === "mqttEnabled" ? (currentConfig[name] ? "1" : "0") : String(currentConfig[name] ?? (name === "mqttPort" ? 1883 : name === "mqttRootTopic" ? "simpleradio" : ""));
    }
    if (U.committing !== "lastfm") delete data.lastFmApiKey;
    return data;
  };
  U.saveConnection = async kind => {
    if (U.connectionSaving) return;
    U.connectionSaving = true; U.connectionSave[kind].disabled = true;
    const status = id("connectionSaveStatus"); status.classList.remove("is-error"); status.textContent = tr("save.busy", "Mentés…");
    try {
      const started = Date.now();
      while (configSaving || sliderGestures.size || meterSensitivityEditing) {
        if (Date.now() - started > 5000) throw new Error("busy");
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      U.committing = kind;
      const ok = await postConfig();
      if (ok) { U.connectionKind = ""; U.draft = {}; U.connectionDialog.close(); await refreshSystemStatus(); }
      else { status.textContent = tr("ui.saveFailed", "A mentés nem sikerült. Próbáld újra."); status.classList.add("is-error"); }
    } catch (_) { status.textContent = tr("ui.saveFailed", "A mentés nem sikerült. Próbáld újra."); status.classList.add("is-error"); U.saveState("error"); }
    finally { U.committing = ""; U.connectionSaving = false; U.connectionSave[kind].disabled = false; }
  };
  function buildUpdater(ota) {
    const originalWarning = id("otaWarning");
    const details = make("details", "disclosure ota-help"); details.append(make("summary", "", tr("ui.updateHelp", "Tudnivalók a frissítésről")), originalWarning);
    const confirmRow = id("otaConfirm").closest("label"); confirmRow.className = "confirmation-row";
    const checkbox = id("otaConfirm"); const label = make("span", "", tr("ui.updateConfirm", "Megértettem, hogy a frissítés után a rádió újraindul."));
    confirmRow.replaceChildren(checkbox, label);
    const passwordRow = id("otaPassword").closest("label");
    const oldGrid = ota.querySelector(".ota-grid"); oldGrid.remove();
    const picker = make("div", "update-picker");
    addMarkup(picker, '<span id="updateTargetLabel">' + esc(tr("ui.updateTarget", "Mit szeretnél frissíteni?")) + '</span><select id="updateKind" hidden aria-hidden="true"><option value="firmware">' + esc(tr("ui.firmware", "Firmware")) + '</option><option value="filesystem">' + esc(tr("ui.webInterface", "Webfelület")) + '</option></select><p id="updateTargetHelp" class="muted"></p><div class="file-picker"><input id="updateFile" type="file" accept=".bin,application/octet-stream"><label for="updateFile">' + U.icon("upload") + '<span>' + esc(tr("ui.chooseFile", "Válassz .bin fájlt vagy húzd ide")) + '</span></label><div id="updateFileName" aria-live="polite"></div></div>');
    passwordRow.before(picker);
    const kinds = make("div", "update-kinds"); kinds.setAttribute("role", "radiogroup"); kinds.setAttribute("aria-labelledby", "updateTargetLabel");
    U.kindButtons = [];
    for (const [kind, key, text, glyph] of [["firmware", "ui.firmware", "Firmware", "cpu"], ["filesystem", "ui.webInterface", "Webfelület", "browser"]]) {
      const choose = () => { if (id("updateKind").value !== kind) { id("updateKind").value = kind; id("updateKind").dispatchEvent(new Event("change")); } };
      const choice = button(tr(key, text), glyph, choose); choice.dataset.updateKind = kind; choice.setAttribute("role", "radio");
      choice.addEventListener("keydown", e => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
          e.preventDefault(); const target = e.key === "Home" ? U.kindButtons[0] : e.key === "End" ? U.kindButtons[1] : U.kindButtons.find(n => n !== choice);
          target.click(); target.focus();
        }
      });
      kinds.appendChild(choice); U.kindButtons.push(choice);
    }
    id("updateKind").after(kinds);
    ota.appendChild(details);
    const submit = button(tr("ui.uploadFirmware", "Firmware feltöltése"), "upload", () => U.upload(), "primary update-submit");
    submit.id = "updateSubmit"; passwordRow.after(confirmRow); confirmRow.after(submit);
    id("otaPassword").placeholder = ""; id("otaPassword").addEventListener("input", U.updateUploadButton);
    const passwordField = make("span", "password-field"), passwordInput = id("otaPassword");
    const passwordCaption = make("span", "", passwordRow.textContent.trim()); passwordCaption.id = "otaPasswordLabel";
    passwordInput.setAttribute("aria-labelledby", passwordCaption.id);
    passwordRow.replaceChildren(passwordCaption, passwordField); passwordField.appendChild(passwordInput);
    const showPassword = button(tr("ui.showPassword", "Jelszó megjelenítése"), "eye", () => {
      const shown = passwordInput.type === "password"; passwordInput.type = shown ? "text" : "password";
      const label = tr(shown ? "ui.hidePassword" : "ui.showPassword", shown ? "Jelszó elrejtése" : "Jelszó megjelenítése");
      showPassword.innerHTML = U.icon(shown ? "eye-off" : "eye"); showPassword.title = label;
      showPassword.setAttribute("aria-label", label); showPassword.setAttribute("aria-pressed", String(shown));
    }, "ui-icon-button password-visibility");
    showPassword.setAttribute("aria-pressed", "false"); passwordField.appendChild(showPassword);
    checkbox.addEventListener("change", U.updateUploadButton);
    id("updateKind").onchange = () => { U.file = null; id("updateFile").value = ""; checkbox.checked = false; U.selectFile(null); };
    id("updateFile").onchange = () => U.selectFile(id("updateFile").files?.[0] || null);
    const drop = picker.querySelector(".file-picker");
    ["dragenter", "dragover"].forEach(type => drop.addEventListener(type, e => { e.preventDefault(); if (!U.otaBusy) drop.classList.add("drag-over"); }));
    ["dragleave", "drop"].forEach(type => drop.addEventListener(type, e => { e.preventDefault(); drop.classList.remove("drag-over"); }));
    drop.addEventListener("drop", e => { if (!U.otaBusy) U.selectFile(e.dataTransfer.files?.[0] || null); });
    id("otaStatus").setAttribute("role", "status"); id("otaStatus").setAttribute("aria-live", "polite");
    U.selectFile(null);
  }
  U.selectFile = file => {
    if (U.otaBusy) return;
    U.file = file; id("otaConfirm").checked = false;
    if (file && !/\.bin$/i.test(file.name)) { U.file = null; setOtaStatus(tr("ui.binOnly", "Válassz .bin fájlt."), "error"); }
    const n = id("updateFileName"); n.replaceChildren();
    if (U.file) {
      const fileLabel = make("span", "selected-file"); fileLabel.innerHTML = U.icon("file") + '<strong>' + esc(U.file.name) + '</strong>';
      n.append(fileLabel, button(tr("ui.removeFile", "Fájl eltávolítása"), "x", () => { id("updateFile").value = ""; U.selectFile(null); }, "ui-icon-button"));
      setOtaStatus(tr("ui.fileChosen", "Fájl kiválasztva."), "");
    }
    pickerFileLabel();
    const fs = id("updateKind").value === "filesystem";
    id("updateTargetHelp").textContent = fs ? tr("ui.dataHelp", "A teljes webfelület és a LittleFS cseréje. A kézzel feltöltött logókra külön korlátozás vonatkozik; lásd a tudnivalókat.") : tr("ui.firmwareHelp", "A rádió működtetőprogramjának frissítése.");
    if (fs) id("otaWarning").closest("details").open = true;
    if (!file) setOtaStatus(tr("ui.chooseFile", "Válassz .bin fájlt vagy húzd ide"), "");
    U.updateUploadButton();
  };
  function pickerFileLabel() {
    const label = document.querySelector('.file-picker > label > span');
    if (label) label.textContent = U.file ? tr("ui.changeFile", "Másik fájl választása") : tr("ui.chooseFile", "Válassz .bin fájlt vagy húzd ide");
    (U.kindButtons || []).forEach(n => {
      const active = n.dataset.updateKind === id("updateKind").value;
      n.setAttribute("aria-checked", String(active)); n.tabIndex = active ? 0 : -1;
    });
  }
  U.updateUploadButton = () => {
    const b = id("updateSubmit"); if (!b) return;
    b.disabled = U.otaBusy || !U.file || !id("otaConfirm").checked || !id("otaPassword").value;
    const label = id("updateKind").value === "filesystem" ? tr("ui.uploadData", "Webfelület feltöltése") : tr("ui.uploadFirmware", "Firmware feltöltése");
    b.innerHTML = U.icon(U.otaBusy ? "refresh" : "upload") + "<span>" + esc(label) + "</span>";
    b.setAttribute("aria-label", label); b.title = label;
  };
  U.upload = () => { if (!U.otaBusy && U.file) uploadOtaFile(id("updateKind").value, U.file); };
  U.otaStatus = state => {
    if (!U.ready) return; U.otaBusy = state === "busy";
    ["updateKind", "updateFile", "otaPassword", "otaConfirm"].forEach(name => { id(name).disabled = U.otaBusy; });
    (U.kindButtons || []).forEach(n => { n.disabled = U.otaBusy; });
    visible(document.querySelector(".ota-progress"), U.otaBusy);
    visible(id("otaStatus"), ["busy", "ok", "error"].includes(state)); U.updateUploadButton();
  };
  U.saveState = state => {
    U.lastSaveState = state;
    if (!U.ready) return;
    document.querySelectorAll(".config-save-status").forEach(n => {
      const error = state === "error"; n.classList.toggle("is-error", error);
      const busy = state === "busy" || state === "pending";
      n.classList.toggle("is-pending", busy);
      const label = error ? tr("ui.saveFailed", "A mentés nem sikerült. Próbáld újra.") : busy ? tr("save.busy", "Mentés…") : tr("ui.allSaved", "Minden módosítás mentve");
      n.innerHTML = U.icon(error ? "circle-x" : busy ? "loader-2" : "circle-check") + '<span>' + esc(label) + '</span>';
    });
  };
  function buildSettings() {
    const encoder = id("encoderHardwarePanel");
    encoder.append(id("encoderVolumePanel"), id("encoderStationPanel"));
    for (const page of ["display", "controls", "sound"]) {
      const head = document.querySelector("#" + page + "View .page-head");
      head.querySelector("[data-config-save]")?.remove();
      const status = make("button", "config-save-status", tr("ui.allSaved", "Minden módosítás mentve"));
      status.type = "button"; status.setAttribute("aria-live", "polite");
      status.onclick = () => { if (U.lastSaveState === "error") saveConfigNow(); }; head.appendChild(status);
    }
    document.querySelector("#soundView .page-head > button")?.classList.remove("primary");
    const timeZone = id("timeZone").closest("label");
    id("autoBrightness").closest(".settings-section").appendChild(timeZone);
    id("autoBrightness").closest("label").classList.add("brightness-mode");
    const brightnessSection = id("autoBrightness").closest(".settings-section");
    brightnessSection.querySelector("h2").textContent = tr("ui.brightness", "Fényerő");
    const modes = make("div", "brightness-selector"); modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", tr("ui.brightnessMode", "Fényerő módja"));
    for (const [value, key, label] of [[false, "ui.manual", "Kézi"], [true, "ui.scheduled", "Időzített"]]) {
      const n = button(tr(key, label), "", () => { id("autoBrightness").checked = value; id("autoBrightness").dispatchEvent(new Event("change", { bubbles: true })); });
      n.dataset.brightnessMode = String(value); modes.appendChild(n);
    }
    brightnessSection.querySelector("header").after(modes);
    const appearance = make("section", "settings-section appearance-settings");
    appearance.append(make("h2", "", tr("ui.appearance", "Megjelenés")), make("small", "theme-help", tr("ui.sharedTheme", "Az LCD és a webfelület közös színei.")), id("themeAccent").closest("label"), id("themeCustomColorField"), id("displayInvert").closest("label"));
    brightnessSection.after(appearance);
    appearance.after(document.querySelector(".led-settings"));
    for (const [time, level, key, fallback] of [["dayStartTime", "dayBrightness", "ui.day", "Nappali"], ["nightStartTime", "nightBrightness", "ui.night", "Éjszakai"]]) {
      const clockRow = id(time).closest("label"), levelRow = id(level).closest("label");
      const row = make("div", "schedule-row"); clockRow.before(row); row.append(clockRow, levelRow);
      clockRow.querySelector("span").textContent = tr(key, fallback);
      levelRow.querySelector("span").classList.add("visually-hidden");
    }
    const artworkSection = id("displayArtworkMode").closest(".settings-section");
    const footerSection = id("displayFooterMode").closest(".settings-section");
    artworkSection.querySelector("h2").textContent = tr("ui.playerView", "Lejátszónézet");
    [...footerSection.children].filter(n => n.tagName !== "HEADER").forEach(n => artworkSection.appendChild(n));
    footerSection.remove();
    const preview = make("div", "layout-preview");
    preview.innerHTML = '<small>' + esc(tr("ui.preview", "Elrendezési előnézet")) + '</small><div class="preview-content"><div id="layoutPreviewArt" class="preview-art"></div><div data-user-content><strong id="layoutPreviewTitle"></strong><small id="layoutPreviewArtist"></small></div><small id="layoutPreviewMode"></small></div>';
    artworkSection.appendChild(preview);
    const standby = id("displayIdleEnabled").closest(".settings-section");
    const standbyToggle = id("displayIdleEnabled").closest("label");
    standbyToggle.classList.add("section-enable"); standbyToggle.querySelector(".setting-copy").classList.add("visually-hidden");
    standby.querySelector("header").classList.add("has-section-enable");
    standby.querySelector("header").appendChild(standbyToggle);
    ["brightness", "dayBrightness", "nightBrightness"].forEach(name => id(name).closest("label").classList.add("brightness-control"));
    for (const [source, target] of [["encoderLongPressMs", "encoderLongPressSeconds"], ["encoderAutoPlayMs", "encoderAutoPlaySeconds"], ["streamRetryMs", "streamRetrySeconds"]]) {
      const input = id(source); input.hidden = true;
      const display = make("input"); display.type = "number"; display.id = target; display.min = Number(input.min || 0) / 1000; display.max = Number(input.max || 60000) / 1000; display.step = String(Number(input.step || 1) / 1000);
      const label = input.closest("label"); label.htmlFor = target;
      const group = make("span", "setting-number"); const suffix = make("span", "input-unit", tr("ui.seconds", "másodperc")); group.append(display, suffix); input.after(group);
      display.onchange = () => { const seconds = Number(display.value); if (display.value === "" || !Number.isFinite(seconds) || !display.reportValidity()) return; input.value = String(Math.round(seconds * 1000)); saveConfigNow(); };
      U.secondFields = U.secondFields || []; U.secondFields.push([source, target]);
    }
    document.querySelectorAll("#displayView select,#displayView input[type=checkbox],#encoderAutoPlayStation,#streamRetryEnabled,#mqttEnabled").forEach(n => n.addEventListener("change", U.syncConditional));
  }
  function buildPlayer() {
    const copy = document.querySelector(".now-copy");
    const controls = make("div", "player-controls");
    const transport = copy.querySelector(".transport"), rail = copy.querySelector(".volume-rail");
    transport.before(controls); controls.append(transport, rail);
    id("headerTransport").setAttribute("aria-label", tr("ui.playbackControls", "Lejátszásvezérlés"));
    const station = make("small", "player-station-name"); station.id = "playerStationName"; station.setAttribute("data-user-content", ""); copy.prepend(station);
    const artist = make("p", "player-artist"); artist.id = "playerArtist"; artist.setAttribute("data-user-content", ""); id("current-station").after(artist);
    id("current-station").setAttribute("data-user-content", "");
    const volume = document.querySelector(".volume-label");
    U.muteButton = button(tr("ui.mute", "Némítás"), "volume", () => U.toggleMute(), "mute-button");
    volume.replaceWith(U.muteButton);
    const range = id("volume"), pattern = make("span", "volume-pattern"); pattern.setAttribute("aria-hidden", "true");
    const shape = [92,142,204,126,232,166,108,190,248,154,212,116,132,226,172,104,198,244,150,214,122,184,236,138];
    U.volumePills = shape.map(height => { const bar = make("span", "volume-pill"); bar.style.height = Math.round(height / 248 * 100) + "%"; pattern.appendChild(bar); return bar; });
    const field = make("span", "signature-volume"); range.before(field); field.append(pattern, range);
    range.setAttribute("aria-label", tr("player.volume", "Hangerő"));
    U.restoreVolume = 15;
    try { const saved = Number(localStorage.getItem("simpleradio.lastAudibleVolume")); if (saved > 0 && saved <= 100) U.restoreVolume = saved; } catch (_) {}
  }
  U.volume = value => {
    if (!U.ready || !U.muteButton) return;
    const level = Math.max(0, Math.min(100, Number(value) || 0));
    if (level > 0 && level !== U.restoreVolume) {
      U.restoreVolume = level;
      try { localStorage.setItem("simpleradio.lastAudibleVolume", String(level)); } catch (_) {}
    }
    const muted = level === 0;
    id("volume").setAttribute("aria-valuetext", muted ? tr("ui.muted", "Némítva") : level + "%");
    id("volValue").textContent = muted ? tr("ui.muted", "Némítva") : level + "%";
    if (U.shownVolume === level) return; U.shownVolume = level;
    const label = muted ? tr("ui.unmute", "Némítás feloldása") : tr("ui.mute", "Némítás");
    U.muteButton.innerHTML = U.icon(muted ? "volume-off" : "volume");
    U.muteButton.setAttribute("aria-label", label); U.muteButton.title = label;
    U.muteButton.setAttribute("aria-pressed", String(muted));
    document.querySelector(".volume-rail").classList.toggle("is-muted", muted);
    U.volumePills.forEach((bar, index) => bar.style.setProperty("--fill", Math.max(0, Math.min(100, (level * 24 / 100 - index) * 100)) + "%"));
  };
  U.toggleMute = () => {
    if (!U.ready) return;
    const level = numberValue("volume", 0);
    if (level > 0) U.restoreVolume = level;
    setVolume(level > 0 ? 0 : U.restoreVolume);
  };
  function buildRemote() {
    const list = id("irMappedList"); const details = make("details", "disclosure ir-mappings");
    const sum = make("summary", "", tr("ui.allMappings", "Összes hozzárendelés")); sum.id = "irMappingSummary";
    list.before(details); details.append(sum, list);
    const sensitivity = id("irSensitivity").closest("label") || id("irSensitivity").parentElement;
    sensitivity.className = "ir-sensitivity";
    const range = make("span", "ir-sensitivity-range"); range.append(id("irSensitivity"), id("irSensitivityValue"));
    sensitivity.appendChild(range); details.after(sensitivity);
  }
  function buildMobileNavigation() {
    const nav = make("nav", "mobile-navigation"); nav.setAttribute("aria-label", tr("ui.mobileNavigation", "Mobilnavigáció"));
    U.mobileButtons = {};
    for (const [view, tab, glyph] of [["player", "playerTab", "player-play"], ["stations", "stationsTab", "list"], ["sound", "soundTab", "adjustments-horizontal"]]) {
      const n = button(id(tab).textContent, glyph, () => showView(view)); n.dataset.mobileView = view; nav.appendChild(n); U.mobileButtons[view] = n;
    }
    U.moreDialog = dialog("mobileMoreDialog", tr("ui.more", "Több")); U.moreDialog.classList.add("mobile-more-dialog");
    const more = button(tr("ui.more", "Több"), "dots", () => openDialog(U.moreDialog));
    more.setAttribute("aria-haspopup", "dialog"); more.setAttribute("aria-controls", U.moreDialog.id); nav.appendChild(more); U.mobileButtons.more = more;
    const body = U.moreDialog.querySelector(".dialog-body");
    for (const [view, tab, glyph] of [["display", "displayTab", "device-desktop"], ["controls", "controlsTab", "adjustments-horizontal"], ["ir", "irTab", "device-remote"], ["system", "systemTab", "settings"]]) {
      const n = button(id(tab).textContent, glyph, () => { U.moreDialog.close(); showView(view); }, "mobile-destination");
      n.dataset.mobileDestination = view; body.appendChild(n);
    }
    U.moreDialog.addEventListener("close", () => document.body.classList.remove("has-dialog"));
    U.moreDialog.addEventListener("click", e => { const r = U.moreDialog.getBoundingClientRect(); if (e.target === U.moreDialog && e.clientY < r.top) U.moreDialog.close(); });
    document.querySelector(".app-shell").appendChild(nav);
    window.matchMedia("(max-width: 760px)").addEventListener("change", e => { if (!e.matches && U.moreDialog.open) U.moreDialog.close(); });
  }
  U.syncConditional = () => {
    if (!U.ready) return;
    const auto = id("autoBrightness").checked, clock = id("displayClockEnabled").checked;
    document.querySelectorAll("[data-brightness-mode]").forEach(n => n.setAttribute("aria-pressed", String(n.dataset.brightnessMode === String(auto))));
    visible(id("brightness").closest("label"), !auto);
    ["dayStartTime", "nightStartTime", "dayBrightness", "nightBrightness"].forEach(name => visible(id(name).closest("label"), auto));
    visible(id("timeZone").closest("label"), auto || clock);
    ["displayIdleMode", "displayIdleSeconds", "displayIdleBrightness"].forEach(name => visible(id(name).closest("label"), id("displayIdleEnabled").checked));
    visible(id("encoderAutoPlayMs").closest("label"), id("encoderAutoPlayStation").checked);
    visible(id("streamRetryMs").closest("label"), id("streamRetryEnabled").checked);
    visible(id("secondEncoderEnabled").closest("label"), !!hardwareCapabilities.encoder2?.available);
    visible(id("frontLedPanel").querySelector(".settings-fields"), !!hardwareCapabilities.frontRgbLed?.available);
    if (U.connectionKind === "mqtt") U.mqttFields.slice(1).forEach(name => visible(id(name).closest("label"), id("mqttEnabled").checked));
  };
  U.configuration = config => {
    U.lastConfiguration = config;
    if (!U.ready) return;
    if (U.connectionKind && !U.committing) {
      Object.entries(U.draft).forEach(([name, value]) => { const n = id(name); if (n.type === "checkbox") n.checked = value; else n.value = value; });
    }
    const source = config.hasSavedLastFmApiKey ? tr("ui.webKeyActive", "Weben mentett kulcs aktív") : config.hasLastFmApiKey ? tr("ui.firmwareKeyActive", "Firmware-kulcs aktív") : tr("ui.notConfigured", "Nincs megadva");
    ["connectionLastfm", "overviewLastfm"].forEach(name => { id(name).textContent = source; });
    visible(id("deleteLastFmApiKey"), !!config.hasSavedLastFmApiKey);
    visible(id("lastFmKeyDeleteHelp"), !!config.hasSavedLastFmApiKey);
    (U.secondFields || []).forEach(([source, target]) => { if (document.activeElement !== id(target)) id(target).value = String(Number(id(source).value) / 1000); });
    const learned = irActions.filter(item => String(config[irKey(item.action)] || "0") !== "0").length;
    disclosureLabel(id("irMappingSummary"), tr("ui.mappingCount", "Összes hozzárendelés ({count}/{total})", { count: learned, total: irActions.length }));
    const learning = !!config.irActionLearning; const active = selectedIrAction || config.irActionLearning;
    if (learning) id("irPrimaryCode").textContent = tr("ui.waitingSignal", "Várakozás a jelre…");
    visible(document.querySelector('[onclick="cancelIrLearning()"]'), learning);
    visible(document.querySelector('[onclick="clearSelectedIr()"]'), !!active && String(config[irKey(active)] || "0") !== "0");
    if (active && !learning && String(config[irKey(active)] || "0") !== "0") id("irPanelHelp").textContent = tr("ui.keyLearned", "A gomb elmentve. Válassz másikat a folytatáshoz.");
    id("irMappedList").querySelectorAll(".mapped-pill").forEach((n, i) => {
      n.setAttribute("role", "button"); n.tabIndex = hardwareCapabilities.ir?.available ? 0 : -1;
      n.onclick = () => startIrLearning(irActions[i].action);
      n.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); n.click(); } };
    });
    U.syncConditional(); U.transport(); U.updateLayoutPreview();
  };
  U.updateLayoutPreview = () => {
    if (!U.ready) return;
    const state = U.lastPlayer || {};
    id("layoutPreviewArt").style.backgroundImage = id("webCoverArt").style.backgroundImage;
    id("layoutPreviewTitle").textContent = state.title || state.station || "SimpleRadio";
    id("layoutPreviewArtist").textContent = state.artist || "";
    id("layoutPreviewMode").textContent = id("displayFooterMode").selectedOptions[0]?.textContent || "";
  };
  U.systemStatus = status => {
    U.lastStatus = status; if (!U.ready) return;
    const system = status.system || {}, webui = status.webui || {};
    id("overviewWifiState").textContent = status.wifi?.connected ? tr("status.connected", "Csatlakozva") : tr("status.disconnected", "Nincs kapcsolat");
    id("overviewFirmware").textContent = system.version || "—"; id("overviewWebui").textContent = webui.version || "—";
    id("overviewChip").textContent = system.chipModel || "—"; id("overviewUptime").textContent = formatDuration(system.uptimeMs);
    ["overviewMqtt", "connectionMqtt"].forEach(name => { id(name).textContent = id("statusMqtt").textContent; });
  };
  U.transport = () => {
    if (!U.ready) return;
    document.querySelectorAll("#stations .station-playing").forEach(n => { n.hidden = !playing; });
    if (U.transportPlaying === playing) return;
    U.transportPlaying = playing;
    const main = id("playButton"); main.innerHTML = U.icon(playing ? "player-pause" : "player-play");
    const small = id("playButtonSmall"); small.innerHTML = U.icon(playing ? "player-pause" : "player-play");
  };
  U.state = state => {
    U.lastPlayer = state; if (!U.ready) return;
    const connection = state.playing ? streamConnectionMessage(state) : "";
    const hasSong = state.playing && !connection && (state.title || state.artist);
    id("playerStationName").textContent = hasSong ? state.station || "" : "";
    visible(id("playerStationName"), !!hasSong);
    id("current-station").textContent = hasSong ? state.title || state.station || tr("state.noStation", "Nincs állomás") : state.station || tr("state.chooseStation", "Állomás kiválasztása");
    id("playerArtist").textContent = hasSong ? state.artist || "" : ""; visible(id("playerArtist"), !!id("playerArtist").textContent);
    id("meta").textContent = connection || (!state.playing ? tr("state.playbackPaused", "Lejátszás megállítva") : hasSong ? "" : tr("state.noMetadata", "Nincs számadat"));
    visible(id("meta"), !!id("meta").textContent);
    id("playState").textContent = connection ? tr("status.connecting", "Kapcsolódás…") : state.playing ? tr("status.playing", "Lejátszás") : tr("status.stopped", "Megállítva");
    U.volume(numberValue("volume", state.volume)); U.transport(); U.updateLayoutPreview();
  };
  U.view = view => {
    if (!U.ready) return; closeMenus();
    document.body.dataset.view = view;
    const active = ["player", "stations", "sound"].includes(view) ? view : "more";
    Object.entries(U.mobileButtons || {}).forEach(([key, n]) => { n.classList.toggle("active", key === active); if (key === active) n.setAttribute("aria-current", "page"); else n.removeAttribute("aria-current"); });
    U.moreDialog?.querySelectorAll("[data-mobile-destination]").forEach(n => { n.classList.toggle("active", n.dataset.mobileDestination === view); });
    if (view !== "stations" && U.stationDialog.open) U.stationDialog.close();
    if (view !== "system" && U.connectionDialog.open) U.connectionDialog.close();
  };
  function init() {
    buildStations(); buildSystem(); buildSettings(); buildPlayer(); buildRemote(); buildMobileNavigation();
    document.querySelectorAll(".disclosure > summary").forEach(n => { if (!n.querySelector(".ui-icon")) disclosureLabel(n, n.textContent); });
    document.addEventListener("pointerdown", e => { if (!e.target.closest(".station-menu")) closeMenus(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenus(); });
    document.querySelectorAll(".transport").forEach(group => group.querySelectorAll("button").forEach((n, i) => iconButton(n, ["player-skip-back", "player-play", "player-skip-forward"][i])));
    document.querySelectorAll(".volume-step").forEach((n, i) => iconButton(n, i ? "plus" : "minus"));
    U.ready = true; document.body.classList.add("ui-ready"); document.body.dataset.view = "player"; applyLanguage(); renderStations(true);
    U.view("player"); U.otaStatus("");
    U.configuration(currentConfig); if (U.lastStatus) U.systemStatus(U.lastStatus); if (U.lastPlayer) U.state(U.lastPlayer);
    U.saveState("success"); U.updateUploadButton();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true }); else setTimeout(init, 0);
})();
