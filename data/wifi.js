function setStatus(text) {
  document.getElementById("status").textContent = text;
}

const t = (key, fallback, vars) =>
  window.srT ? window.srT(key, fallback, vars) : String(fallback || key).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) =>
    vars && Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : `{${name}}`
  );

async function load() {
  if (window.srApplyI18n) window.srApplyI18n(document);
  try {
    const res = await fetch("/scan");
    const ssids = await res.json();
    const sel = document.getElementById("ssid");
    sel.innerHTML = "";
    ssids.forEach(s => {
      const option = document.createElement("option");
      option.text = s;
      option.value = s;
      sel.add(option);
    });
    setStatus(ssids.length ? t("wifi.networksFound", "{count} hálózat található", { count: ssids.length }) : t("wifi.noNetworks", "Nem találtam hálózatot"));
  } catch (err) {
    setStatus(t("wifi.scanFailed", "Keresés sikertelen"));
  }
}

async function save() {
  const ssid = document.getElementById("ssid").value;
  const pass = document.getElementById("pass").value;
  setStatus(t("wifi.saving", "Mentés..."));
  await fetch("/save", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `ssid=${encodeURIComponent(ssid)}&pass=${encodeURIComponent(pass)}`
  });
  setStatus(t("wifi.savedMayReboot", "Mentve, a rádió újraindulhat"));
}

load();
