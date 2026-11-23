const themePresets = {
  green: { accent: "#a9f7bf", strong: "#69e58d", accentRgb: "169, 247, 191", strongRgb: "105, 229, 141" },
  amber: { accent: "#f5ce74", strong: "#dca84f", accentRgb: "245, 206, 116", strongRgb: "220, 168, 79" },
  blue: { accent: "#84b2ff", strong: "#5d8df0", accentRgb: "132, 178, 255", strongRgb: "93, 141, 240" },
  cyan: { accent: "#70e1eb", strong: "#42c8d8", accentRgb: "112, 225, 235", strongRgb: "66, 200, 216" },
  red: { accent: "#f20202", strong: "#b80000", accentRgb: "242, 2, 2", strongRgb: "184, 0, 0" }
};

function normalizeThemeAccent(theme) {
  if (theme === "ruby") return "red";
  return theme === "custom" || Object.prototype.hasOwnProperty.call(themePresets, theme) ? theme : "green";
}

// Keep the selected color when legible. Only adjust tones that would disappear
// against a light or dark tab, especially near-white and near-black custom colors.
function iconColorForTab(hex, dark) {
  const rgb = hex.match(/[a-f\d]{2}/gi).map(pair => parseInt(pair, 16));
  const end = dark ? 255 : 0;
  for (let step = 0; step <= 16; step++) {
    const tone = rgb.map(channel => Math.round(channel + (end - channel) * step / 16));
    const [r, g, b] = tone.map(channel => {
      const s = channel / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (dark ? luminance >= 0.18 : luminance <= 0.24) {
      return "#" + tone.map(channel => channel.toString(16).padStart(2, "0")).join("");
    }
  }
}

let themeIconTemplate;
let requestedIconColor = "";
async function setThemeIconColor(color) {
  if (!/^#[\da-f]{6}$/i.test(color) || color === requestedIconColor) return;
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  requestedIconColor = color;
  if (!themeIconTemplate) {
    themeIconTemplate = fetch(link.href).then(async response => {
      if (!response.ok) throw Error("favicon");
      const svg = new DOMParser().parseFromString(await response.text(), "image/svg+xml").documentElement;
      if (svg.localName !== "svg") throw Error("favicon");
      return svg;
    }).catch(() => {
      themeIconTemplate = null;
      return null;
    });
  }
  const svg = await themeIconTemplate;
  if (color !== requestedIconColor) return;
  if (!svg) { requestedIconColor = ""; return; }
  svg.style.setProperty("--icon-light", iconColorForTab(color, false));
  svg.style.setProperty("--icon-dark", iconColorForTab(color, true));
  const href = "data:image/svg+xml," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
  link.href = href;
  const mark = document.querySelector(".wordmark img");
  if (mark) mark.src = href;
}

