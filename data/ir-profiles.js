(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.SRRemoteProfiles = api;
})(globalThis, function () {
  "use strict";
  const ACTIONS = [
    ["prev", "Előző állomás"], ["next", "Következő állomás"], ["toggle", "Lejátszás / megállítás"],
    ["volUp", "Hangerő növelése"], ["volDown", "Hangerő csökkentése"], ["mute", "Kijelzés váltása"],
    ["power", "Leállítás"], ["up", "Fel / következő állomás"], ["down", "Le / előző állomás"],
    ["left", "Balra / előző állomás"], ["right", "Jobbra / következő állomás"], ["ok", "OK / lejátszás"],
    ["list", "Állomáslista"], ["back", "Vissza"],
    ...Array.from({ length: 10 }, (_, i) => ["digit" + i, String(i)]),
    ["star", "Némítás"], ["hash", "Megállítás / lista bezárása"],
    ...Array.from({ length: 5 }, (_, i) => ["station" + (i + 1), (i + 1) + ". állomás"])
  ].map(([action, label]) => ({ action, label }));
  const ids = new Set(ACTIONS.map(item => item.action));
  // Compare decimal text so no browser Number conversion can lose IR bits.
  const codeValid = value => typeof value === "string" && /^\d{1,20}$/.test(value) &&
    (value.length < 20 || value <= "18446744073709551615");
  const textBytes = value => new TextEncoder().encode(value).length;
  function normalize(layout) {
    if (!layout || layout.schemaVersion !== 1 || typeof layout.name !== "string" || !layout.name.trim() ||
        textBytes(layout.name.trim()) > 64 || !Number.isInteger(layout.columns) || layout.columns < 1 || layout.columns > 5 ||
        !Number.isInteger(layout.rows) || layout.rows < 1 || layout.rows > 12 || !Array.isArray(layout.buttons) || layout.buttons.length > 40) throw Error("layout");
    const usedIds = new Set(), cells = new Set(), actions = new Set();
    const buttons = layout.buttons.map(b => {
      if (!b || !Number.isInteger(b.id) || b.id < 1 || b.id > 40 || usedIds.has(b.id) ||
          !Number.isInteger(b.row) || b.row < 0 || b.row >= layout.rows || !Number.isInteger(b.column) || b.column < 0 || b.column >= layout.columns ||
          typeof b.label !== "string" || textBytes(b.label) > 32 || typeof b.action !== "string" ||
          (b.action && (!ids.has(b.action) || actions.has(b.action))) || !["pill", "round"].includes(b.shape) ||
          !["normal", "light", "power", "accent"].includes(b.tone) || cells.has(b.row + ":" + b.column)) throw Error("button");
      usedIds.add(b.id); cells.add(b.row + ":" + b.column); if (b.action) actions.add(b.action);
      return { id: b.id, row: b.row, column: b.column, label: b.label, action: b.action, shape: b.shape, tone: b.tone };
    });
    const result = { schemaVersion: 1, name: layout.name.trim(), columns: layout.columns, rows: layout.rows, buttons };
    if (textBytes(JSON.stringify(result)) > 6144) throw Error("size");
    return result;
  }
  function grid(name, rows) {
    let id = 0;
    return normalize({ schemaVersion: 1, name, columns: 3, rows: rows.length,
      buttons: rows.flatMap((row, y) => row.flatMap((b, x) => !b ? [] : [{ id: ++id, row: y, column: x,
        label: b[0], action: b[1], shape: "pill", tone: b[2] || "normal" }])) });
  }
  const numbers = [[1, 2, 3], [4, 5, 6], [7, 8, 9]].map(row => row.map(n => [String(n), "digit" + n, "light"]));
  const templates = {
    rcnec21: grid("IR-RCNEC-BK", [
      [["PWR", "power", "power"], ["VOL+", "volUp"], ["FUNC\nSTOP", "hash"]],
      [["|◀", "prev"], ["▶Ⅱ", "toggle"], ["▶|", "next"]],
      [["▼", "down"], ["VOL−", "volDown"], ["▲", "up"]],
      [["0", "digit0", "light"], ["EQ", "mute"], ["ST/\nREPT", "list"]], ...numbers
    ]),
    car21: grid("CAR MP3", [
      [["CH−", "down", "power"], ["CH", "list", "power"], ["CH+", "up", "power"]],
      [["|◀", "prev"], ["▶|", "next"], ["▶Ⅱ", "toggle"]],
      [["−", "volDown"], ["+", "volUp"], ["EQ", "mute"]],
      [["0", "digit0", "light"], ["100+", "star", "accent"], ["200+", "hash", "accent"]], ...numbers
    ]),
    nav17: grid("IR 17", [...numbers,
      [["✱", "star"], ["0", "digit0", "light"], ["#", "list"]],
      [null, ["▲", "up"], null], [["◀", "left"], ["OK", "ok", "accent"], ["▶", "right"]],
      [null, ["▼", "down"], null]
    ])
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  function get(id, custom = "") {
    if (id === "custom" && custom) { try { return normalize(typeof custom === "string" ? JSON.parse(custom) : custom); } catch (_) {} }
    return clone(templates[id] || templates.rcnec21);
  }
  function codeMap(layout, codes) {
    const result = {};
    for (const b of normalize(layout).buttons) if (b.action) {
      const code = String(codes[b.id] || "0");
      if (!codeValid(code)) throw Error("code");
      result[b.action] = code;
    }
    return result;
  }
  return { ACTIONS, templates, get, normalize, codeMap, codeValid };
});
