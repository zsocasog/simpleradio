(function () {
  "use strict";
  const P = window.SRRemoteProfiles;
  const id = value => document.getElementById(value);
  const tr = (key, fallback, vars) => window.srT ? window.srT("remote." + key, fallback, vars) : fallback;
  // The radio already stores Unicode labels. Render these labels with the same
  // icon sprite as the player, without tying a button's function to its motif.
  const motifs = [
    ["⏻", "power", "symbolPower", "Be- és kikapcsolás"], ["▶", "player-play", "symbolPlay", "Lejátszás"],
    ["⏸", "player-pause", "symbolPause", "Szünet"], ["■", "player-stop", "symbolStop", "Megállítás"],
    ["⏮", "player-skip-back", "symbolPrev", "Előző"], ["⏭", "player-skip-forward", "symbolNext", "Következő"],
    ["+", "plus", "symbolPlus", "Plusz"], ["−", "minus", "symbolMinus", "Mínusz"],
    ["🔇", "volume-off", "symbolMute", "Némítás"]
  ];
  function motifFor(label) { return motifs.find(motif => motif[0] === label); }
  const cellStates = new WeakMap();
  let draft = null, draftCodes = {}, selected = 0, saving = false, dirty = false, pending = null, signature = "", initialized = false, profileError = "";
  function profile() { return P.get(currentConfig.irRemoteProfile || "rcnec21", currentConfig.irRemoteCustom); }
  function layout() { return draft || profile(); }
  function message(text, error = false) {
    id("irEditorStatus").textContent = text;
    id("irEditorStatus").classList.toggle("is-error", error);
  }
  function option(value, label) { const n = document.createElement("option"); n.value = value; n.textContent = label; return n; }
  function initialize() {
    if (initialized) return; initialized = true;
    for (const [value, label] of [["rcnec21", tr("rcnec21", "21 gomb · IR-RCNEC-BK")],
      ["car21", tr("car21", "21 gomb · Car MP3")], ["nav17", tr("nav17", "17 gomb · számok és nyilak")], ["custom", tr("custom", "Egyéni távirányító")]]) {
      id("irProfile").appendChild(option(value, label));
    }
    id("irButtonAction").appendChild(option("", tr("unassigned", "Nincs hozzárendelve")));
    for (const item of P.ACTIONS) id("irButtonAction").appendChild(option(item.action, irActionLabel(item)));
    id("irProfile").onchange = async () => {
      const value = id("irProfile").value;
      profileError = "";
      if (value === "custom" && !currentConfig.irRemoteCustom) { edit(true); return; }
      selectedIrAction = "";
      id("irActionLearning").value = "";
      id("irProfile").disabled = true;
      const ok = await postConfig({ irRemoteProfile: value, irActionLearning: "" });
      if (!ok) profileError = tr("saveFailed", "A mentés nem sikerült. Próbáld újra.");
      render();
    };
    id("irEditLayout").onclick = () => edit();
    for (const [label, icon, key, fallback] of motifs) {
      const choice = document.createElement("button");
      choice.type = "button"; choice.dataset.motif = label;
      choice.title = tr(key, fallback); choice.setAttribute("aria-label", choice.title);
      choice.innerHTML = window.SRUI.icon(icon);
      choice.onclick = () => { updateButton("label", label); form(); };
      id("irButtonMotifs").appendChild(choice);
    }
    id("irRemote").addEventListener("dragover", event => { if (draft) event.preventDefault(); });
    id("irRemote").addEventListener("drop", event => {
      if (!draft || saving) return;
      event.preventDefault();
      const cell = event.target.closest("[data-cell]");
      const key = Number(event.dataTransfer.getData("text/plain"));
      const b = draft.buttons.find(item => item.id === key);
      if (!cell || !b) return;
      const [row, column] = cell.dataset.cell.split(":").map(Number);
      const other = draft.buttons.find(item => item.row === row && item.column === column);
      if (other && other !== b) { other.row = b.row; other.column = b.column; }
      b.row = row; b.column = column; selected = key; dirty = true;
      render(); form();
    });
  }
  function render() {
    initialize();
    const available = !!hardwareCapabilities.ir?.available;
    const supported = Number(currentConfig.irRemoteProfilesVersion) === 1;
    const l = layout();
    id("irProfile").value = draft ? "custom" : currentConfig.irRemoteProfile || "rcnec21";
    id("irProfile").disabled = !!draft || configSaving || !supported;
    id("irEditLayout").disabled = !!draft || configSaving || !supported;
    const custom = currentConfig.irRemoteProfile === "custom";
    id("irEditLayout").hidden = !!draft;
    id("irEditLayout").textContent = custom ? tr("editLayout", "Elrendezés szerkesztése") : tr("copyLayout", "Sablon másolása");
    id("irProfileStatus").textContent = profileError || (supported ? (draft || currentConfig.irActionLearning || selectedIrAction ? "" : tr("profileHelp", "A kiosztás kiválasztása után tanítsd be a saját távirányítód gombjait. A kódok típusonként külön megmaradnak.")) :
      tr("needsFirmware", "A sablonokhoz a hozzájuk tartozó firmware frissítése is szükséges."));
    id("irRemoteName").textContent = l.name;
    id("irLayoutEditor").classList.toggle("hidden", !draft);
    id("irEmptyHint").hidden = !draft || !!draft.buttons.length;
    document.querySelector("#irWorkbench > .learn-panel").classList.toggle("hidden", !!draft);
    id("irWorkbench").classList.toggle("is-editing", !!draft);
    id("irWorkbench").style.setProperty("--remote-width", Math.max(270, l.columns * 60 + 40) + "px");
    const codes = draft ? draftCodes : Object.fromEntries(l.buttons.map(b => [b.id, String(currentConfig[irKey(b.action)] || "0")]));
    const next = JSON.stringify([l, !!draft, custom, selected, selectedIrAction, available, codes, saving]);
    if (next === signature) return; signature = next;
    const remote = id("irRemote");
    const focused = remote.contains(document.activeElement) ? document.activeElement : null;
    if (remote.dataset.columns !== String(l.columns)) {
      remote.style.setProperty("--ir-columns", l.columns);
      remote.dataset.columns = l.columns;
    }
    if (remote.style.getPropertyValue("--ir-rows") !== String(l.rows)) remote.style.setProperty("--ir-rows", l.rows);
    for (let row = 0; row < l.rows; ++row) for (let column = 0; column < l.columns; ++column) {
      const b = l.buttons.find(item => item.row === row && item.column === column);
      const index = row * l.columns + column;
      const old = remote.children[index];
      const prev = cellStates.get(old);
      const cell = row + ":" + column;
      const active = !!b && (draft ? selected === b.id : selectedIrAction === b.action);
      const learned = !!b && !!codes[b.id] && codes[b.id] !== "0";
      const disabled = draft ? saving : !available || !b?.action;
      const state = JSON.stringify([b, active, learned, disabled, custom]);
      const reuse = prev && old.dataset.cell === cell && prev.id === b?.id && prev.editing === !!draft;
      if (reuse && prev.state === state) continue;
      const n = reuse ? old : document.createElement(b || draft ? "button" : "span");
      if (!reuse) n.dataset.cell = cell;
      if (!b) {
        n.className = draft ? "remote-empty" : "remote-spacer";
        if (draft) { n.type = "button"; n.textContent = "+"; n.disabled = saving; n.setAttribute("aria-label", tr("addHere", "Új gomb ide") + ` (${row + 1}, ${column + 1})`); n.onclick = () => add(row, column); }
      } else {
        n.type = "button"; n.dataset.buttonId = b.id;
        n.setAttribute("data-user-content", "");
        n.className = `remote-btn tone-${b.tone} shape-${b.shape}${learned ? " learned" : ""}${b.action ? "" : " unassigned"}`;
        if (active) n.classList.add(draft ? "is-selected" : "active");
        const motif = (draft || custom) && motifFor(b.label);
        if (!reuse || prev.label !== b.label || prev.custom !== custom) {
          if (motif) n.innerHTML = window.SRUI.icon(motif[1]);
          else n.textContent = b.label || "·";
        }
        const action = P.ACTIONS.find(item => item.action === b.action);
        const help = action ? irActionLabel(action) : tr("unassigned", "Nincs hozzárendelve");
        const caption = motif ? tr(motif[2], motif[3]) : b.label.replace(/\n/g, " ");
        n.title = help; n.setAttribute("aria-label", `${caption} · ${help}`);
        n.setAttribute("aria-pressed", String(active)); n.disabled = disabled;
        n.onclick = () => {
          if (draft) { selected = b.id; render(); form(); }
          else startIrLearning(b.action);
        };
        if (draft) {
          n.draggable = true;
          n.ondragstart = event => event.dataTransfer.setData("text/plain", String(b.id));
        }
      }
      cellStates.set(n, { id: b?.id, label: b?.label, custom, editing: !!draft, state });
      if (!old) remote.appendChild(n);
      else if (!reuse) old.replaceWith(n);
    }
    while (remote.children.length > l.rows * l.columns) remote.lastElementChild.remove();
    if (focused && !focused.isConnected) remote.querySelector(`button[data-cell="${focused.dataset.cell}"]:enabled`)?.focus({ preventScroll: true });
  }
  function edit(blank = false) {
    if (draft || configSaving) return;
    draft = blank ? P.get("custom") : P.normalize(profile());
    if (blank || currentConfig.irRemoteProfile !== "custom") draft.name = tr("myRemote", "Saját távirányító");
    draftCodes = Object.fromEntries(draft.buttons.map(b => [b.id, String(currentConfig[irKey(b.action)] || "0")]));
    selected = draft.buttons[0]?.id || 0; pending = null; dirty = false;
    id("irActionLearning").value = "";
    if (currentConfig.irActionLearning) postConfig({ irActionLearning: "" });
    selectedIrAction = ""; render(); form();
    message(!blank && currentConfig.irRemoteProfile !== "custom" && currentConfig.irRemoteCustom
      ? tr("replaceOnSave", "A másolat mentése felülírja a korábbi egyéni kiosztást.")
      : "");
  }
  function form() {
    if (!draft) return;
    id("irLayoutName").value = draft.name; id("irLayoutColumns").value = draft.columns; id("irLayoutRows").value = draft.rows;
    const b = draft.buttons.find(item => item.id === selected);
    id("irButtonFields").disabled = !b;
    id("irButtonFields").hidden = !b;
    syncMotifs(b?.label);
    for (const [field, key] of [["irButtonLabel", "label"], ["irButtonAction", "action"], ["irButtonShape", "shape"], ["irButtonTone", "tone"]]) id(field).value = b?.[key] || "";
    id("irButtonRow").value = b ? b.row + 1 : ""; id("irButtonRow").max = draft.rows;
    id("irButtonColumn").value = b ? b.column + 1 : ""; id("irButtonColumn").max = draft.columns;
  }
  function syncMotifs(label) {
    for (const node of id("irButtonMotifs").children) {
      const pressed = String(node.dataset.motif === label);
      if (node.getAttribute("aria-pressed") !== pressed) node.setAttribute("aria-pressed", pressed);
    }
  }
  function updateLayout(key, value) {
    if (!draft || saving) return;
    if (key === "name") {
      draft.name = value; dirty = true; render();
      message(tr("unsaved", "Még nem mentett módosítások")); return;
    }
    const next = { ...draft, [key]: key === "name" ? value : Number(value) };
    try { P.normalize(next); } catch (_) {
      form(); message(tr("gridError", "A méret érvénytelen, vagy a kisebb rácson kívülre kerülne egy gomb. Előbb mozgasd el vagy töröld azt."), true); return;
    }
    draft = next; dirty = true; message(tr("unsaved", "Még nem mentett módosítások")); render(); form();
  }
  function updateButton(key, value) {
    if (!draft || saving) return;
    const b = draft.buttons.find(item => item.id === selected); if (!b) return;
    const previous = b[key]; b[key] = ["row", "column"].includes(key) ? Number(value) - 1 : value;
    try { P.normalize(draft); } catch (_) {
      b[key] = previous; form(); message(tr("buttonError", "A hely foglalt, az érték érvénytelen, vagy ez a funkció már másik gombhoz tartozik."), true); return;
    }
    dirty = true; message(tr("unsaved", "Még nem mentett módosítások")); render();
    if (key === "label") syncMotifs(value);
  }
  function add(row, column) {
    if (!draft || saving) return;
    if (row === undefined) {
      for (let y = 0; y < draft.rows; ++y) for (let x = 0; x < draft.columns; ++x) {
        if (!draft.buttons.some(b => b.row === y && b.column === x)) return add(y, x);
      }
      return message(tr("noSpace", "Nincs üres hely. Növeld a rács méretét."), true);
    }
    const key = Array.from({ length: 40 }, (_, i) => i + 1).find(n => !draft.buttons.some(b => b.id === n));
    if (!key) return message(tr("maxButtons", "Legfeljebb 40 gomb helyezhető el."), true);
    draft.buttons.push({ id: key, row, column, label: tr("newButton", "Gomb"), action: "", shape: "pill", tone: "normal" });
    draftCodes[key] = "0"; selected = key; dirty = true; render(); form(); message(tr("chooseFunction", "Az új gombhoz válassz funkciót, majd mentés után tanítsd be."));
  }
  function remove() {
    if (!draft || saving) return;
    draft.buttons = draft.buttons.filter(b => b.id !== selected); delete draftCodes[selected];
    selected = draft.buttons[0]?.id || 0; dirty = true; render(); form(); message(tr("unsaved", "Még nem mentett módosítások"));
  }
  function empty() {
    if (!draft || saving) return;
    draft.buttons = []; draftCodes = {}; selected = 0; dirty = true;
    render(); form(); message(tr("unsaved", "Még nem mentett módosítások"));
  }
  function cancel() { if (saving) return; draft = null; pending = null; selected = 0; render(); renderIrMappedList(); }
  function syncConfig(config) {
    if (!pending || config.irRemoteProfile !== "custom") return;
    try {
      if (JSON.stringify(P.normalize(JSON.parse(config.irRemoteCustom))) === pending) {
        draft = null; pending = null; selected = 0;
      }
    } catch (_) {}
  }
  async function save() {
    if (!draft || saving) return;
    if (configSaving || sliderGestures.size) {
      message(tr("busy", "Várd meg a folyamatban lévő mentést, majd próbáld újra."), true); return;
    }
    let normalized;
    try { normalized = P.normalize(draft); } catch (_) { message(tr("invalid", "Ellenőrizd az elrendezés adatait."), true); return; }
    pending = JSON.stringify(normalized); saving = true; id("irLayoutSave").disabled = true;
    id("irEditorControls").disabled = true; id("irButtonFields").disabled = true;
    message(tr("saving", "Mentés…"));
    try {
      const ok = await postConfig({ irRemoteProfile: "custom", irRemoteCustom: pending,
        irRemoteCodeMap: JSON.stringify(P.codeMap(normalized, draftCodes)), irActionLearning: "" });
      if (draft) message(ok ? tr("waitingSave", "Várakozás a mentés visszaigazolására…") : tr("saveFailed", "A mentés nem sikerült. Próbáld újra."), !ok);
    } finally {
      saving = false; id("irLayoutSave").disabled = false; id("irEditorControls").disabled = false;
      render(); if (draft) form();
    }
  }
  window.SRRemoteUI = { render, edit, save, cancel, add, remove, empty, updateLayout, updateButton, syncConfig,
    buttonLabel(action) {
      const label = profile().buttons.find(b => b.action === action)?.label || "";
      const motif = motifFor(label);
      return motif ? tr(motif[2], motif[3]) : label.replace(/\s+/g, " ").trim();
    },
    actions: () => layout().buttons.filter(b => b.action).map(b => ({ action: b.action, label: P.ACTIONS.find(a => a.action === b.action)?.label || b.label })) };
  window.addEventListener("beforeunload", event => { if (draft && (dirty || saving)) { event.preventDefault(); event.returnValue = ""; } });
})();
