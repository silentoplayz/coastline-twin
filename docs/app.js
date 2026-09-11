(() => {
  const $ = (id) => document.getElementById(id);
  const BASE = new URL("./", location.href).href;
  const RUNS_KEY = "coastline-twin-runs";
  const SETTINGS_KEY = "coastline-twin";
  const LAND = [217, 201, 163], WATER = [158, 202, 225], RED = [214, 39, 40];

  const state = {
    home: null, center: null, centerMode: "home", bbox: null,
    previewTimer: null, previewSeq: 0, template: null,
    run: null, running: false, cancelled: false,
    selected: null, matches: [], markers: new Map(),
  };

  class Pool {
    constructor(n) {
      this.workers = [];
      this.next = 1;
      this.waiting = new Map();
      for (let i = 0; i < n; i++) {
        const w = new Worker("engine.js");
        w.onmessage = (ev) => {
          const cb = this.waiting.get(ev.data.id);
          if (!cb) return;
          this.waiting.delete(ev.data.id);
          ev.data.ok ? cb.resolve(ev.data) : cb.reject(new Error(ev.data.error));
        };
        w.onerror = (ev) => toast(`Worker error: ${ev.message}`);
        this.workers.push(w);
      }
    }
    call(i, msg) {
      const id = this.next++;
      return new Promise((resolve, reject) => {
        this.waiting.set(id, { resolve, reject });
        this.workers[i].postMessage({ ...msg, id });
      });
    }
    destroy() {
      for (const w of this.workers) w.terminate();
      for (const cb of this.waiting.values()) cb.reject(new Error("cancelled"));
      this.waiting.clear();
      this.workers = [];
    }
  }

  let pool = null;
  let poolReady = null;
  function workerCount() {
    const asked = Number($("workers").value);
    if (asked > 0) return Math.min(32, asked);
    return Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  }
  async function ensurePool(n) {
    if (pool && pool.workers.length === n) return poolReady;
    if (pool) pool.destroy();
    pool = new Pool(n);
    poolReady = Promise.all(pool.workers.map((_, i) => pool.call(i, { type: "init", base: BASE })));
    return poolReady;
  }

  const STYLES = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
  const BASEMAPS = {
    auto: { name: "Match the theme" },
    positron: { name: "Light", style: "https://tiles.openfreemap.org/styles/positron" },
    dark: { name: "Dark", style: "https://tiles.openfreemap.org/styles/dark" },
    liberty: { name: "Streets", style: "https://tiles.openfreemap.org/styles/liberty" },
    bright: { name: "Bright", style: "https://tiles.openfreemap.org/styles/bright" },
    fiord: { name: "Fiord", style: "https://tiles.openfreemap.org/styles/fiord" },
    topo: { name: "Topographic", raster: { tiles: ["https://a.tile.opentopomap.org/{z}/{x}/{y}.png", "https://b.tile.opentopomap.org/{z}/{x}/{y}.png", "https://c.tile.opentopomap.org/{z}/{x}/{y}.png"], maxzoom: 17, attribution: 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM · Style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' } },
    satellite: { name: "Satellite", raster: { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], maxzoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community" } },
  };
  const DEM = { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, maxzoom: 15, attribution: "Elevation: Mapzen Terrain Tiles on AWS" };
  const LAYERS_KEY = "coastline-twin-layers";
  const layerPrefs = { basemap: "auto", hillshade: false, terrain: false, mask: false };
  try { Object.assign(layerPrefs, JSON.parse(localStorage.getItem(LAYERS_KEY) || "{}")); } catch (e) {}
  if (!BASEMAPS[layerPrefs.basemap]) layerPrefs.basemap = "auto";
  function saveLayerPrefs() { try { localStorage.setItem(LAYERS_KEY, JSON.stringify(layerPrefs)); } catch (e) {} }
  function rasterStyle(r) {
    return { version: 8, sources: { basemap: { type: "raster", tiles: r.tiles, tileSize: 256, maxzoom: r.maxzoom, attribution: r.attribution } }, layers: [{ id: "basemap", type: "raster", source: "basemap" }] };
  }
  function styleKey(scheme) { return layerPrefs.basemap === "auto" ? `auto:${scheme}` : layerPrefs.basemap; }
  function styleFor(scheme) {
    const b = BASEMAPS[layerPrefs.basemap];
    if (!b || !b.style && !b.raster) return STYLES[scheme];
    return b.style || rasterStyle(b.raster);
  }
  const overlays = {
    "home-square": { type: "FeatureCollection", features: [] },
    "bbox": { type: "FeatureCollection", features: [] },
    "match-squares": { type: "FeatureCollection", features: [] },
  };
  const webgl = (() => {
    try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch (e) { return false; }
  })();
  const noop = () => undefined;
  const nullMap = new Proxy({}, { get: (_, key) => (key === "getSource" || key === "getLayer" ? noop : key === "getBounds" ? () => null : key === "getZoom" ? () => 2 : key === "getContainer" ? () => $("map") : noop) });
  const map = webgl ? new maplibregl.Map({
    container: "map", style: styleFor(currentScheme()), center: [-20, 30], zoom: 1.6,
    attributionControl: { compact: true }, canvasContextAttributes: { antialias: true },
  }) : nullMap;
  if (!webgl) {
    $("map").innerHTML = '<div class="preview-empty" style="padding:40px">This browser has no WebGL, so the map cannot be drawn. Searching still works: type an address or coordinates on the left.</div>';
    $("map-hint").hidden = true;
  }
  if (webgl) map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-left");
  if (webgl && maplibregl.GlobeControl) map.addControl(new maplibregl.GlobeControl(), "top-left");
  map.on("style.load", () => {
    map.setProjection({ type: "globe" });
    const firstSymbol = (map.getStyle().layers.find((l) => l.type === "symbol") || {}).id;
    if (!map.getSource("dem")) map.addSource("dem", DEM);
    if (!map.getLayer("hillshade")) map.addLayer({ id: "hillshade", type: "hillshade", source: "dem", layout: { visibility: layerPrefs.hillshade ? "visible" : "none" }, paint: { "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#1b1b1b", "hillshade-highlight-color": "#ffffff" } }, firstSymbol);
    if (!map.getSource("mask")) map.addSource("mask", { type: "image", url: BLANK_PNG, coordinates: [[-1, 1], [1, 1], [1, -1], [-1, -1]] });
    if (!map.getLayer("mask")) map.addLayer({ id: "mask", type: "raster", source: "mask", layout: { visibility: layerPrefs.mask ? "visible" : "none" }, paint: { "raster-opacity": 0.55, "raster-resampling": "nearest", "raster-fade-duration": 0 } }, firstSymbol);
    map.setTerrain(layerPrefs.terrain ? { source: "dem", exaggeration: 1.2 } : null);
    if (layerPrefs.mask) refreshMask();
    for (const [id, paint] of [
      ["home-square", { "line-color": "#d62728", "line-width": 2, "line-dasharray": [3, 2] }],
      ["bbox", { "line-color": "#1f77b4", "line-width": 1, "line-dasharray": [1, 3] }],
      ["match-squares", { "line-color": "#d62728", "line-width": 1.5, "line-opacity": 0.85 }],
    ]) {
      if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: overlays[id] });
      if (!map.getLayer(id)) map.addLayer({ id, type: "line", source: id, paint });
    }
    if (!map.getLayer("bbox-fill")) map.addLayer({ id: "bbox-fill", type: "fill", source: "bbox", paint: { "fill-color": "#1f77b4", "fill-opacity": 0.05 } }, "bbox");
  });
  async function fetchMaskImage(req) {
    await ensurePool(workerCount());
    const res = await pool.call(0, { type: "raster", ...req });
    const canvas = document.createElement("canvas");
    canvas.width = req.width;
    canvas.height = req.height;
    canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(res.pixels), req.width, req.height), 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return URL.createObjectURL(blob);
  }
  const BLANK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  let maskTimer = null, maskSeq = 0, maskUrl = null;
  async function refreshMask() {
    if (!layerPrefs.mask || !webgl) return;
    const b = map.getBounds();
    if (!b) return;
    const w = Math.max(-180, b.getWest()), e = Math.min(180, b.getEast()), s = Math.max(-85, b.getSouth()), n = Math.min(85, b.getNorth());
    if (e <= w || n <= s) return;
    const width = 768;
    const height = Math.min(1024, Math.max(64, Math.round(width * (mercY(n) - mercY(s)) / ((e - w) * Math.PI / 180))));
    const seq = ++maskSeq;
    try {
      const url = await fetchMaskImage({ w, s, e, n, width, height });
      if (seq !== maskSeq) { if (url.startsWith("blob:")) URL.revokeObjectURL(url); return; }
      const src = map.getSource("mask");
      if (src) src.updateImage({ url, coordinates: [[w, n], [e, n], [e, s], [w, s]] });
      if (maskUrl && maskUrl.startsWith("blob:")) URL.revokeObjectURL(maskUrl);
      maskUrl = url;
    } catch (err) {
      toast(`Land mask overlay failed: ${err.message}`);
    }
  }
  map.on("moveend", () => { clearTimeout(maskTimer); maskTimer = setTimeout(refreshMask, 250); });
  function applyLayerPrefs() {
    saveLayerPrefs();
    if (!webgl) return;
    if (map.getLayer("hillshade")) map.setLayoutProperty("hillshade", "visibility", layerPrefs.hillshade ? "visible" : "none");
    if (map.getLayer("mask")) map.setLayoutProperty("mask", "visibility", layerPrefs.mask ? "visible" : "none");
    if (map.getSource("dem")) map.setTerrain(layerPrefs.terrain ? { source: "dem", exaggeration: 1.2 } : null);
    if (layerPrefs.mask) refreshMask();
    applyTiles();
  }
  function buildLayersPanel() {
    const group = $("basemap-options");
    if (!group) return;
    group.innerHTML = "";
    for (const [key, b] of Object.entries(BASEMAPS)) {
      const label = document.createElement("label");
      label.innerHTML = `<input type="radio" name="basemap" value="${key}"> ${b.name}`;
      label.querySelector("input").checked = layerPrefs.basemap === key;
      label.querySelector("input").addEventListener("change", () => { layerPrefs.basemap = key; applyLayerPrefs(); });
      group.appendChild(label);
    }
    for (const [id, key] of [["layer-hillshade", "hillshade"], ["layer-terrain", "terrain"], ["layer-mask", "mask"]]) {
      const el = $(id);
      el.checked = !!layerPrefs[key];
      el.addEventListener("change", () => { layerPrefs[key] = el.checked; applyLayerPrefs(); });
    }
    const button = $("layers-button"), panel = $("layers-panel");
    button.addEventListener("click", (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; button.setAttribute("aria-expanded", String(!panel.hidden)); });
    panel.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => { panel.hidden = true; button.setAttribute("aria-expanded", "false"); });
  }
  buildLayersPanel();
  function setOverlay(id, features) {
    overlays[id] = { type: "FeatureCollection", features };
    const src = map.getSource(id);
    if (src) src.setData(overlays[id]);
  }
  function makePin(className, { draggable = false, text = "" } = {}) {
    const el = document.createElement("div");
    el.className = className;
    if (text) el.textContent = text;
    el.addEventListener("click", (e) => e.stopPropagation());
    if (!webgl) return new Proxy({ getElement: () => el }, { get: (t, key) => (key in t ? t[key] : key === "getLngLat" ? () => ({ lat: 0, lng: 0 }) : key === "getPopup" ? () => ({ isOpen: () => true }) : (...a) => (key === "setLngLat" || key === "addTo" || key === "setPopup" ? proxySelf : undefined)) });
    return new maplibregl.Marker({ element: el, draggable });
  }
  let proxySelf = null;
  const homeMarker = makePin("pin-home", { draggable: true });
  const centerMarker = makePin("pin-center", { draggable: true });
  let homeOnMap = false, centerOnMap = false;
  const resultMarkers = [];
  window.__coastlineTwin = { map, reverseGeocode: (...a) => reverseGeocode(...a) };
  function ringOf(corners) { return corners.map(([lat, lon]) => [lon, lat]).concat([[corners[0][1], corners[0][0]]]); }
  function polygonFeature(ring, props = {}) { return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: props }; }
  function boundsOf(points) {
    const b = new maplibregl.LngLatBounds();
    for (const [lon, lat] of points) b.extend([lon, lat]);
    return b;
  }

  function currentScheme() {
    const cls = document.documentElement.classList;
    if (cls.contains("theme-dark")) return "dark";
    if (cls.contains("theme-light")) return "light";
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function applyTiles() {
    const scheme = currentScheme();
    document.documentElement.classList.toggle("map-dark", scheme === "dark");
    const key = styleKey(scheme);
    if (map.__styleKey !== key) { map.__styleKey = key; map.setStyle(styleFor(scheme)); }
    for (const cm of [compare.home, compare.match]) if (cm && cm.__styleKey !== key) { cm.__styleKey = key; cm.setStyle(styleFor(scheme)); }
  }
  function setScheme(scheme) {
    const root = document.documentElement;
    root.classList.remove("theme-light", "theme-dark");
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (scheme) {
      root.classList.add("theme-" + scheme);
      meta.content = scheme;
      try { localStorage.setItem("color-scheme", scheme); } catch (e) {}
    } else {
      meta.content = "light dark";
      try { localStorage.removeItem("color-scheme"); } catch (e) {}
    }
    applyTiles();
  }
  $("theme-toggle").addEventListener("click", () => setScheme(currentScheme() === "dark" ? "light" : "dark"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTiles);
  map.__styleKey = styleKey(currentScheme());

  let toastTimer = null;
  function toast(msg, ms = 3500) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }
  const fmt = (v, d = 4) => Number(v).toFixed(d);
  const fmtCoords = (lat, lon) => `${fmt(lat)}, ${fmt(lon)}`;
  function fmtDuration(s) {
    if (s == null || !isFinite(s)) return "";
    s = Math.round(s);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  }
  function timeAgo(ts) {
    const d = (Date.now() - ts) / 1000;
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.floor(d / 60)} min ago`;
    if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchJson(url, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }
  function photonName(props) {
    const street = [props.housenumber, props.street].filter(Boolean).join(" ");
    const parts = [];
    for (const key of ["name", "street", "district", "city", "county", "state", "postcode", "country"]) {
      const v = key === "street" ? street : props[key];
      if (v && !parts.includes(v)) parts.push(v);
    }
    return parts.join(", ");
  }
  async function geocode(q) {
    try {
      const data = await fetchJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6`);
      return (data.features || []).map((f) => ({
        lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
        name: photonName(f.properties || {}), type: (f.properties || {}).osm_value || "",
      }));
    } catch (e) {}
    const rows = await fetchJson(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=6`);
    return rows.map((r) => ({ lat: Number(r.lat), lon: Number(r.lon), name: r.display_name, type: r.type }));
  }
  function placeName(props) {
    const parts = [props.name, props.city && props.city !== props.name ? props.city : null, props.state || props.county, props.countrycode].filter(Boolean);
    return parts.join(", ");
  }
  async function reverseGeocode(lat, lon, { fine = false } = {}) {
    if (fine) {
      try {
        const data = await fetchJson(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}`);
        const f = (data.features || [])[0];
        if (f) return photonName(f.properties || {});
      } catch (e) {}
    }
    for (const radius of [30, 200]) {
      try {
        const data = await fetchJson(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&radius=${radius}&osm_tag=place&limit=1`);
        const f = (data.features || [])[0];
        if (f && f.properties && f.properties.name) return placeName(f.properties);
      } catch (e) {}
    }
    try {
      const r = await fetchJson(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=8`);
      if (r && r.display_name) return r.display_name;
    } catch (e) {}
    return "";
  }
  function squareCorners(lat, lon, sideKm) {
    const h = sideKm * 500;
    const frame = makeFrame(lat, lon);
    return [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => toLatLon(frame, x, y));
  }
  function fmtKm(km) {
    return `${Math.round(km).toLocaleString()} km`;
  }
  function permalink() {
    const u = new URL(location.href);
    u.search = "";
    if (state.home) {
      u.searchParams.set("lat", state.home.lat.toFixed(4));
      u.searchParams.set("lon", state.home.lon.toFixed(4));
      u.searchParams.set("side", $("side-km").value);
      if (state.centerMode === "custom" && state.center) {
        u.searchParams.set("clat", state.center.lat.toFixed(4));
        u.searchParams.set("clon", state.center.lon.toFixed(4));
      }
    }
    return u.toString();
  }
  function syncUrl() {
    try { history.replaceState(null, "", permalink()); } catch (e) {}
  }
  $("copy-link").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(permalink());
      toast("Link copied");
    } catch (e) {
      prompt("Copy this link", permalink());
    }
  });
  function effectiveCenter() { return state.centerMode === "custom" && state.center ? state.center : state.home; }
  function saveSettings() {
    syncUrl();
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        home: state.home, center: state.center, centerMode: state.centerMode,
        side: $("side-km").value, address: $("address").value,
      }));
    } catch (e) {}
  }
  function drawSquare() {
    const c = effectiveCenter();
    if (!c) return;
    setOverlay("home-square", [polygonFeature(ringOf(squareCorners(c.lat, c.lon, Number($("side-km").value))))]);
    if (state.centerMode === "custom") {
      centerMarker.setLngLat([c.lon, c.lat]);
      if (!centerOnMap) { centerMarker.addTo(map); centerOnMap = true; }
    } else if (centerOnMap) {
      centerMarker.remove();
      centerOnMap = false;
    }
  }

  let reverseTimer = null;
  function setHome(lat, lon, { pan = false, address = null } = {}) {
    lat = Math.max(-90, Math.min(90, lat));
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    state.home = { lat, lon };
    $("home-lat").value = fmt(lat);
    $("home-lon").value = fmt(lon);
    homeMarker.setLngLat([lon, lat]);
    if (!homeOnMap) { homeMarker.addTo(map); homeOnMap = true; }
    if (pan) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 8), duration: 900 });
    $("map-hint").classList.add("faded");
    if (address) {
      $("home-address").textContent = address;
    } else {
      $("home-address").textContent = "Looking up address…";
      clearTimeout(reverseTimer);
      reverseTimer = setTimeout(async () => {
        const name = await reverseGeocode(lat, lon, { fine: true });
        $("home-address").textContent = name || "No address found here";
      }, 400);
    }
    if (state.centerMode !== "custom" || !state.center) state.center = { lat, lon };
    drawSquare();
    schedulePreview();
    $("run-button").disabled = state.running;
    saveSettings();
  }
  homeMarker.on("dragend", () => { const p = homeMarker.getLngLat(); setHome(p.lat, p.lng); });
  centerMarker.on("drag", () => { const p = centerMarker.getLngLat(); state.center = { lat: p.lat, lon: p.lng }; drawSquare(); });
  centerMarker.on("dragend", () => { schedulePreview(); saveSettings(); });
  map.on("click", (e) => setHome(e.lngLat.lat, e.lngLat.lng));
  $("home-lat").addEventListener("change", () => setHome(Number($("home-lat").value), Number($("home-lon").value || 0), { pan: true }));
  $("home-lon").addEventListener("change", () => setHome(Number($("home-lat").value || 0), Number($("home-lon").value), { pan: true }));
  document.querySelectorAll('input[name="center-mode"]').forEach((r) => r.addEventListener("change", () => {
    state.centerMode = r.value;
    if (state.centerMode === "custom" && state.home && !state.center) state.center = { ...state.home };
    drawSquare(); schedulePreview(); saveSettings();
  }));
  $("side-km").addEventListener("input", () => { $("side-out").textContent = $("side-km").value; drawSquare(); schedulePreview(); saveSettings(); });
  $("detail-weight").addEventListener("input", () => { $("detail-out").textContent = $("detail-weight").value; });
  for (const id of ["rot-max", "flip", "quality"]) $(id).addEventListener("change", schedulePreview);
  document.querySelectorAll('input[name="scale"]').forEach((c) => c.addEventListener("change", schedulePreview));

  const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/;
  const suggestState = { timer: null, ctrl: null, rows: [], query: "" };
  function pickRow(r) {
    $("geocode-results").hidden = true;
    $("address").value = r.name;
    setHome(r.lat, r.lon, { pan: true, address: r.name });
  }
  function showSuggestions(rows, query) {
    const list = $("geocode-results");
    list.innerHTML = "";
    suggestState.rows = rows;
    suggestState.query = query;
    if (!rows.length) { list.hidden = true; return; }
    rows.forEach((r, i) => {
      const li = document.createElement("li");
      li.tabIndex = 0;
      li.setAttribute("role", "option");
      li.innerHTML = `<div>${escapeHtml(r.name)}</div><div class="type">${escapeHtml(r.type)}</div>`;
      li.addEventListener("click", () => pickRow(r));
      li.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); pickRow(r); }
        else if (ev.key === "ArrowDown") { ev.preventDefault(); (li.nextElementSibling || li).focus(); }
        else if (ev.key === "ArrowUp") { ev.preventDefault(); if (i === 0) $("address").focus(); else li.previousElementSibling.focus(); }
        else if (ev.key === "Escape") { list.hidden = true; $("address").focus(); }
      });
      list.appendChild(li);
    });
    list.hidden = false;
  }
  async function suggest(q) {
    if (suggestState.ctrl) suggestState.ctrl.abort();
    const ctrl = new AbortController();
    suggestState.ctrl = ctrl;
    try {
      const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5`, { signal: ctrl.signal });
      if (!res.ok) return;
      const data = await res.json();
      if (ctrl.signal.aborted || $("address").value.trim() !== q) return;
      showSuggestions((data.features || []).map((f) => ({
        lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
        name: photonName(f.properties || {}), type: (f.properties || {}).osm_value || "",
      })), q);
    } catch (e) {}
  }
  $("address").addEventListener("input", () => {
    const q = $("address").value.trim();
    clearTimeout(suggestState.timer);
    if (q.length < 3 || COORD_RE.test(q)) { $("geocode-results").hidden = true; suggestState.rows = []; return; }
    suggestState.timer = setTimeout(() => suggest(q), 350);
  });
  $("address").addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" && !$("geocode-results").hidden) { ev.preventDefault(); $("geocode-results").firstElementChild?.focus(); }
    else if (ev.key === "Escape") { $("geocode-results").hidden = true; }
  });
  document.addEventListener("click", (ev) => { if (!ev.target.closest(".search-row, .suggestions")) $("geocode-results").hidden = true; });
  $("search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("address").value.trim();
    clearTimeout(suggestState.timer);
    if (!q) return;
    const m = q.match(COORD_RE);
    if (m) { $("geocode-results").hidden = true; setHome(Number(m[1]), Number(m[2]), { pan: true }); return; }
    if (!$("geocode-results").hidden && suggestState.rows.length && suggestState.query === q) { pickRow(suggestState.rows[0]); return; }
    $("search-button").disabled = true;
    try {
      const rows = await geocode(q);
      if (!rows.length) { toast("Nothing found for that search"); return; }
      if (rows.length === 1) { pickRow(rows[0]); return; }
      showSuggestions(rows, q);
    } catch (err) {
      toast(`Search failed: ${err.message}`);
    } finally {
      $("search-button").disabled = false;
    }
  });

  function rotationList(rotMax, rotStep) {
    const out = [];
    if (rotMax >= 180) { for (let t = 0; t < 360; t += rotStep) out.push(t); return out; }
    for (let t = -rotMax; t <= rotMax + 1e-9; t += rotStep) out.push(Math.round(t * 100) / 100);
    return out;
  }
  function footprintExtent(halfM, theta, scale) {
    const c = Math.cos(theta * Math.PI / 180), s = Math.sin(theta * Math.PI / 180);
    return halfM * scale * (Math.abs(c) + Math.abs(s));
  }
  function buildParams() {
    const sideKm = Number($("side-km").value);
    const side_m = sideKm * 1000;
    const scales = [...document.querySelectorAll('input[name="scale"]:checked')].map((c) => Number(c.value));
    const rotMax = Number($("rot-max").value);
    const rot_step = rotMax >= 180 ? 20 : 15;
    const thetas = rotationList(rotMax, rot_step);
    const flips = $("flip").checked ? [false, true] : [false];
    const thorough = $("quality").value === "thorough";
    const fine_res = Math.max(1000, side_m / 160);
    const coarse_res = thorough ? Math.max(1000, side_m / 48) : Math.max(2000, side_m / 24);
    const P = thorough ? 1024 : 512;
    const halfM = side_m / 2;
    let mmax = 0, maxExt = 0;
    for (const sc of scales) for (const th of thetas) {
      const ext = footprintExtent(halfM, th, sc);
      maxExt = Math.max(maxExt, ext);
      mmax = Math.max(mmax, Math.ceil(2 * ext / coarse_res));
    }
    const N = P - mmax - 1;
    const halfKm = N * coarse_res / 2000;
    const stepKm = 2 * halfKm - 2 * maxExt / 1000 - 30;
    let stepDeg = Math.max(3, Math.min(40, stepKm / 111.2));
    const rows = Math.ceil(162 / stepDeg);
    stepDeg = 162 / rows;
    const minScore = Number($("min-score").value) || 0.5;
    return {
      home: state.home, center: effectiveCenter(), side_m, side_km: sideKm,
      supersample: 2, band_px: Number($("band-px").value) || 1, detail_weight: Number($("detail-weight").value), variance_floor: 0.3,
      thetas, flips, scales: scales.length ? scales : [1], rot_step,
      min_score: minScore, coarse_min_score: Math.max(0.25, minScore - 0.15),
      nms_px: Math.max(3, Math.round(side_m / coarse_res / 2)), per_tile: 12, refine_per_tile: 5,
      exclude_km: $("exclude-km").value === "" ? 2 * sideKm : Number($("exclude-km").value),
      min_sep_km: sideKm,
      same_hemisphere: $("same-hemisphere").checked,
      lat_band: $("lat-band").value === "" ? null : Number($("lat-band").value),
      bbox: state.bbox, top: Number($("top").value) || 15,
      fine_res, coarse_res, P, N, step_deg: stepDeg, lat_limit: 81,
      quality: thorough ? "thorough" : "fast",
    };
  }
  function makeTiles(p) {
    const tiles = [];
    const rows = Math.round(162 / p.step_deg);
    for (let k = 0; k < rows; k++) {
      const lat = -p.lat_limit + p.step_deg * (k + 0.5);
      const edge = Math.max(Math.abs(lat) - p.step_deg / 2, 0);
      let lonStep = Math.min(360, p.step_deg / Math.cos(edge * Math.PI / 180));
      const count = Math.ceil(360 / lonStep);
      lonStep = 360 / count;
      for (let j = 0; j < count; j++) tiles.push({ lat: Math.round(lat * 1e4) / 1e4, lon: Math.round((-180 + lonStep * (j + 0.5)) * 1e4) / 1e4 });
    }
    return tiles;
  }
  function overlap(a0, a1, b0, b1) { return a0 <= b1 && b0 <= a1; }
  function tileMayContain(t, p) {
    const dlat = (p.N * p.coarse_res / 2) / 111000 + 0.5;
    const lo = t.lat - dlat, hi = t.lat + dlat;
    let absLo, absHi;
    if (lo <= 0 && 0 <= hi) { absLo = 0; absHi = Math.max(Math.abs(lo), Math.abs(hi)); } else { absLo = Math.min(Math.abs(lo), Math.abs(hi)); absHi = Math.max(Math.abs(lo), Math.abs(hi)); }
    if (p.same_hemisphere) {
      if (p.home.lat >= 0 && hi < 0) return false;
      if (p.home.lat < 0 && lo > 0) return false;
    }
    if (p.lat_band != null) {
      const h = Math.abs(p.home.lat);
      if (!overlap(absLo, absHi, h - p.lat_band, h + p.lat_band)) return false;
    }
    if (p.bbox) {
      const [bLatLo, bLonLo, bLatHi, bLonHi] = p.bbox;
      if (!overlap(lo, hi, bLatLo, bLatHi)) return false;
      const near = lo <= 0 && 0 <= hi ? 0 : Math.min(Math.abs(lo), Math.abs(hi));
      const dlon = dlat / Math.max(Math.cos(Math.min(near, 89) * Math.PI / 180), 0.05);
      if (!overlap(t.lon - dlon, t.lon + dlon, bLonLo, bLonHi)) return false;
    }
    return true;
  }
  function tileList(p) { return makeTiles(p).filter((t) => tileMayContain(t, p)); }

  function drawMask(canvas, land, n, dot, overlayLand) {
    canvas.width = n; canvas.height = n;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(n, n);
    for (let k = 0; k < n * n; k++) {
      const c = land[k] ? LAND : WATER;
      img.data[k * 4] = c[0]; img.data[k * 4 + 1] = c[1]; img.data[k * 4 + 2] = c[2]; img.data[k * 4 + 3] = 255;
    }
    if (overlayLand) {
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        const k = r * n + c;
        const edge = (r + 1 < n && overlayLand[k] !== overlayLand[k + n]) || (c + 1 < n && overlayLand[k] !== overlayLand[k + 1])
          || (r > 0 && overlayLand[k] !== overlayLand[k - n]) || (c > 0 && overlayLand[k] !== overlayLand[k - 1]);
        if (edge) { img.data[k * 4] = RED[0]; img.data[k * 4 + 1] = RED[1]; img.data[k * 4 + 2] = RED[2]; }
      }
    }
    ctx.putImageData(img, 0, 0);
    if (dot) {
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(dot[0], dot[1], Math.max(1.6, n / 22), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#d62728";
      ctx.beginPath(); ctx.arc(dot[0], dot[1], Math.max(1.1, n / 30), 0, Math.PI * 2); ctx.fill();
    }
  }
  function dotPixel(t) {
    const half = t.n * t.res / 2;
    return [(t.dot[0] + half) / t.res, (half - t.dot[1]) / t.res];
  }
  function landFrom(s) { return typeof s === "string" ? Uint8Array.from(s, (ch) => (ch === "1" ? 1 : 0)) : Uint8Array.from(s); }

  function schedulePreview() {
    if (!state.home) return;
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(runPreview, 600);
  }
  async function runPreview() {
    if (!state.home || state.running) return;
    const seq = ++state.previewSeq;
    $("preview-empty").hidden = false;
    $("preview-empty").textContent = "Rendering the square…";
    $("preview-warning").hidden = true;
    try {
      await ensurePool(workerCount());
      const p = buildParams();
      const res = await pool.call(0, { type: "prepare", params: { ...p, previewOnly: true } });
      if (seq !== state.previewSeq) return;
      const t = res.template;
      state.template = { n: t.n, res: t.res, land: landFrom(t.land), dot: t.dot, stats: t.stats };
      drawMask($("preview-canvas"), state.template.land, t.n, dotPixel(state.template));
      $("preview-canvas").hidden = false;
      $("preview-empty").hidden = true;
      $("preview-stats").hidden = false;
      $("stat-pixels").textContent = `${t.n}²`;
      $("stat-land").textContent = `${Math.round(t.stats.land_fraction * 100)}%`;
      $("stat-coast").textContent = t.stats.coast_ratio.toFixed(2);
      $("stat-tiles").textContent = tileList(p).length;
      const warnings = [];
      if (t.stats.land_fraction === 0 || t.stats.land_fraction === 1) warnings.push("No coastline in this square. Move the pin or enlarge the square.");
      else if (t.stats.coast_ratio < 0.5) warnings.push("Very little coastline in the square, matches will be loose.");
      if (t.n < 32) warnings.push(`Only ${t.n} pixels across at this size, matches will be coarse.`);
      if (warnings.length) { $("preview-warning").textContent = warnings.join(" "); $("preview-warning").hidden = false; }
      $("run-button").disabled = t.stats.land_fraction === 0 || t.stats.land_fraction === 1;
    } catch (err) {
      if (seq !== state.previewSeq) return;
      $("preview-canvas").hidden = true;
      $("preview-stats").hidden = true;
      $("preview-empty").hidden = false;
      $("preview-empty").textContent = `Preview failed: ${err.message}`;
    }
  }

  $("bbox-set").addEventListener("click", () => {
    const b = map.getBounds();
    if (!b) { toast("The region limit needs the map, which this browser cannot draw."); return; }
    state.bbox = [Math.max(-90, b.getSouth()), Math.max(-180, b.getWest()), Math.min(90, b.getNorth()), Math.min(180, b.getEast())];
    const [s0, w0, n0, e0] = state.bbox;
    setOverlay("bbox", [polygonFeature([[w0, s0], [e0, s0], [e0, n0], [w0, n0], [w0, s0]])]);
    $("bbox-text").textContent = `Only ${fmt(state.bbox[0], 1)}…${fmt(state.bbox[2], 1)} lat, ${fmt(state.bbox[1], 1)}…${fmt(state.bbox[3], 1)} lon`;
    $("bbox-clear").hidden = false;
    schedulePreview();
  });
  $("bbox-clear").addEventListener("click", () => {
    state.bbox = null;
    setOverlay("bbox", []);
    $("bbox-text").textContent = "Whole planet";
    $("bbox-clear").hidden = true;
    schedulePreview();
  });

  function haversineKm(lat1, lon1, lat2, lon2) {
    const d = Math.PI / 180, p1 = lat1 * d, p2 = lat2 * d;
    const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((lon2 - lon1) * d / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
  }
  function merge(cands, p) {
    cands.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const c of cands) {
      if (kept.every((k) => haversineKm(c.center_lat, c.center_lon, k.center_lat, k.center_lon) >= p.min_sep_km)) kept.push(c);
      if (kept.length >= p.top) break;
    }
    kept.forEach((m, i) => { m.rank = i + 1; });
    return kept;
  }

  function setStatus(label, text, pct, { done = false, failed = false, cancellable = false } = {}) {
    const box = $("status");
    box.hidden = false;
    box.classList.toggle("done", done);
    box.classList.toggle("failed", failed);
    $("status-label").textContent = label;
    $("status-text").textContent = text;
    $("status-progress").value = pct;
    $("cancel-button").hidden = !cancellable;
  }

  $("run-button").addEventListener("click", startRun);
  $("cancel-button").addEventListener("click", () => {
    state.cancelled = true;
    if (pool) { pool.destroy(); pool = null; }
    state.running = false;
    setStatus("Cancelled", "", 0, { failed: true });
    $("run-button").disabled = !state.home;
  });

  async function startRun() {
    if (!state.home || state.running) return;
    const p = buildParams();
    const tiles = tileList(p);
    const n = workerCount();
    state.running = true;
    state.cancelled = false;
    $("run-button").disabled = true;
    const t0 = performance.now();
    const label = $("label").value.trim() || `${p.side_km} km at ${fmt(p.home.lat, 3)}, ${fmt(p.home.lon, 3)}`;
    try {
      setStatus("Preparing…", `${tiles.length} tiles on ${n} worker threads`, 0, { cancellable: true });
      await ensurePool(n);
      const prepared = await Promise.all(pool.workers.map((_, i) => pool.call(i, { type: "prepare", params: p })));
      const t = prepared[0].template;
      state.template = { n: t.n, res: t.res, land: landFrom(t.land), dot: t.dot, stats: t.stats };
      let done = 0, next = 0;
      const all = [];
      const runWorker = async (i) => {
        while (next < tiles.length && !state.cancelled) {
          const tile = tiles[next++];
          const res = await pool.call(i, { type: "tile", tile });
          all.push(...res.matches);
          done++;
          const elapsed = (performance.now() - t0) / 1000;
          const eta = done ? (tiles.length - done) * (elapsed / done) : null;
          setStatus(`Searching… ${Math.round(100 * done / tiles.length)}%`,
            `${done} of ${tiles.length} tiles, ${fmtDuration(elapsed)} elapsed${eta != null ? `, about ${fmtDuration(eta)} left` : ""}`,
            100 * done / tiles.length, { cancellable: true });
        }
      };
      await Promise.all(pool.workers.map((_, i) => runWorker(i)));
      if (state.cancelled) return;
      const matches = merge(all, p);
      setStatus("Naming places…", `${matches.length} matches, looking up the nearest places`, 100, { cancellable: false });
      for (const m of matches) {
        if (state.cancelled) return;
        m.place = await reverseGeocode(m.dot_lat, m.dot_lon);
        await sleep(150);
      }
      const seconds = (performance.now() - t0) / 1000;
      const run = {
        id: `${Date.now()}`, label, started: Date.now(), seconds, tiles: tiles.length, raw: all.length,
        params: { home: p.home, center: p.center, side_km: p.side_km, scales: p.scales, thetas: p.thetas, flips: p.flips,
          detail_weight: p.detail_weight, band_px: p.band_px, same_hemisphere: p.same_hemisphere, lat_band: p.lat_band, bbox: p.bbox, quality: p.quality, min_score: p.min_score },
        template: { n: t.n, res: t.res, land: t.land.join(""), dot: t.dot },
        matches: matches.map((m) => ({ ...m, window: m.window.join("") })),
      };
      saveRun(run);
      showRun(run);
      setStatus("Done", `${matches.length} matches from ${tiles.length} tiles in ${fmtDuration(seconds)}`, 100, { done: true });
      toast(`Done: ${matches.length} matches in ${fmtDuration(seconds)}`);
    } catch (err) {
      if (!state.cancelled) { setStatus("Failed", err.message, 0, { failed: true }); toast(err.message); }
    } finally {
      state.running = false;
      $("run-button").disabled = !state.home;
    }
  }

  function loadRuns() {
    try { return JSON.parse(localStorage.getItem(RUNS_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveRun(run) {
    const runs = loadRuns().filter((r) => r.id !== run.id);
    runs.unshift(run);
    while (runs.length) {
      try { localStorage.setItem(RUNS_KEY, JSON.stringify(runs)); break; } catch (e) { runs.pop(); }
    }
    refreshRunsCount();
  }
  function refreshRunsCount() {
    const runs = loadRuns();
    $("runs-count").textContent = runs.length ? String(runs.length) : "";
    return runs;
  }

  function clearResults() {
    for (const mk of resultMarkers) mk.remove();
    resultMarkers.length = 0;
    setOverlay("match-squares", []);
    state.markers.clear();
    state.matches = [];
    state.selected = null;
  }
  const VIEW_KEY = "coastline-twin-view";
  const view = { sort: "score", hideMirrored: false };
  try { Object.assign(view, JSON.parse(localStorage.getItem(VIEW_KEY) || "{}")); } catch (e) {}
  $("sort-by").value = view.sort;
  $("hide-mirrored").checked = view.hideMirrored;
  $("sort-by").addEventListener("change", () => { view.sort = $("sort-by").value; saveView(); renderMatches(); });
  $("hide-mirrored").addEventListener("change", () => { view.hideMirrored = $("hide-mirrored").checked; saveView(); renderMatches(); });
  function saveView() { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch (e) {} }
  function visibleMatches(run) {
    const home = run.params.home;
    const key = {
      score: (m) => -m.score,
      coast: (m) => -m.coast_score,
      mask: (m) => -m.mask_score,
      distance: (m) => haversineKm(home.lat, home.lon, m.dot_lat, m.dot_lon),
      rotation: (m) => Math.abs(m.theta) + (m.flip ? 1000 : 0),
    }[view.sort] || ((m) => -m.score);
    return run.matches.filter((m) => !view.hideMirrored || !m.flip).map((m) => [key(m), m]).sort((a, b) => a[0] - b[0]).map(([, m]) => m);
  }
  function showRun(run) {
    state.run = run;
    $("results").hidden = false;
    $("results-title").textContent = run.label;
    const bits = [`${run.params.side_km} km square`, `${run.tiles} tiles`, fmtDuration(run.seconds)];
    if (run.params.same_hemisphere) bits.push("same hemisphere");
    if (run.params.lat_band != null) bits.push(`±${run.params.lat_band}° latitude`);
    if (run.params.bbox) bits.push("region limited");
    $("results-meta").textContent = bits.join(" · ");
    const t = run.template ? { n: run.template.n, res: run.template.res, land: landFrom(run.template.land), dot: run.template.dot } : { n: 0, res: 1, land: null, dot: [0, 0] };
    renderMatches();
    switchTab("matches");
    renderFiles(run, t);
  }
  function renderMatches() {
    const run = state.run;
    if (!run) return;
    clearResults();
    const t = run.template ? { n: run.template.n, res: run.template.res, land: landFrom(run.template.land), dot: run.template.dot } : { n: 0, res: 1, land: null, dot: [0, 0] };
    const dot = t.land ? dotPixel(t) : null;
    const matches = visibleMatches(run);
    state.matches = matches;
    $("results-count").textContent = matches.length === run.matches.length ? `${matches.length} matches` : `${matches.length} of ${run.matches.length} matches`;
    const list = $("match-list");
    list.innerHTML = "";
    const sheet = $("sheet");
    sheet.innerHTML = "";
    const bounds = [];
    const squares = [];
    matches.forEach((m, index) => {
      const place = m.place || fmtCoords(m.dot_lat, m.dot_lon);
      const flip = m.flip ? ", mirrored" : "";
      const distance = fmtKm(haversineKm(run.params.home.lat, run.params.home.lon, m.dot_lat, m.dot_lon));
      const osm = `https://www.openstreetmap.org/?mlat=${m.dot_lat.toFixed(5)}&mlon=${m.dot_lon.toFixed(5)}#map=11/${m.dot_lat.toFixed(5)}/${m.dot_lon.toFixed(5)}`;
      const gm = `https://www.google.com/maps/search/?api=1&query=${m.dot_lat.toFixed(5)},${m.dot_lon.toFixed(5)}`;
      const li = document.createElement("li");
      li.className = "match";
      li.innerHTML = `
        <div class="rank">${m.rank}</div>
        <div class="place">${escapeHtml(place)}</div>
        <div class="score">${m.score.toFixed(3)}</div>
        <div class="detail">rotated ${m.theta > 0 ? "+" : ""}${Math.round(m.theta)}°${flip}, ${m.side_km.toFixed(0)} km square · ${distance} from home · dot at ${fmtCoords(m.dot_lat, m.dot_lon)}</div>
        <div class="bars"><span>mask</span><div class="bar"><i style="width:${Math.max(0, m.mask_score) * 100}%"></i></div><span>coast</span><div class="bar"><i style="width:${Math.max(0, m.coast_score) * 100}%"></i></div></div>
        <div class="strip"><div><canvas></canvas><span>home</span></div><div><canvas></canvas><span>match</span></div><div><canvas></canvas><span>overlay</span></div></div>
        <div class="links"><a href="${osm}" target="_blank" rel="noopener">OpenStreetMap</a><a href="${gm}" target="_blank" rel="noopener">Google Maps</a><button type="button" class="ghost small" data-why="${m.rank}">Why?</button><button type="button" class="small" data-compare="${m.rank}">Compare</button></div>`;
      const win = t.land && m.window ? landFrom(m.window) : null;
      const cv = li.querySelectorAll("canvas");
      if (win) {
        drawMask(cv[0], t.land, t.n, dot);
        drawMask(cv[1], win, t.n, dot);
        drawMask(cv[2], win, t.n, dot, t.land);
      } else {
        li.querySelector(".strip").hidden = true;
      }
      li.addEventListener("click", (e) => { if (e.target.tagName !== "A" && e.target.tagName !== "BUTTON") selectMatch(m.rank, true); });
      li.querySelector("[data-compare]").addEventListener("click", () => openCompare(run, index));
      li.querySelector("[data-why]").addEventListener("click", () => openWhy(run, index));
      list.appendChild(li);

      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<div class="title">#${m.rank} ${escapeHtml(place)} · ${m.score.toFixed(3)}</div><div class="muted small">rotated ${m.theta > 0 ? "+" : ""}${Math.round(m.theta)}°${flip}, ${m.side_km.toFixed(0)} km square · <a href="#" data-compare>compare on the map</a></div>
        <div class="strip"><div><canvas></canvas><span>home</span></div><div><canvas></canvas><span>match</span></div><div><canvas></canvas><span>overlay</span></div></div>`;
      const cs = row.querySelectorAll("canvas");
      if (win) {
        drawMask(cs[0], t.land, t.n, dot);
        drawMask(cs[1], win, t.n, dot);
        drawMask(cs[2], win, t.n, dot, t.land);
      } else {
        row.querySelector(".strip").hidden = true;
      }
      row.querySelector("[data-compare]").addEventListener("click", (e) => { e.preventDefault(); openCompare(run, index); });
      sheet.appendChild(row);

      const marker = makePin("pin-match", { text: String(m.rank) });
      marker.getElement().title = place;
      marker.setPopup(new maplibregl.Popup({ offset: 16, closeButton: false }).setHTML(`<b>#${m.rank} ${escapeHtml(place)}</b><br>score ${m.score.toFixed(3)}<br>${fmtCoords(m.dot_lat, m.dot_lon)}`));
      marker.getElement().addEventListener("click", () => selectMatch(m.rank, false));
      marker.setLngLat([m.dot_lon, m.dot_lat]).addTo(map);
      resultMarkers.push(marker);
      squares.push(polygonFeature(m.square, { rank: m.rank }));
      state.markers.set(m.rank, { marker, square: m.square, li });
      bounds.push([m.dot_lon, m.dot_lat]);
    });
    setOverlay("match-squares", squares);
    if (run.params.home) bounds.push([run.params.home.lon, run.params.home.lat]);
    requestAnimationFrame(() => {
      map.resize();
      if (bounds.length) map.fitBounds(boundsOf(bounds), { padding: 50, maxZoom: 6, duration: 900 });
    });
  }

  function download(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function renderFiles(run, t) {
    const list = $("file-list");
    list.innerHTML = "";
    const items = [
      ["Matches (JSON)", "coastline-twin-matches.json", () => {
        const matches = run.matches.map(({ window, ...m }) => m);
        return new Blob([JSON.stringify({ meta: { ...run.params, seconds: run.seconds, tiles: run.tiles }, matches }, null, 2)], { type: "application/json" });
      }],
      ["Matches (GeoJSON)", "coastline-twin-matches.geojson", () => {
        const features = [{ type: "Feature", geometry: { type: "Point", coordinates: [run.params.home.lon, run.params.home.lat] }, properties: { kind: "home" } }];
        for (const m of run.matches) {
          const { window, square, ...props } = m;
          features.push({ type: "Feature", geometry: { type: "Point", coordinates: [m.dot_lon, m.dot_lat] }, properties: { kind: "dot", ...props } });
          features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [square] }, properties: { kind: "square", rank: m.rank, score: m.score } });
        }
        return new Blob([JSON.stringify({ type: "FeatureCollection", features })], { type: "application/geo+json" });
      }],
      ["Contact sheet (PNG)", "coastline-twin-sheet.png", () => sheetBlob(run, t)],
    ];
    for (const [label, name, make] of items) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = label;
      a.addEventListener("click", async (e) => { e.preventDefault(); download(name, await make()); });
      li.appendChild(a);
      list.appendChild(li);
    }
  }
  async function sheetBlob(run, t) {
    const size = 220, pad = 12, rowH = size + 44;
    const canvas = document.createElement("canvas");
    canvas.width = 3 * size + 4 * pad;
    canvas.height = run.matches.length * rowH + pad;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    const tmp = document.createElement("canvas");
    const dot = dotPixel(t);
    run.matches.forEach((m, i) => {
      const win = landFrom(m.window);
      const y = pad + i * rowH;
      ctx.fillStyle = "#222";
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.fillText(`#${m.rank}  ${m.place || fmtCoords(m.dot_lat, m.dot_lon)}  score ${m.score.toFixed(3)}`, pad, y + 16);
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = "#666";
      ctx.fillText(`rotated ${m.theta > 0 ? "+" : ""}${Math.round(m.theta)}°${m.flip ? ", mirrored" : ""}, ${m.side_km.toFixed(0)} km square, dot at ${fmtCoords(m.dot_lat, m.dot_lon)}`, pad, y + 32);
      [[t.land, null], [win, null], [win, t.land]].forEach(([land, overlay], j) => {
        drawMask(tmp, land, t.n, dot, overlay);
        ctx.drawImage(tmp, pad + j * (size + pad), y + 40, size, size);
      });
    });
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  function selectMatch(rank, fly) {
    if (state.selected && state.markers.has(state.selected)) {
      const prev = state.markers.get(state.selected);
      prev.li.classList.remove("selected");
      prev.marker.getElement()?.classList.remove("selected");
    }
    state.selected = rank;
    const cur = state.markers.get(rank);
    if (!cur) return;
    cur.li.classList.add("selected");
    cur.marker.getElement()?.classList.add("selected");
    cur.li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (fly) {
      map.fitBounds(boundsOf(cur.square), { padding: 90, maxZoom: 11, duration: 900 });
      if (!cur.marker.getPopup().isOpen()) cur.marker.togglePopup();
    }
  }
  document.querySelectorAll(".tabs [role=tab]").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  function switchTab(name) {
    document.querySelectorAll(".tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    for (const page of ["matches", "sheet", "files"]) $(`tab-${page}`).hidden = page !== name;
  }
  $("results-close").addEventListener("click", () => { $("results").hidden = true; clearResults(); requestAnimationFrame(() => map.resize()); });

  function bandOf(binary, n, width) {
    const coast = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const k = r * n + c;
      if (r + 1 < n && binary[k] !== binary[k + n]) { coast[k] = 1; coast[k + n] = 1; }
      if (c + 1 < n && binary[k] !== binary[k + 1]) { coast[k] = 1; coast[k + 1] = 1; }
    }
    let cur = coast;
    for (let w = 0; w < width; w++) {
      const next = new Uint8Array(cur);
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        if (!cur[r * n + c]) continue;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < n && cc >= 0 && cc < n) next[rr * n + cc] = 1;
        }
      }
      cur = next;
    }
    return cur;
  }
  const DIRS = [["north-west", "north", "north-east"], ["west", "middle", "east"], ["south-west", "south", "south-east"]];
  function analyzeMatch(home, win, n, bandPx) {
    const homeCoast = bandOf(home, n, 0), matchCoast = bandOf(win, n, 0);
    const homeBand = bandOf(home, n, bandPx), matchBand = bandOf(win, n, bandPx);
    const cls = new Uint8Array(n * n);
    let agree = 0, hc = 0, hcMatched = 0, mc = 0, mcMatched = 0, missing = 0, extra = 0;
    const cells = Array.from({ length: 9 }, () => ({ total: 0, bad: 0, missing: 0, extra: 0, coast: 0, coastOk: 0 }));
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const k = r * n + c;
      const cell = cells[Math.min(2, Math.floor(3 * r / n)) * 3 + Math.min(2, Math.floor(3 * c / n))];
      cell.total++;
      if (home[k] === win[k]) { agree++; cls[k] = home[k] ? 1 : 0; }
      else if (home[k]) { missing++; cls[k] = 2; cell.bad++; cell.missing++; }
      else { extra++; cls[k] = 3; cell.bad++; cell.extra++; }
      if (homeCoast[k]) { hc++; cell.coast++; if (matchBand[k]) { hcMatched++; cell.coastOk++; cls[k] = 4; } else cls[k] = 5; }
      if (matchCoast[k]) { mc++; if (homeBand[k]) mcMatched++; }
    }
    return { cls, agree: agree / (n * n), homeCoastMatched: hc ? hcMatched / hc : 0, matchCoastExplained: mc ? mcMatched / mc : 0, missing, extra, cells, homeBand, matchBand };
  }
  function whyText(a, m, run) {
    const pct = (v) => `${Math.round(v * 100)}%`;
    const points = [];
    const avgBad = a.cells.reduce((s, c) => s + c.bad / Math.max(1, c.total), 0) / 9;
    const ranked = a.cells.map((c, i) => ({ i, frac: c.bad / Math.max(1, c.total), missing: c.missing, extra: c.extra })).sort((x, y) => y.frac - x.frac);
    const worst = ranked[0];
    const best = a.cells.map((c, i) => ({ i, ok: c.coast ? c.coastOk / c.coast : -1, coast: c.coast })).filter((c) => c.coast >= 5).sort((x, y) => y.ok - x.ok)[0];
    const name = (i) => DIRS[Math.floor(i / 3)][i % 3];
    let summary;
    if (a.homeCoastMatched >= 0.75) summary = `A close twin: ${pct(a.homeCoastMatched)} of your coastline has the match's shoreline within ${run.params.band_px || 2} km, and the land and water agree on ${pct(a.agree)} of the square.`;
    else if (a.homeCoastMatched >= 0.5) summary = `The broad shape agrees on ${pct(a.agree)} of the square, and ${pct(a.homeCoastMatched)} of your coastline has the match's shoreline within ${run.params.band_px || 2} km. The rest runs a different course.`;
    else summary = `The land and water agree on ${pct(a.agree)} of the square, but only ${pct(a.homeCoastMatched)} of your coastline has the match's shoreline within ${run.params.band_px || 2} km. This is a match of outline, not of detail.`;
    if (best && best.ok > 0.6) points.push(`The coastlines line up best in the ${name(best.i)} of the square, where ${pct(best.ok)} of your shoreline is matched.`);
    if (worst && worst.frac > Math.max(0.08, 1.5 * avgBad)) {
      const kind = worst.missing >= worst.extra ? "the match has water where you have land" : "the match has land where you have water";
      points.push(`The biggest disagreement is in the ${name(worst.i)}, where ${kind} on ${pct(worst.frac)} of the pixels.`);
    }
    if (a.missing + a.extra > 0) {
      const share = a.missing / (a.missing + a.extra);
      if (share > 0.65) points.push(`Overall the match has less land than home: ${pct(a.missing / (m.n * m.n))} of the square is land for you and water there.`);
      else if (share < 0.35) points.push(`Overall the match has more land than home: ${pct(a.extra / (m.n * m.n))} of the square is water for you and land there.`);
    }
    if (a.matchCoastExplained < a.homeCoastMatched - 0.2) points.push(`The match has extra shoreline of its own: only ${pct(a.matchCoastExplained)} of its coast corresponds to yours, so it is more intricate than home.`);
    else if (a.matchCoastExplained > a.homeCoastMatched + 0.2) points.push(`The match has less shoreline than home: ${pct(a.matchCoastExplained)} of its coast corresponds to yours, but much of yours has no counterpart, so it is a simpler coast.`);
    if (m.flip) points.push("This match is mirrored: the sea sits on the opposite side compared with home.");
    if (Math.abs(m.theta) >= 30) points.push(`It is rotated ${Math.round(Math.abs(m.theta))} degrees, so the coast faces a different direction than yours.`);
    return { summary, points };
  }
  function drawWhy(canvas, a, n) {
    canvas.width = n; canvas.height = n;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(n, n);
    const colors = [WATER, LAND, [230, 162, 60], [142, 107, 191], [44, 160, 44], [214, 39, 40]];
    for (let k = 0; k < n * n; k++) {
      const col = colors[a.cls[k]];
      img.data[k * 4] = col[0]; img.data[k * 4 + 1] = col[1]; img.data[k * 4 + 2] = col[2]; img.data[k * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  const why = { run: null, index: 0 };
  function openWhy(run, index) {
    if (!run.template || !run.template.land) { toast("This run predates the analysis view. Run the search again to enable it."); return; }
    const list = state.run === run ? state.matches : run.matches;
    const m = list[index];
    if (!m || !m.window) return;
    why.run = run; why.index = index;
    const n = run.template.n;
    const home = landFrom(run.template.land), win = landFrom(m.window);
    const a = analyzeMatch(home, win, n, run.params.band_px || 2);
    const place = m.place || fmtCoords(m.dot_lat, m.dot_lon);
    $("why-title").textContent = `Why #${m.rank} ${place} matched`;
    $("why-meta").textContent = `score ${m.score.toFixed(3)} · mask ${m.mask_score.toFixed(2)} · coast ${m.coast_score.toFixed(2)} · rotated ${m.theta > 0 ? "+" : ""}${Math.round(m.theta)}°${m.flip ? ", mirrored" : ""}, ${m.side_km.toFixed(0)} km square`;
    drawWhy($("why-canvas"), a, n);
    $("why-agree").textContent = `${Math.round(a.agree * 100)}%`;
    $("why-home-coast").textContent = `${Math.round(a.homeCoastMatched * 100)}%`;
    $("why-match-coast").textContent = `${Math.round(a.matchCoastExplained * 100)}%`;
    $("why-score").textContent = m.score.toFixed(3);
    const text = whyText(a, { ...m, n }, run);
    $("why-summary").textContent = text.summary;
    $("why-points").innerHTML = text.points.map((t) => `<li>${escapeHtml(t)}</li>`).join("");
    $("why-dialog").showModal();
  }
  $("why-close").addEventListener("click", () => $("why-dialog").close());
  $("why-compare").addEventListener("click", () => { $("why-dialog").close(); if (why.run) openCompare(why.run, why.index); });

  const compare = { home: null, match: null, run: null, list: null, index: 0, dots: [] };
  function coastSegments(land, n, res) {
    const half = n * res / 2;
    const segs = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const k = r * n + c;
      if (c + 1 < n && land[k] !== land[k + 1]) {
        const x = -half + (c + 1) * res;
        segs.push([[x, half - (r + 1) * res], [x, half - r * res]]);
      }
      if (r + 1 < n && land[k] !== land[k + n]) {
        const y = half - (r + 1) * res;
        segs.push([[-half + c * res, y], [-half + (c + 1) * res, y]]);
      }
    }
    return segs;
  }
  function zoomFor(lat, spanM, px) {
    return Math.log2(40075016.686 * Math.cos(lat * D2R) / (512 * (spanM / px)));
  }
  function setLabels(m, on) {
    if (!m) return;
    let style = null;
    try { style = m.getStyle(); } catch (e) { return; }
    if (!style || !style.layers) return;
    for (const layer of style.layers) if (layer.type === "symbol" && m.getLayer(layer.id)) m.setLayoutProperty(layer.id, "visibility", on ? "visible" : "none");
  }
  function compareLayers(m) {
    for (const [id, paint] of [
      ["square", { "line-color": "#d62728", "line-width": 2, "line-dasharray": [3, 2] }],
      ["coast", { "line-color": "#d62728", "line-width": 2.5, "line-opacity": 0.9 }],
      ["coast-ok", { "line-color": "#2ca02c", "line-width": 2.5, "line-opacity": 0.9 }],
    ]) {
      if (!m.getSource(id)) m.addSource(id, { type: "geojson", data: m.__data && m.__data[id] || { type: "FeatureCollection", features: [] } });
      if (!m.getLayer(id)) m.addLayer({ id, type: "line", source: id, paint });
    }
    for (const id of ["coast", "coast-ok"]) m.setLayoutProperty(id, "visibility", $("compare-coast").checked ? "visible" : "none");
    setLabels(m, m.__labels !== false);
  }
  function ensureCompareMaps() {
    if (compare.home) return;
    for (const key of ["home", "match"]) {
      const m = new maplibregl.Map({ container: `compare-${key}`, style: styleFor(currentScheme()), interactive: false, attributionControl: false });
      m.__styleKey = styleKey(currentScheme());
      m.on("style.load", () => compareLayers(m));
      compare[key] = m;
    }
  }
  function setCompareData(m, data) {
    m.__data = data;
    for (const [id, fc] of Object.entries(data)) { const src = m.getSource(id); if (src) src.setData(fc); }
  }
  function openCompare(run, index) {
    compare.list = state.run === run ? state.matches : run.matches;
    if (!webgl) { toast("The comparison view needs WebGL, which this browser does not provide."); return; }
    compare.run = run;
    compare.index = Math.max(0, Math.min(compare.list.length - 1, index));
    $("compare-dialog").showModal();
    requestAnimationFrame(() => {
      ensureCompareMaps();
      compare.home.resize();
      compare.match.resize();
      renderCompare();
    });
  }
  function renderCompare() {
    const run = compare.run;
    if (!run || !compare.list) return;
    const m = compare.list[compare.index];
    const t = run.template;
    const land = landFrom(t.land);
    const homeFrame = makeFrame(run.params.center.lat, run.params.center.lon);
    const matchFrame = makeFrame(m.center_lat, m.center_lon);
    const segs = coastSegments(land, t.n, t.res);
    const toLonLat = (frame, x, y) => { const [la, lo] = toLatLon(frame, x, y); return [lo, la]; };
    const win = m.window ? landFrom(m.window) : null;
    const matchBand = win ? bandOf(win, t.n, run.params.band_px || 2) : null;
    const half = t.n * t.res / 2;
    const segOk = (seg) => {
      if (!matchBand) return false;
      const mx = (seg[0][0] + seg[1][0]) / 2, my = (seg[0][1] + seg[1][1]) / 2;
      const c = Math.min(t.n - 1, Math.max(0, Math.floor((mx + half) / t.res))), r = Math.min(t.n - 1, Math.max(0, Math.floor((half - my) / t.res)));
      const c2 = Math.min(t.n - 1, Math.max(0, Math.round((mx + half) / t.res) - 1)), r2 = Math.min(t.n - 1, Math.max(0, Math.round((half - my) / t.res) - 1));
      return !!(matchBand[r * t.n + c] || matchBand[r2 * t.n + c2] || matchBand[r * t.n + c2] || matchBand[r2 * t.n + c]);
    };
    const okSegs = segs.filter(segOk), badSegs = segs.filter((sg) => !segOk(sg));
    const lines = (list, frame, transform) => ({ type: "Feature", geometry: { type: "MultiLineString", coordinates: list.map((seg) => seg.map(([x, y]) => { const [qx, qy] = transform ? forward(x, y, m.theta, m.flip, m.scale) : [x, y]; return toLonLat(frame, qx, qy); })) } });
    const homeCoast = lines(badSegs, homeFrame, false), homeCoastOk = lines(okSegs, homeFrame, false);
    const matchCoast = lines(badSegs, matchFrame, true), matchCoastOk = lines(okSegs, matchFrame, true);
    const h = t.n * t.res / 2;
    const homeSquare = polygonFeature([[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].map(([x, y]) => toLonLat(homeFrame, x, y)));
    const matchSquare = polygonFeature(m.square);
    setCompareData(compare.home, { square: { type: "FeatureCollection", features: [homeSquare] }, coast: { type: "FeatureCollection", features: [homeCoast] }, "coast-ok": { type: "FeatureCollection", features: [homeCoastOk] } });
    setCompareData(compare.match, { square: { type: "FeatureCollection", features: [matchSquare] }, coast: { type: "FeatureCollection", features: [matchCoast] }, "coast-ok": { type: "FeatureCollection", features: [matchCoastOk] } });
    for (const d of compare.dots) d.remove();
    compare.dots = [
      makePin("pin-dot").setLngLat([run.params.home.lon, run.params.home.lat]).addTo(compare.home),
      makePin("pin-dot").setLngLat([m.dot_lon, m.dot_lat]).addTo(compare.match),
    ];
    const rect = $("compare-home").getBoundingClientRect();
    const px = Math.max(200, Math.min(rect.width, rect.height));
    const offset = Number($("compare-zoom").value);
    const side = run.params.side_km * 1000;
    compare.home.jumpTo({ center: [run.params.center.lon, run.params.center.lat], zoom: zoomFor(run.params.center.lat, side * 1.3, px) + offset, bearing: 0, pitch: 0 });
    compare.match.jumpTo({ center: [m.center_lon, m.center_lat], zoom: zoomFor(m.center_lat, side * m.scale * 1.3, px) + offset, bearing: -m.theta, pitch: 0 });
    $("compare-match").classList.toggle("mirrored", !!m.flip);
    const labels = $("compare-labels").checked;
    compare.home.__labels = labels;
    compare.match.__labels = labels && !m.flip;
    setLabels(compare.home, compare.home.__labels);
    setLabels(compare.match, compare.match.__labels);
    for (const cm of [compare.home, compare.match]) for (const id of ["coast", "coast-ok"]) if (cm.getLayer(id)) cm.setLayoutProperty(id, "visibility", $("compare-coast").checked ? "visible" : "none");
    const place = m.place || fmtCoords(m.dot_lat, m.dot_lon);
    $("compare-title").textContent = `#${m.rank} ${place}`;
    $("compare-meta").textContent = `score ${m.score.toFixed(3)} · rotated ${m.theta > 0 ? "+" : ""}${Math.round(m.theta)}°${m.flip ? ", mirrored" : ""}, ${m.side_km.toFixed(0)} km square · ${fmtKm(haversineKm(run.params.home.lat, run.params.home.lon, m.dot_lat, m.dot_lon))} from home · dot lands at ${fmtCoords(m.dot_lat, m.dot_lon)}`;
    $("compare-home-caption").textContent = `Home · ${run.params.side_km} km square`;
    $("compare-match-caption").textContent = `${place}${m.flip ? " · mirrored, labels off" : ""}`;
    $("compare-prev").disabled = compare.index === 0;
    $("compare-next").disabled = compare.index >= compare.list.length - 1;
  }
  $("compare-close").addEventListener("click", () => $("compare-dialog").close());
  $("compare-prev").addEventListener("click", () => { if (compare.index > 0) { compare.index--; renderCompare(); } });
  $("compare-next").addEventListener("click", () => { if (compare.list && compare.index < compare.list.length - 1) { compare.index++; renderCompare(); } });
  $("compare-dialog").addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft") $("compare-prev").click();
    else if (ev.key === "ArrowRight") $("compare-next").click();
  });
  $("compare-zoom").addEventListener("input", renderCompare);
  $("compare-labels").addEventListener("change", renderCompare);
  $("compare-coast").addEventListener("change", renderCompare);
  window.addEventListener("resize", () => { if ($("compare-dialog").open && compare.home) { compare.home.resize(); compare.match.resize(); renderCompare(); } });

  $("runs-button").addEventListener("click", () => {
    const runs = refreshRunsCount();
    const body = $("runs-body");
    body.innerHTML = "";
    $("runs-empty").hidden = runs.length > 0;
    for (const r of runs) {
      const tr = document.createElement("tr");
      const top = r.matches[0] ? `${escapeHtml(r.matches[0].place || fmtCoords(r.matches[0].dot_lat, r.matches[0].dot_lon))} (${r.matches[0].score.toFixed(3)})` : "";
      tr.innerHTML = `
        <td><b>${escapeHtml(r.label)}</b><br><span class="muted small">${timeAgo(r.started)}</span></td>
        <td>${fmtCoords(r.params.home.lat, r.params.home.lon)}</td><td>${r.params.side_km} km</td>
        <td>${r.matches.length}</td><td>${top}</td>
        <td class="actions"><button type="button" class="small" data-open="${r.id}">Open</button><button type="button" class="ghost small" data-delete="${r.id}">Delete</button></td>`;
      body.appendChild(tr);
    }
    body.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => {
      $("runs-dialog").close();
      const run = loadRuns().find((r) => r.id === b.dataset.open);
      if (!run) return;
      if (!state.home || Math.abs(state.home.lat - run.params.home.lat) > 1e-6 || Math.abs(state.home.lon - run.params.home.lon) > 1e-6) {
        $("side-km").value = run.params.side_km;
        $("side-out").textContent = run.params.side_km;
        setHome(run.params.home.lat, run.params.home.lon);
      }
      showRun(run);
    }));
    body.querySelectorAll("[data-delete]").forEach((b) => b.addEventListener("click", () => {
      if (!confirm("Delete this saved run?")) return;
      const runs = loadRuns().filter((r) => r.id !== b.dataset.delete);
      try { localStorage.setItem(RUNS_KEY, JSON.stringify(runs)); } catch (e) {}
      b.closest("tr").remove();
      if (state.run && state.run.id === b.dataset.delete) { $("results").hidden = true; clearResults(); }
      refreshRunsCount();
      $("runs-empty").hidden = runs.length > 0;
    }));
    $("runs-dialog").showModal();
  });
  $("runs-close").addEventListener("click", () => $("runs-dialog").close());
  $("tips-button").addEventListener("click", () => $("tips-dialog").showModal());
  $("tips-close").addEventListener("click", () => $("tips-dialog").close());

  function init() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch (e) {}
    const q = new URLSearchParams(location.search);
    if (q.has("lat") && q.has("lon") && isFinite(Number(q.get("lat"))) && isFinite(Number(q.get("lon")))) {
      saved = { home: { lat: Number(q.get("lat")), lon: Number(q.get("lon")) }, side: Number(q.get("side")) || 60, address: "" };
      if (q.has("clat") && q.has("clon")) { saved.centerMode = "custom"; saved.center = { lat: Number(q.get("clat")), lon: Number(q.get("clon")) }; }
    }
    if (saved && saved.home) {
      $("side-km").value = saved.side || 60;
      $("side-out").textContent = $("side-km").value;
      $("address").value = saved.address || "";
      if (saved.centerMode === "custom" && saved.center) {
        state.centerMode = "custom";
        state.center = saved.center;
        document.querySelector('input[name="center-mode"][value="custom"]').checked = true;
      }
      setHome(saved.home.lat, saved.home.lon, { pan: false });
      map.jumpTo({ center: [saved.home.lon, saved.home.lat], zoom: 8 });
    }
    refreshRunsCount();
    ensurePool(workerCount()).catch((e) => toast(`Could not load the land mask: ${e.message}`));
  }
  init();
})();
