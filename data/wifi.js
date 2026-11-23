/* SimpleRadio network setup runs locally on the radio's access point. */
(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const picker = byId("networkPicker"), list = byId("networks"), pass = byId("pass");
  const form = byId("setupForm"), status = byId("status");
  const t = (key, fallback, vars) => window.srT ? window.srT(key, fallback, vars) :
    String(fallback).replace(/\{(\w+)\}/g, (_, name) => vars?.[name] ?? "");
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  let networks = [], selected = null, active = -1, phase = "loading";
  let prefix = "", lastType = 0;
  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle("error", error);
  }
  function passwordVisibility(show) {
    pass.type = show ? "text" : "password";
    const button = byId("showPassword");
    button.setAttribute("aria-pressed", String(show));
    button.setAttribute("aria-label", show ? t("ui.hidePassword", "Jelszó elrejtése") : t("ui.showPassword", "Jelszó megjelenítése"));
    button.querySelector("use").setAttribute("href", "icons.svg#" + (show ? "eye-off" : "eye"));
  }
  function sync() {
    const idle = phase === "idle";
    picker.disabled = !idle || !networks.length;
    byId("rescan").disabled = !idle;
    byId("passwordField").hidden = selected?.open === true;
    pass.disabled = !idle || !selected || selected.open === true;
    byId("showPassword").disabled = pass.disabled;
    byId("connect").disabled = !idle || !selected || (selected.open === false && !pass.value);
  }
  function closeList() {
    list.hidden = true;
    picker.setAttribute("aria-expanded", "false");
    picker.removeAttribute("aria-activedescendant");
    prefix = "";
  }
  function highlight(index) {
    active = Math.max(0, Math.min(networks.length - 1, index));
    Array.from(list.children).forEach((row, i) => row.classList.toggle("active", i === active));
    const row = list.children[active];
    if (!row) return;
    picker.setAttribute("aria-activedescendant", row.id);
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }
  function openList() {
    if (picker.disabled) return;
    list.hidden = false;
    picker.setAttribute("aria-expanded", "true");
    highlight(networks.indexOf(selected));
  }
  function select(network) {
    if (selected?.ssid !== network.ssid) { pass.value = ""; passwordVisibility(false); }
    selected = network;
    byId("networkValue").textContent = network.ssid;
    Array.from(list.children).forEach((row, i) => row.setAttribute("aria-selected", String(networks[i] === selected)));
    closeList(); sync(); picker.focus();
  }
  picker.onclick = () => list.hidden ? openList() : closeList();
  picker.onkeydown = e => {
    if (e.key === "Tab") { closeList(); return; }
    if (e.key === "Escape") { closeList(); e.preventDefault(); return; }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (list.hidden) openList(); else if (networks[active]) select(networks[active]);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const closed = list.hidden;
      if (closed) openList();
      if (e.key === "Home") highlight(0);
      else if (e.key === "End") highlight(networks.length - 1);
      else if (!closed) highlight(active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key.length === 1 && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (list.hidden) openList();
      const now = Date.now();
      prefix = (now - lastType < 850 ? prefix : "") + e.key.toLocaleLowerCase();
      lastType = now;
      const index = networks.findIndex(n => n.ssid.toLocaleLowerCase().startsWith(prefix));
      if (index >= 0) highlight(index);
    }
  };
  document.addEventListener("pointerdown", e => { if (!byId("picker").contains(e.target)) closeList(); });
  picker.onblur = closeList;
  list.onmousedown = e => e.preventDefault();
  function renderNetworks(rows) {
    const byName = new Map();
    for (const entry of rows) {
      const network = typeof entry === "string" ? { ssid: entry } : entry;
      if (!network || typeof network.ssid !== "string" || !network.ssid) continue;
      if (!byName.has(network.ssid) || network.rssi > byName.get(network.ssid).rssi) byName.set(network.ssid, network);
    }
    networks = [...byName.values()].sort((a, b) => (b.rssi ?? -100) - (a.rssi ?? -100) || a.ssid.localeCompare(b.ssid));
    selected = byName.get(selected?.ssid) || null;
    if (!selected) { pass.value = ""; passwordVisibility(false); }
    byId("networkValue").textContent = selected?.ssid || t("wifi.choose", "Válassz hálózatot");
    list.replaceChildren();
    networks.forEach((network, i) => {
      const row = document.createElement("li");
      row.id = "network-" + i;
      row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(network === selected));
      const signal = document.createElement("span");
      signal.className = "network-signal"; signal.setAttribute("aria-hidden", "true");
      const level = network.rssi >= -55 ? 4 : network.rssi >= -68 ? 3 : network.rssi >= -80 ? 2 : 1;
      if (Number.isFinite(network.rssi)) for (let bar = 0; bar < 4; bar++) {
        const tick = document.createElement("i");
        tick.style.height = (4 + bar * 3) + "px";
        tick.classList.toggle("dim", bar >= level); signal.appendChild(tick);
      }
      const name = document.createElement("span"); name.className = "network-name"; name.textContent = network.ssid;
      row.append(signal, name);
      if (network.open) {
        const tag = document.createElement("span"); tag.className = "network-open"; tag.textContent = t("wifi.openNetwork", "Nyílt"); row.appendChild(tag);
      }
      row.onclick = () => select(network); list.appendChild(row);
    });
  }
  async function request(path, options = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    try { return await fetch(path, { cache: "no-store", ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }
  async function scan() {
    phase = "scanning"; closeList(); sync(); message(t("wifi.scanning", "Hálózatok keresése…"));
    try {
      for (let i = 0; i < 24; i++) {
        const response = await request("/scan?details=1" + (i === 0 ? "&fresh=1" : ""));
        if (response.status === 202) { await wait(500); continue; }
        if (!response.ok) throw Error();
        renderNetworks(await response.json());
        message(networks.length ? t("wifi.networksFound", "{count} hálózat található", { count: networks.length }) : t("wifi.noNetworks", "Nem találtam hálózatot"));
        return;
      }
      throw Error();
    } catch {
      renderNetworks([]); message(t("wifi.scanFailed", "Keresés sikertelen"), true);
    } finally { phase = "idle"; sync(); }
  }
  function probe(url) {
    return new Promise(resolve => {
      const img = new Image();
      const done = ok => { clearTimeout(timer); img.onload = img.onerror = null; resolve(ok); };
      const timer = setTimeout(() => done(false), 2200);
      img.onload = () => done(true); img.onerror = () => done(false);
      img.src = url;
    });
  }
  async function openRadio(result) {
    const ip = String(result.ip || "");
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip === "0.0.0.0" || ip.split(".").some(v => Number(v) > 255) || !/^[0-9a-f]{1,8}$/i.test(result.id)) throw Error();
    const dest = new URL("/", location.href);
    dest.hostname = ip;
    phase = "connected"; form.hidden = true; pass.value = "";
    byId("title").textContent = t("wifi.connectedTitle", "A rádió csatlakozott");
    byId("intro").textContent = t("wifi.joinSame", "Az automatikus megnyitáshoz a telefonod vagy számítógéped is a rádióval azonos hálózatra csatlakozzon.");
    byId("radioIp").textContent = dest.host; byId("radioLink").href = dest.href; byId("handoff").hidden = false;
    message(t("wifi.opening", "A webfelület megnyitása…"));
    // The radio may close the setup AP before the acknowledgement response arrives.
    const ack = await request("/setup/finish", { method: "POST", body: new URLSearchParams({ ip }) }).catch(() => null);
    if (ack?.status === 409) {
      form.hidden = false; byId("handoff").hidden = true;
      byId("title").textContent = t("wifi.title", "WiFi-beállítás");
      byId("intro").textContent = t("wifi.setupIntro", "Melyik hálózaton szeretnéd használni a rádiót?");
      return false;
    }
    for (let i = 0; i < 60; i++) {
      if (await probe(new URL("setup/ready.gif?id=" + result.id + "&try=" + i + "&t=" + Date.now(), dest).href)) {
        location.replace(dest.href); return true;
      }
      await wait(1000);
    }
    message(t("wifi.useLink", "Azonos hálózaton a fenti címről nyithatod meg a rádiót."));
    return true;
  }
  async function followJoin() {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      let state;
      try {
        const res = await request("/setup/status");
        if (res.ok) state = await res.json();
      } catch { /* A channel switch can briefly interrupt the setup network. */ }
      if (state?.state === "connected" && await openRadio(state)) return;
      if (state?.state === "join_failed") throw Error(t("wifi.joinFailed", "Nem sikerült csatlakozni. Ellenőrizd a hálózatot és a jelszót."));
      if (state?.state === "save_failed" || state?.state === "idle") throw Error(t("wifi.saveFailed", "Mentés sikertelen"));
      await wait(800);
    }
    throw Error(t("wifi.lost", "A rádió nem válaszol. Csatlakozz újra a beállítóhálózathoz, majd próbáld újra."));
  }
  async function connect(resume = false) {
    phase = "connecting"; closeList(); sync(); message(t("wifi.joining", "Csatlakozás a hálózathoz…"));
    try {
      if (!resume) {
        const body = new URLSearchParams({ ssid: selected.ssid, pass: selected.open ? "" : pass.value });
        let res;
        try { res = await request("/save", { method: "POST", body }); } catch { /* Recover an accepted request with a lost reply. */ }
        if (res && !res.ok && res.status !== 409) throw Error(t("wifi.saveFailed", "Mentés sikertelen"));
        if (res?.ok && res.status !== 202 && !(res.headers.get("content-type") || "").includes("json")) {
          message(t("wifi.savedMayReboot", "Mentve, a rádió újraindulhat")); return;
        }
      }
      await followJoin();
    } catch (error) {
      message(error.message || t("wifi.saveFailed", "Mentés sikertelen"), true);
      phase = "idle"; sync();
      if (!pass.disabled) pass.focus();
    }
  }
  byId("rescan").onclick = scan;
  byId("showPassword").onclick = () => passwordVisibility(pass.type === "password");
  pass.oninput = sync;
  form.onsubmit = e => { e.preventDefault(); if (!byId("connect").disabled) connect(); };
  async function init() {
    window.srApplyI18n?.(document); passwordVisibility(false); sync();
    try {
      const res = await request("/setup/status");
      if (res.ok) {
        const result = await res.json();
        if (result.state === "connected") { if (!await openRadio(result)) await connect(true); return; }
        if (result.state === "connecting") { await connect(true); return; }
      }
    } catch { /* Older firmware can still provide the original scan and save routes. */ }
    await scan();
  }
  init();
})();
