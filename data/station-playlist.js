/* Browser-only yoRadio playlist interchange. Device storage stays JSON. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SRPlaylist = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const MAX_BYTES = 128 * 1024, MAX_STATIONS = 500, MAX_NAME_BYTES = 160, MAX_URL_BYTES = 2048;
  const bytes = text => new TextEncoder().encode(text).length;
  const key = url => String(url || "").trim();
  function valid(name, url) {
    if (!name || bytes(name) > MAX_NAME_BYTES || /[\x00-\x1f\x7f]/.test(name)) return "nameError";
    if (!/^https?:\/\/[^/?#\s]/i.test(url) || bytes(url) > MAX_URL_BYTES || /[\x00-\x20\x7f"<>]/.test(url)) return "url";
    return "";
  }
  function fields(line, delimiter) {
    // Original yoRadio is TSV, with literal quotes, not RFC-quoted TSV.
    if (delimiter === "\t") return line.split("\t");
    const out = []; let value = "", quoted = false, closed = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c !== '"') value += c;
        else if (line[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else if (c === delimiter) { out.push(value); value = ""; closed = false; }
      else if (c === '"' && !value && !closed) quoted = true;
      else if (closed && c.trim()) throw Error("format");
      else if (!closed) value += c;
    }
    if (quoted) throw Error("format");
    out.push(value); return out;
  }
  function delimiter(first) {
    if (first.includes("\t")) return "\t";
    for (const count of [3, 2]) for (const separator of [",", ";"]) {
      try { if (fields(first, separator).length === count) return separator; } catch (_) { /* report below */ }
    }
    return ",";
  }
  function parse(text) {
    text = String(text).replace(/^\uFEFF/, "");
    if (bytes(text) > MAX_BYTES) return { entries: [], errors: [{ line: 0, code: "limit" }], ignoredOvol: 0 };
    const lines = text.split(/\r\n|\n|\r/), entries = [], errors = [];
    const separator = delimiter(lines.find(line => line.trim()) || "");
    let first = true, ignoredOvol = 0;
    for (let n = 0; n < lines.length; n++) {
      if (!lines[n].trim()) continue;
      let row;
      try { row = fields(lines[n], separator).map(value => value.trim()); }
      catch (_) { errors.push({ line: n + 1, code: "format" }); continue; }
      if (first && /^(name|station|név|adó neve)$/i.test(row[0]) && /^(url|stream|streamurl)$/i.test(row[1] || "")) { first = false; continue; }
      first = false;
      const code = row.length < 2 || row.length > 3 ? "format" : valid(row[0], row[1]);
      if (code) errors.push({ line: n + 1, code });
      else {
        entries.push({ name: row[0], url: row[1], line: n + 1 });
        if (row[2] && Number(row[2]) !== 0) ignoredOvol++;
      }
      if (entries.length > MAX_STATIONS || errors.length >= 100) { errors.push({ line: n + 1, code: "limit" }); break; }
    }
    if (!entries.length && !errors.length) errors.push({ line: 0, code: "empty" });
    return { entries, errors, ignoredOvol };
  }
  function plan(existing, entries, mode) {
    if (mode !== "append" && mode !== "replace") throw Error("invalid");
    const rows = mode === "append" ? existing.slice() : [], seen = new Set(rows.map(row => key(row.url)));
    let added = 0, skipped = 0;
    for (const entry of entries) {
      if (seen.has(key(entry.url))) { skipped++; continue; }
      seen.add(key(entry.url)); rows.push({ name: entry.name, url: entry.url }); added++;
    }
    return { rows, added, skipped, total: rows.length, limit: rows.length > MAX_STATIONS };
  }
  function serialize(stations) {
    return stations.map(station => {
      const name = String(station.name || "").trim(), url = key(station.url);
      const error = valid(name, url); if (error) throw Error(error);
      return name + "\t" + url + "\t0";
    }).join("\r\n") + (stations.length ? "\r\n" : "");
  }
  return { MAX_BYTES, MAX_STATIONS, parse, plan, serialize, valid, key, bytes };
});
