class SimpleRadioCard extends HTMLElement {
  setConfig(config) {
    if (!config.station_entity || !config.playback_entity || !config.volume_entity) {
      throw new Error("station_entity, playback_entity and volume_entity are required");
    }

    this.config = {
      command_topic: "simpleradio/command",
      show_stations: true,
      ...config
    };
    this._rendered = false;

    if (this._stationOpen === undefined) this._stationOpen = false;
    if (this._stationFilter === undefined) this._stationFilter = "";
  }

  set hass(hass) {
    this._hass = hass;
    if (this._rendered) {
      this.updateOpenCard();
      return;
    }
    this.render();
  }

  getCardSize() {
    if (this.config?.show_stations === false) return 3;
    return this._stationOpen ? 7 : 4;
  }

  entity(id) {
    return id ? this._hass?.states?.[id] : undefined;
  }

  escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[char]));
  }

  cssUrl(value) {
    return String(value || "").replace(/["'()\\]/g, (char) => `\\${char}`);
  }

  call(domain, service, data = {}) {
    this._hass.callService(domain, service, data);
  }

  pressButton(entityId) {
    if (entityId) this.call("button", "press", { entity_id: entityId });
  }

  publishCommand(payload) {
    this.call("mqtt", "publish", {
      topic: this.config.command_topic,
      payload
    });
  }

  resolveImage(raw) {
    raw = String(raw || "").trim();
    if (!raw || /\.sr565(?:[?#]|$)/i.test(raw)) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    const base = String(this.config.radio_url || "").replace(/\/$/, "");
    return base ? `${base}${raw.startsWith("/") ? raw : `/${raw}`}` : "";
  }

  stationImage(station) {
    return this.resolveImage(station?.logo || "");
  }

  artworkCandidates(attrs) {
    const station = this.stationList().find((item) => String(item.id) === String(attrs.stationId));
    const sources = [
      attrs.hasStreamImage ? attrs.cachedArtworkPath : "",
      attrs.albumArtworkPath,
      attrs.cachedArtworkPath,
      attrs.streamLogoUrl,
      attrs.stationLogo,
      station?.logo
    ];
    return [...new Set(sources.map((source) => this.resolveImage(source)).filter(Boolean))];
  }

  updateArtwork() {
    const art = this.querySelector(".sr-art");
    if (!art) return;
    const attrs = this.entity(this.config.station_entity)?.attributes || {};
    const candidates = this.artworkCandidates(attrs);
    const key = JSON.stringify(candidates);
    if (art.dataset.artworkKey === key) return;
    art.dataset.artworkKey = key;
    art.replaceChildren();
    art.textContent = "SR";

    // Keep the fallback visible until a browser-readable image has loaded.
    const tryNext = (index) => {
      if (art.dataset.artworkKey !== key || index >= candidates.length) return;
      const image = this.ownerDocument.createElement("img");
      image.alt = "";
      image.onload = () => {
        if (art.dataset.artworkKey !== key) return;
        art.replaceChildren(image);
      };
      image.onerror = () => tryNext(index + 1);
      image.src = candidates[index];
    };
    tryNext(0);
  }

  stationList() {
    const stationsEntity = this.entity(this.config.stations_entity);
    const stations = stationsEntity?.attributes?.stations;
    return Array.isArray(stations) ? stations : [];
  }

  filteredStations() {
    const query = this._stationFilter.trim().toLowerCase();
    const stations = this.stationList();
    if (!query) return stations;
    return stations.filter((station) => String(station.name || "").toLowerCase().includes(query));
  }

  stationNumber(station, index) {
    const value = station?.number ?? station?.stationNumber ?? station?.preset ?? station?.index;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : index + 1;
  }

  stationsSignature() {
    return JSON.stringify(this.stationList().map((station, index) => ({
      number: this.stationNumber(station, index),
      id: station.id,
      name: station.name || "",
      logo: station.logo || ""
    })));
  }

  renderStationRows(currentStationId) {
    const stations = this.filteredStations();
    if (!stations.length) {
      return `<div class="sr-empty">Nincs találat</div>`;
    }

    return stations.map((station, index) => {
      const image = this.stationImage(station);
      const active = Number(station.id) === Number(currentStationId);
      const initials = String(station.name || "SR").slice(0, 2).toUpperCase();
      const number = this.stationNumber(station, index);
      return `
        <button class="sr-station-row${active ? " active" : ""}" data-station-id="${this.escape(station.id)}">
          <span class="sr-station-media">
            <span class="sr-station-logo" style="background-image: ${image ? `url('${this.cssUrl(image)}')` : "none"}">${image ? "" : this.escape(initials)}</span>
            <span class="sr-station-number">${this.escape(number)}</span>
          </span>
          <span class="sr-station-copy">
            <span class="sr-station-name">${this.escape(station.name || `Station ${station.id}`)}</span>
            <span class="sr-station-sub">${active ? "Aktív állomás" : "Lejátszás"}</span>
          </span>
          <ha-icon icon="${active ? "mdi:volume-high" : "mdi:play"}"></ha-icon>
        </button>
      `;
    }).join("");
  }

  currentStationId() {
    const station = this.entity(this.config.station_entity);
    return station?.attributes?.stationId;
  }

  captureInteractiveState() {
    const search = this.querySelector(".sr-search");
    const list = this.querySelector(".sr-station-list");
    return {
      searchFocused: !!search && this.ownerDocument.activeElement === search,
      searchSelectionStart: search?.selectionStart ?? null,
      searchSelectionEnd: search?.selectionEnd ?? null,
      listScrollTop: list?.scrollTop ?? null
    };
  }

  restoreInteractiveState(state) {
    if (!state || !this._stationOpen) return;

    const list = this.querySelector(".sr-station-list");
    if (list && state.listScrollTop !== null) {
      list.scrollTop = state.listScrollTop;
    }

    const search = this.querySelector(".sr-search");
    if (search && state.searchFocused) {
      search.focus();
      if (state.searchSelectionStart !== null && state.searchSelectionEnd !== null) {
        search.setSelectionRange(state.searchSelectionStart, state.searchSelectionEnd);
      }
    }
  }

  updateStationList({ preserveScroll = true } = {}) {
    const list = this.querySelector(".sr-station-list");
    if (!list) return;

    const previousScrollTop = list.scrollTop;
    list.innerHTML = this.renderStationRows(this.currentStationId());
    if (preserveScroll) list.scrollTop = previousScrollTop;
    this.attachStationRowHandlers();
  }

  updateText(selector, value) {
    const node = this.querySelector(selector);
    if (node) node.textContent = value;
  }

  currentViewModel() {
    const station = this.entity(this.config.station_entity);
    const playback = this.entity(this.config.playback_entity);
    const volume = this.entity(this.config.volume_entity);
    const attrs = station?.attributes || {};
    const isPlaying = playback?.state === "on" || attrs.playing === true;
    const title = attrs.title || this.entity(this.config.title_entity)?.state || "";
    const artist = attrs.artist || this.entity(this.config.artist_entity)?.state || "";
    const detailText = [artist, attrs.codec || "", attrs.bitrate || ""].filter(Boolean).join(" · ");
    const stationName = station?.state && !["unknown", "unavailable"].includes(station.state)
      ? station.state
      : "SimpleRadio";
    const volumeValue = Number(volume?.state ?? attrs.volume ?? 0);
    const safeVolume = Number.isFinite(volumeValue) ? Math.round(volumeValue) : 0;

    return {
      isPlaying,
      title,
      detailText,
      stationName,
      safeVolume,
      currentStationId: attrs.stationId,
      statusText: isPlaying ? "Élő adás" : "Megállítva"
    };
  }

  updateOpenCard() {
    const state = this.captureInteractiveState();
    const model = this.currentViewModel();

    this.updateArtwork();

    this.updateText(".sr-status-text", model.statusText);
    this.updateText(".sr-volume-chip", `${model.safeVolume}%`);
    this.updateText(".sr-station", model.stationName);
    this.updateText(".sr-title", model.title || (model.isPlaying ? "Nincs metadata" : "Lejátszás szünetel"));
    this.updateText(".sr-detail", model.detailText || "\u00a0");
    this.updateText(".sr-volume-percent", `${model.safeVolume}%`);

    const volumeInput = this.querySelector(".volume");
    if (volumeInput && this.ownerDocument.activeElement !== volumeInput) {
      volumeInput.value = String(model.safeVolume);
    }

    const playIcon = this.querySelector(".play ha-icon");
    if (playIcon) playIcon.setAttribute("icon", model.isPlaying ? "mdi:stop" : "mdi:play");
    const dot = this.querySelector(".sr-dot");
    if (dot) {
      dot.style.background = model.isPlaying ? "var(--success-color, #2fbd68)" : "var(--disabled-text-color)";
      dot.style.boxShadow = model.isPlaying
        ? "0 0 0 4px color-mix(in srgb, var(--success-color, #2fbd68) 18%, transparent)"
        : "none";
    }

    const stationsSignature = this.stationsSignature();
    const stationsChanged = stationsSignature !== this._stationsSignature;
    if (stationsChanged) {
      this._stationsSignature = stationsSignature;
      const stationCount = this.stationList().length;
      this.updateText(".sr-picker-count", stationCount ? `${stationCount} mentett` : "Nincs lista");
    }

    if (stationsChanged || this._listedStationId !== model.currentStationId) {
      this.updateStationList({ preserveScroll: true });
      this._listedStationId = model.currentStationId;
    }
    this.restoreInteractiveState(state);
  }

  attachStationRowHandlers() {
    this.querySelectorAll(".sr-station-row").forEach((row) => {
      row.addEventListener("click", () => {
        this.publishCommand(`play ${row.dataset.stationId}`);
        this._stationOpen = false;
        this._stationFilter = "";
        this.render();
      });
    });
  }

  renderStationPicker(stationCount, currentStationId) {
    if (this.config.show_stations === false) return "";

    const label = this._stationOpen ? "Állomások elrejtése" : "Állomások";
    const countText = stationCount ? `${stationCount} mentett` : "Nincs lista";
    const picker = this._stationOpen
      ? `
        <div class="sr-picker">
          <div class="sr-search-wrap">
            <ha-icon icon="mdi:magnify"></ha-icon>
            <input class="sr-search" type="search" placeholder="Keresés az állomások között" value="${this.escape(this._stationFilter)}">
          </div>
          <div class="sr-station-list">${this.renderStationRows(currentStationId)}</div>
        </div>
      `
      : "";

    return `
      <div class="sr-stations">
        <button class="sr-picker-toggle" type="button">
          <span>
            <strong>${label}</strong>
            <small class="sr-picker-count">${countText}</small>
          </span>
          <ha-icon icon="${this._stationOpen ? "mdi:chevron-up" : "mdi:chevron-down"}"></ha-icon>
        </button>
        ${picker}
      </div>
    `;
  }

  render(interactiveState = null) {
    if (!this.config || !this._hass) return;

    const station = this.entity(this.config.station_entity);
    const playback = this.entity(this.config.playback_entity);
    const volume = this.entity(this.config.volume_entity);
    const attrs = station?.attributes || {};
    const isPlaying = playback?.state === "on" || attrs.playing === true;
    const title = attrs.title || this.entity(this.config.title_entity)?.state || "";
    const artist = attrs.artist || this.entity(this.config.artist_entity)?.state || "";
    const codec = attrs.codec || "";
    const bitrate = attrs.bitrate || "";
    const stationName = station?.state && !["unknown", "unavailable"].includes(station.state)
      ? station.state
      : "SimpleRadio";
    const volumeValue = Number(volume?.state ?? attrs.volume ?? 0);
    const safeVolume = Number.isFinite(volumeValue) ? Math.round(volumeValue) : 0;
    const currentStationId = attrs.stationId;
    const stations = this.stationList();
    const detailText = [artist, codec, bitrate].filter(Boolean).join(" · ");
    const statusText = isPlaying ? "Élő adás" : "Megállítva";
    this._stationsSignature = this.stationsSignature();
    this._listedStationId = currentStationId;

    this.innerHTML = `
      <ha-card>
        <style>
          ha-card {
            overflow: hidden;
            border-radius: 16px;
          }
          .sr-shell {
            padding: 16px;
            background:
              radial-gradient(circle at top left, color-mix(in srgb, var(--primary-color) 16%, transparent), transparent 34%),
              linear-gradient(180deg, color-mix(in srgb, var(--card-background-color) 92%, var(--primary-color)), var(--card-background-color));
          }
          .sr-now {
            display: grid;
            grid-template-columns: 96px minmax(0, 1fr);
            gap: 14px;
            align-items: center;
          }
          .sr-art {
            width: 96px;
            height: 96px;
            border-radius: 14px;
            background: color-mix(in srgb, var(--secondary-background-color) 82%, black);
            background-size: contain;
            background-position: center;
            background-repeat: no-repeat;
            box-shadow: 0 12px 28px rgba(0, 0, 0, .20);
            display: grid;
            place-items: center;
            color: var(--secondary-text-color);
            font-weight: 750;
          }
          .sr-main {
            min-width: 0;
          }
          .sr-art img {
            width: 100%;
            height: 100%;
            min-height: 0;
            object-fit: contain;
            border-radius: inherit;
          }
          .sr-topline {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 7px;
          }
          .sr-status {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            color: var(--secondary-text-color);
            font-size: .78rem;
            font-weight: 650;
          }
          .sr-dot {
            width: 8px;
            height: 8px;
            border-radius: 999px;
            background: ${isPlaying ? "var(--success-color, #2fbd68)" : "var(--disabled-text-color)"};
            box-shadow: ${isPlaying ? "0 0 0 4px color-mix(in srgb, var(--success-color, #2fbd68) 18%, transparent)" : "none"};
          }
          .sr-volume-chip {
            border-radius: 999px;
            padding: 4px 9px;
            background: color-mix(in srgb, var(--secondary-background-color) 80%, transparent);
            color: var(--primary-text-color);
            font-size: .78rem;
            font-weight: 700;
          }
          .sr-station, .sr-title, .sr-detail {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .sr-station {
            font-size: 1.12rem;
            line-height: 1.25;
            font-weight: 750;
            letter-spacing: 0;
          }
          .sr-title {
            margin-top: 5px;
            color: var(--primary-text-color);
            font-size: .98rem;
            line-height: 1.35;
          }
          .sr-detail {
            margin-top: 3px;
            color: var(--secondary-text-color);
            font-size: .84rem;
            line-height: 1.35;
          }
          .sr-controls {
            display: grid;
            grid-template-columns: 46px 54px 46px minmax(0, 1fr);
            gap: 9px;
            align-items: center;
            margin-top: 16px;
          }
          .sr-icon-button {
            height: 46px;
            border: 0;
            border-radius: 12px;
            background: color-mix(in srgb, var(--secondary-background-color) 86%, transparent);
            color: var(--primary-text-color);
            cursor: pointer;
            display: grid;
            place-items: center;
            transition: transform .14s ease, background .14s ease, box-shadow .14s ease;
          }
          .sr-icon-button.play {
            width: 54px;
            height: 54px;
            border-radius: 16px;
            background: var(--primary-color);
            color: var(--text-primary-color, white);
            box-shadow: 0 10px 22px color-mix(in srgb, var(--primary-color) 34%, transparent);
          }
          .sr-icon-button:hover,
          .sr-picker-toggle:hover,
          .sr-station-row:hover {
            background: color-mix(in srgb, var(--primary-color) 12%, var(--secondary-background-color));
          }
          .sr-icon-button:active,
          .sr-picker-toggle:active,
          .sr-station-row:active {
            transform: translateY(1px);
          }
          .sr-volume {
            min-width: 0;
            display: grid;
            gap: 5px;
          }
          .sr-volume-label {
            display: flex;
            align-items: center;
            justify-content: space-between;
            color: var(--secondary-text-color);
            font-size: .76rem;
            font-weight: 650;
          }
          input[type="range"] {
            width: 100%;
            accent-color: var(--primary-color);
          }
          .sr-stations {
            margin-top: 14px;
            border-top: 1px solid color-mix(in srgb, var(--divider-color) 70%, transparent);
            padding-top: 10px;
          }
          .sr-picker-toggle {
            width: 100%;
            min-height: 48px;
            border: 0;
            border-radius: 12px;
            background: color-mix(in srgb, var(--secondary-background-color) 76%, transparent);
            color: var(--primary-text-color);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 8px 12px;
            text-align: left;
          }
          .sr-picker-toggle strong,
          .sr-picker-toggle small {
            display: block;
            line-height: 1.25;
          }
          .sr-picker-toggle strong {
            font-size: .92rem;
            font-weight: 750;
          }
          .sr-picker-toggle small {
            color: var(--secondary-text-color);
            font-size: .76rem;
            margin-top: 2px;
          }
          .sr-picker {
            margin-top: 8px;
            display: grid;
            gap: 8px;
          }
          .sr-search-wrap {
            height: 40px;
            border-radius: 12px;
            background: color-mix(in srgb, var(--card-background-color) 75%, var(--secondary-background-color));
            display: grid;
            grid-template-columns: 32px minmax(0, 1fr);
            align-items: center;
            padding: 0 8px;
            color: var(--secondary-text-color);
          }
          .sr-search {
            min-width: 0;
            border: 0;
            outline: 0;
            background: transparent;
            color: var(--primary-text-color);
            font: inherit;
            font-size: .88rem;
          }
          .sr-station-list {
            max-height: 270px;
            overflow: auto;
            display: grid;
            gap: 5px;
            padding-right: 2px;
          }
          .sr-station-row {
            width: 100%;
            min-height: 52px;
            border: 0;
            border-radius: 12px;
            background: transparent;
            color: var(--primary-text-color);
            cursor: pointer;
            display: grid;
            grid-template-columns: 42px minmax(0, 1fr) 24px;
            gap: 10px;
            align-items: center;
            text-align: left;
            padding: 7px 9px;
          }
          .sr-station-row.active {
            background: color-mix(in srgb, var(--primary-color) 14%, var(--secondary-background-color));
          }
          .sr-station-media {
            position: relative;
            width: 42px;
            height: 42px;
          }
          .sr-station-logo {
            width: 38px;
            height: 38px;
            border-radius: 10px;
            background: var(--card-background-color);
            background-size: contain;
            background-position: center;
            background-repeat: no-repeat;
            color: var(--secondary-text-color);
            display: grid;
            place-items: center;
            font-size: .76rem;
            font-weight: 750;
            box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--divider-color) 65%, transparent);
          }
          .sr-station-number {
            position: absolute;
            right: -2px;
            bottom: -2px;
            min-width: 18px;
            height: 18px;
            border-radius: 999px;
            background: var(--primary-color);
            color: var(--text-primary-color, white);
            display: grid;
            place-items: center;
            padding: 0 5px;
            font-size: .64rem;
            font-weight: 800;
            line-height: 1;
            box-shadow: 0 2px 6px rgba(0, 0, 0, .25);
          }
          .sr-station-copy {
            min-width: 0;
            display: grid;
            gap: 2px;
          }
          .sr-station-name,
          .sr-station-sub {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .sr-station-name {
            font-size: .91rem;
            font-weight: 700;
          }
          .sr-station-sub {
            color: var(--secondary-text-color);
            font-size: .74rem;
          }
          .sr-empty {
            color: var(--secondary-text-color);
            padding: 14px 8px 16px;
            text-align: center;
            font-size: .86rem;
          }
          @media (max-width: 420px) {
            .sr-now {
              grid-template-columns: 78px minmax(0, 1fr);
            }
            .sr-art {
              width: 78px;
              height: 78px;
              border-radius: 12px;
            }
            .sr-controls {
              grid-template-columns: 42px 50px 42px minmax(0, 1fr);
            }
          }
        </style>
        <div class="sr-shell">
          <div class="sr-now">
            <div class="sr-art">SR</div>
            <div class="sr-main">
              <div class="sr-topline">
                <span class="sr-status"><span class="sr-dot"></span><span class="sr-status-text">${statusText}</span></span>
                <span class="sr-volume-chip">${safeVolume}%</span>
              </div>
              <div class="sr-station">${this.escape(stationName)}</div>
              <div class="sr-title">${this.escape(title || (isPlaying ? "Nincs metadata" : "Lejátszás szünetel"))}</div>
              <div class="sr-detail">${detailText ? this.escape(detailText) : "&nbsp;"}</div>
            </div>
          </div>

          <div class="sr-controls">
            <button class="sr-icon-button prev" type="button" title="Előző állomás"><ha-icon icon="mdi:skip-previous"></ha-icon></button>
            <button class="sr-icon-button play" type="button" title="Lejátszás / stop"><ha-icon icon="${isPlaying ? "mdi:stop" : "mdi:play"}"></ha-icon></button>
            <button class="sr-icon-button next" type="button" title="Következő állomás"><ha-icon icon="mdi:skip-next"></ha-icon></button>
            <div class="sr-volume">
              <div class="sr-volume-label"><span>Hangerő</span><span class="sr-volume-percent">${safeVolume}%</span></div>
              <input class="volume" type="range" min="0" max="100" step="1" value="${safeVolume}">
            </div>
          </div>

          ${this.renderStationPicker(stations.length, currentStationId)}
        </div>
      </ha-card>
    `;

    this.querySelector(".sr-picker-toggle")?.addEventListener("click", () => {
      this._stationOpen = !this._stationOpen;
      this.render();
    });

    const search = this.querySelector(".sr-search");
    if (search) {
      search.addEventListener("input", (event) => {
        this._stationFilter = event.target.value;
        this.updateStationList();
      });
    }

    this.querySelector(".prev")?.addEventListener("click", () => {
      if (this.config.previous_button_entity) {
        this.pressButton(this.config.previous_button_entity);
      } else {
        this.publishCommand("prev");
      }
    });

    this.querySelector(".next")?.addEventListener("click", () => {
      if (this.config.next_button_entity) {
        this.pressButton(this.config.next_button_entity);
      } else {
        this.publishCommand("next");
      }
    });

    this.querySelector(".play")?.addEventListener("click", () => {
      this.call("switch", "toggle", { entity_id: this.config.playback_entity });
    });

    this.querySelector(".volume")?.addEventListener("change", (event) => {
      this.call("number", "set_value", {
        entity_id: this.config.volume_entity,
        value: Number(event.target.value)
      });
    });

    this.attachStationRowHandlers();
    this.updateArtwork();
    this.restoreInteractiveState(interactiveState);
    this._rendered = true;
  }
}

if (!customElements.get("simple-radio-card")) {
  customElements.define("simple-radio-card", SimpleRadioCard);
}

class SimpleRadioCardV2 extends SimpleRadioCard {}

if (!customElements.get("simple-radio-card-v2")) {
  customElements.define("simple-radio-card-v2", SimpleRadioCardV2);
}

window.customCards = window.customCards || [];

if (!window.customCards.some((card) => card.type === "simple-radio-card")) {
  window.customCards.push({
    type: "simple-radio-card",
    name: "SimpleRadio Card",
    description: "SimpleRadio MQTT dashboard card with artwork, controls and station picker"
  });
}

if (!window.customCards.some((card) => card.type === "simple-radio-card-v2")) {
  window.customCards.push({
    type: "simple-radio-card-v2",
    name: "SimpleRadio Card v2",
    description: "SimpleRadio MQTT dashboard card with artwork, controls and station picker"
  });
}
