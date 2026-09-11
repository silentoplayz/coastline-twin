(() => {
  const $ = (id) => document.getElementById(id);
  const SETTINGS_KEY = "coastline-twin-local";
  const LAND = [217, 201, 163], WATER = [158, 202, 225], RED = [214, 39, 40];

  const state = {
    home: null, center: null, centerMode: "home", bbox: null, mode: "place", placeTemplate: null, homeClimate: null,
    previewTimer: null, previewSeq: 0, template: null,
    job: null, pollTimer: null, running: false,
    run: null, selected: null, matches: [], markers: new Map(),
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); msg = j.detail || msg; } catch (e) {}
      throw new Error(msg);
    }
    return res.json();
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
    if (!map.getSource("dem-terrain")) map.addSource("dem-terrain", DEM);
    if (!map.getLayer("hillshade")) map.addLayer({ id: "hillshade", type: "hillshade", source: "dem", layout: { visibility: layerPrefs.hillshade ? "visible" : "none" }, paint: { "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#1b1b1b", "hillshade-highlight-color": "#ffffff" } }, firstSymbol);
    if (!map.getSource("mask")) map.addSource("mask", { type: "image", url: BLANK_PNG, coordinates: [[-1, 1], [1, 1], [1, -1], [-1, -1]] });
    if (!map.getLayer("mask")) map.addLayer({ id: "mask", type: "raster", source: "mask", layout: { visibility: layerPrefs.mask ? "visible" : "none" }, paint: { "raster-opacity": 0.55, "raster-resampling": "nearest", "raster-fade-duration": 0 } }, firstSymbol);
    map.setTerrain(layerPrefs.terrain ? { source: "dem-terrain", exaggeration: 1.2 } : null);
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
    return `/api/mask.png?w=${req.w}&s=${req.s}&e=${req.e}&n=${req.n}&width=${req.width}&height=${req.height}`;
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
    if (map.getSource("dem-terrain")) map.setTerrain(layerPrefs.terrain ? { source: "dem-terrain", exaggeration: 1.2 } : null);
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
  window.__coastlineTwin = { map, reverseGeocode: (...a) => reverseGeocode(...a), placeLevelName: (...a) => placeLevelName(...a) };
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
    return api(`/api/geocode?q=${encodeURIComponent(q)}`);
  }
  async function reverseGeocode(lat, lon) {
    try {
      const r = await api(`/api/reverse?lat=${lat}&lon=${lon}`);
      return r.name || "";
    } catch (e) {
      return "";
    }
  }

  function squareCorners(lat, lon, sideKm) {
    const h = sideKm * 500;
    const frame = makeFrame(lat, lon);
    return [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => toLatLon(frame, x, y));
  }
  async function placeLevelName(lat, lon) {
    for (const radius of [30, 200]) {
      try {
        const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&radius=${radius}&osm_tag=place&limit=4&lang=en`);
        if (!res.ok) continue;
        const data = await res.json();
        const f = (data.features || []).find((x) => x.properties && x.properties.name && !/^\d+$/.test(x.properties.name) && !["square", "locality", "plot", "house"].includes(x.properties.osm_value));
        if (f) {
          const pr = f.properties;
          return [pr.name, pr.city && pr.city !== pr.name ? pr.city : null, pr.state || pr.county, pr.countrycode].filter(Boolean).join(", ");
        }
      } catch (e) {}
    }
    return "";
  }
  function homeName() {
    const text = $("home-address").textContent.trim();
    if (!state.home || !text || /^(Looking up|No address|Click the map|Address lookup)/.test(text)) return null;
    return text;
  }
  function setHomeClimate(code, name) {
    state.homeClimate = code || null;
    const line = $("preview-climate");
    if (state.mode === "draw" || !code) {
      line.hidden = true;
      $("climate-same").textContent = "Same as home";
      $("climate-group").textContent = "Same group as home";
    } else {
      line.textContent = `Climate at the dot: ${code}, ${name || ""}`.replace(/, $/, "");
      line.hidden = false;
      $("climate-same").textContent = `Same as home (${code})`;
      $("climate-group").textContent = `Same group as home (${code[0]})`;
    }
    const drawn = state.mode === "draw" || !code;
    $("climate-same").disabled = drawn;
    $("climate-group").disabled = drawn;
    if (drawn && ["same", "group"].includes($("climate").value)) $("climate").value = "";
  }
  function climateLabel(code) {
    return code ? code : "";
  }
  function thetaOf(m) { return m.theta_display != null ? m.theta_display : m.theta; }
  function mirrorText(m) { return m.mirror === "ns" ? ", mirrored north–south" : (m.flip ? ", mirrored" : ""); }
  function scoreLabel(score, run) {
    const adjusted = score - (run && run.label_shift ? run.label_shift : 0);
    if (adjusted >= 0.8) return ["close twin", "chip-strong"];
    if (adjusted >= 0.7) return ["strong", "chip-good"];
    if (adjusted >= 0.6) return ["outline match", "chip-fair"];
    return ["loose", "chip-weak"];
  }
  const HIST_BINS = 400, HIST_STEP = 2 / HIST_BINS;
  function topShare(run, m) {
    const scored = run && run.scored;
    if (!scored || !scored.n || typeof m.coarse !== "number") return null;
    const pos = (m.coarse + 1) / HIST_STEP;
    const b = Math.max(0, Math.min(HIST_BINS - 1, Math.floor(pos)));
    let above = scored.hist[b] * Math.max(0, Math.min(1, b + 1 - pos));
    for (let i = b + 1; i < HIST_BINS; i++) above += scored.hist[i];
    return 100 * Math.min(scored.n, above + 1) / scored.n;
  }
  function fmtTop(pct) {
    if (pct == null) return "";
    if (pct >= 10) return `top ${Math.round(pct)}%`;
    if (pct >= 1) return `top ${pct.toFixed(1)}%`;
    if (pct >= 0.01) return `top ${pct.toFixed(2)}%`;
    return "top <0.01%";
  }
  function topText(run, m) {
    const pct = topShare(run, m);
    return pct == null ? "" : `${fmtTop(pct)} of ${run.scored.n.toLocaleString()} placements`;
  }
  function labelShift(run) {
    const deltas = (run.matches || []).filter((m) => m.vector && typeof m.km_score === "number").map((m) => m.score - m.km_score).sort((a, b) => a - b);
    if (deltas.length < 3) return 0;
    const mid = deltas[Math.floor(deltas.length / 2)];
    return Math.min(0, mid);
  }
  function fmtKm(km) {
    return `${Math.round(km).toLocaleString()} km`;
  }
  function permalink() {
    const u = new URL(location.href);
    u.search = "";
    if (state.mode === "draw" && draw.land) {
      u.searchParams.set("side", $("side-km").value);
      u.searchParams.set("d", `${draw.n}.${packDrawing()}`);
      u.searchParams.set("dot", `${draw.dot[0]},${draw.dot[1]}`);
      return u.toString();
    }
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
        home: state.home, center: state.center, centerMode: state.centerMode, mode: state.mode,
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
  map.on("click", (e) => { if (state.mode !== "draw") setHome(e.lngLat.lat, e.lngLat.lng); });
  $("home-lat").addEventListener("change", () => setHome(Number($("home-lat").value), Number($("home-lon").value || 0), { pan: true }));
  $("home-lon").addEventListener("change", () => setHome(Number($("home-lat").value || 0), Number($("home-lon").value), { pan: true }));
  document.querySelectorAll('input[name="center-mode"]').forEach((r) => r.addEventListener("change", () => {
    state.centerMode = r.value;
    if (state.centerMode === "custom" && state.home && !state.center) state.center = { ...state.home };
    if (state.centerMode === "custom" && state.home) toast("Drag the blue pin to move the square. Your home dot stays put.", 4500);
    drawSquare(); schedulePreview(); saveSettings();
  }));
  $("side-km").addEventListener("input", () => { $("side-out").textContent = $("side-km").value; drawSquare(); schedulePreview(); saveSettings(); });
  $("detail-weight").addEventListener("input", () => { $("detail-out").textContent = $("detail-weight").value; });
  for (const id of ["rot-max", "flip", "same-hemisphere", "lat-band"]) $(id).addEventListener("change", schedulePreview);
  $("climate").addEventListener("change", schedulePreview);
  document.querySelectorAll('input[name="scale"]').forEach((c) => c.addEventListener("change", schedulePreview));

  const DRAW_KEY = "coastline-twin-draw";
  const draw = { n: 60, land: null, dot: [30, 30], tool: "land", history: [], painting: false };
  function drawGridSize() { return Math.max(48, Math.min(160, Math.round(Number($("side-km").value)))); }
  function presetDrawing(n) {
    const land = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) land[r * n + c] = c + 0.25 * r < 0.62 * n ? 1 : 0;
    return land;
  }
  function resampleGrid(land, n, m) {
    if (n === m) return Uint8Array.from(land);
    const out = new Uint8Array(m * m);
    for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) out[r * m + c] = land[Math.min(n - 1, Math.floor(r * n / m)) * n + Math.min(n - 1, Math.floor(c * n / m))];
    return out;
  }
  function setDrawing(n, land, dot) {
    draw.n = n;
    draw.land = land;
    draw.dot = dot || [Math.floor(n / 2), Math.floor(n / 2)];
    draw.history = [];
    renderDrawing();
  }
  function ensureDrawing() {
    const n = drawGridSize();
    if (!draw.land) setDrawing(n, presetDrawing(n), [Math.floor(n * 0.45), Math.floor(n / 2)]);
    else if (draw.n !== n) setDrawing(n, resampleGrid(draw.land, draw.n, n), [Math.round(draw.dot[0] * n / draw.n), Math.round(draw.dot[1] * n / draw.n)]);
  }
  function renderDrawing() {
    if (!draw.land) return;
    drawMask($("draw-canvas"), draw.land, draw.n, [draw.dot[0] + 0.5, draw.dot[1] + 0.5]);
    $("draw-side").textContent = $("side-km").value;
  }
  function saveDrawing() {
    try { localStorage.setItem(DRAW_KEY, JSON.stringify({ n: draw.n, land: Array.from(draw.land).join(""), dot: draw.dot })); } catch (e) {}
  }
  function packDrawing() {
    const bytes = new Uint8Array(Math.ceil(draw.n * draw.n / 8));
    for (let k = 0; k < draw.n * draw.n; k++) if (draw.land[k]) bytes[k >> 3] |= 1 << (k & 7);
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unpackDrawing(n, text) {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const land = new Uint8Array(n * n);
    for (let k = 0; k < n * n; k++) if (bin.charCodeAt(k >> 3) & (1 << (k & 7))) land[k] = 1;
    return land;
  }
  function drawingLandString() { return Array.from(draw.land).join(""); }
  function cellFromEvent(ev) {
    const rect = $("draw-canvas").getBoundingClientRect();
    return [Math.floor((ev.clientX - rect.left) / rect.width * draw.n), Math.floor((ev.clientY - rect.top) / rect.height * draw.n)];
  }
  function paintAt(c0, r0) {
    const rad = Number($("draw-brush").value) - 1;
    const value = draw.tool === "land" ? 1 : 0;
    for (let r = r0 - rad; r <= r0 + rad; r++) for (let c = c0 - rad; c <= c0 + rad; c++) {
      if (r < 0 || r >= draw.n || c < 0 || c >= draw.n) continue;
      if ((r - r0) ** 2 + (c - c0) ** 2 > rad * rad + rad * 0.5) continue;
      draw.land[r * draw.n + c] = value;
    }
  }
  function drawingChanged() {
    renderDrawing();
    saveDrawing();
    saveSettings();
    schedulePreview();
  }
  $("draw-canvas").addEventListener("pointerdown", (ev) => {
    if (!draw.land) return;
    ev.preventDefault();
    const [c, r] = cellFromEvent(ev);
    if (draw.tool === "dot") {
      if (c >= 0 && c < draw.n && r >= 0 && r < draw.n) { draw.dot = [c, r]; drawingChanged(); }
      return;
    }
    draw.history.push(Uint8Array.from(draw.land));
    if (draw.history.length > 25) draw.history.shift();
    draw.painting = true;
    $("draw-canvas").setPointerCapture(ev.pointerId);
    paintAt(c, r);
    renderDrawing();
  });
  $("draw-canvas").addEventListener("pointermove", (ev) => {
    if (!draw.painting) return;
    const [c, r] = cellFromEvent(ev);
    paintAt(c, r);
    renderDrawing();
  });
  const endStroke = () => { if (draw.painting) { draw.painting = false; drawingChanged(); } };
  $("draw-canvas").addEventListener("pointerup", endStroke);
  $("draw-canvas").addEventListener("pointercancel", endStroke);
  document.querySelectorAll(".draw-tools .tool").forEach((b) => b.addEventListener("click", () => {
    draw.tool = b.dataset.tool;
    document.querySelectorAll(".draw-tools .tool").forEach((x) => x.classList.toggle("active", x === b));
    $("draw-canvas").style.cursor = draw.tool === "dot" ? "pointer" : "crosshair";
  }));
  $("draw-undo").addEventListener("click", () => { if (draw.history.length) { draw.land = draw.history.pop(); drawingChanged(); } });
  $("draw-clear").addEventListener("click", () => { draw.history.push(Uint8Array.from(draw.land)); draw.land = presetDrawing(draw.n); drawingChanged(); });
  $("draw-flip").addEventListener("click", () => {
    draw.history.push(Uint8Array.from(draw.land));
    const n = draw.n, out = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) out[r * n + c] = draw.land[r * n + (n - 1 - c)];
    draw.land = out;
    draw.dot = [n - 1 - draw.dot[0], draw.dot[1]];
    drawingChanged();
  });
  $("draw-from-place").addEventListener("click", () => {
    const t = state.placeTemplate;
    if (!t) { toast("Pick a place first, then come back to copy its square."); return; }
    draw.history.push(Uint8Array.from(draw.land));
    const n = draw.n;
    draw.land = resampleGrid(t.land, t.n, n);
    const half = t.n * t.res / 2;
    draw.dot = [Math.max(0, Math.min(n - 1, Math.floor((t.dot[0] + half) / (t.n * t.res) * n))), Math.max(0, Math.min(n - 1, Math.floor((half - t.dot[1]) / (t.n * t.res) * n)))];
    drawingChanged();
  });
  function setMode(mode, { silent = false } = {}) {
    state.mode = mode;
    document.querySelectorAll(".mode-tab").forEach((b) => { const on = b.dataset.mode === mode; b.classList.toggle("active", on); b.setAttribute("aria-selected", String(on)); });
    $("place-panel").hidden = mode !== "place";
    $("draw-panel").hidden = mode !== "draw";
    $("copy-link").textContent = mode === "draw" ? "Copy link to this drawing" : "Copy link to this spot";
    $("copy-link").closest(".button-row").hidden = false;
    document.querySelector('input[name="center-mode"]').closest(".choice-row").hidden = mode === "draw";
    for (const id of ["same-hemisphere", "lat-band"]) $(id).disabled = mode === "draw";
    $("map-hint").classList.toggle("faded", mode === "draw" || !!state.home);
    if (mode === "draw") {
      ensureDrawing();
      if (homeOnMap) { homeMarker.remove(); homeOnMap = false; }
      if (centerOnMap) { centerMarker.remove(); centerOnMap = false; }
      setOverlay("home-square", []);
      $("run-button").disabled = state.running;
    } else {
      if (state.home) { homeMarker.setLngLat([state.home.lon, state.home.lat]); if (!homeOnMap) { homeMarker.addTo(map); homeOnMap = true; } drawSquare(); }
      $("run-button").disabled = !state.home || state.running;
    }
    if (!silent) { saveSettings(); schedulePreview(); }
  }
  document.querySelectorAll(".mode-tab").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("side-km").addEventListener("input", () => { if (state.mode === "draw") { ensureDrawing(); renderDrawing(); } });
  function customParams() {
    ensureDrawing();
    return { n: draw.n, land: drawingLandString(), dot: draw.dot };
  }

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
      const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5&lang=en`, { signal: ctrl.signal });
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

  function previewBody() {
    const drawn = state.mode === "draw";
    const body = { home: drawn ? null : state.home, side_km: Number($("side-km").value) };
    if (drawn) body.custom = customParams();
    else if (state.centerMode === "custom" && state.center) body.center = state.center;
    const res = $("res-m").value;
    if (res) body.res_m = Number(res);
    body.same_hemisphere = $("same-hemisphere").checked;
    body.lat_band = $("lat-band").value === "" ? null : Number($("lat-band").value);
    body.bbox = state.bbox;
    return body;
  }
  function schedulePreview() {
    if (state.mode === "draw" ? !draw.land : !state.home) return;
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(runPreview, 600);
  }
  async function runPreview() {
    if (state.mode === "draw" ? !draw.land : !state.home) return;
    const seq = ++state.previewSeq;
    $("preview-empty").hidden = false;
    $("preview-empty").textContent = "Rendering the square…";
    $("preview-warning").hidden = true;
    try {
      const info = await api("/api/preview", { method: "POST", body: JSON.stringify(previewBody()) });
      if (seq !== state.previewSeq) return;
      state.template = { n: info.n, res: info.res_m, land: landFrom(info.land), dot: info.dot_xy_m, stats: info.stats };
      if (state.mode === "place") state.placeTemplate = state.template;
      setHomeClimate(info.climate, info.climate_name);
      drawMask($("preview-canvas"), state.template.land, info.n, dotPixel(state.template));
      $("preview-canvas").hidden = false;
      $("preview-empty").hidden = true;
      $("preview-stats").hidden = false;
      $("stat-pixels").textContent = `${info.n}²`;
      $("stat-land").textContent = `${Math.round(info.stats.land_fraction * 100)}%`;
      $("stat-coast").textContent = info.stats.coast_ratio.toFixed(2);
      $("stat-tiles").textContent = info.tiles;
      const workers = Number($("workers").value) || Math.max(1, Math.min((navigator.hardwareConcurrency || 4) - 2, 12));
      $("run-estimate").textContent = `About ${fmtDuration(info.tiles * 5.5 / workers + 10)} on ${workers} processes`;
      if (info.warnings && info.warnings.length) {
        $("preview-warning").textContent = info.warnings.join(" ");
        $("preview-warning").hidden = false;
      }
      $("run-button").disabled = state.running;
    } catch (err) {
      if (seq !== state.previewSeq) return;
      $("preview-canvas").hidden = true;
      $("preview-stats").hidden = true;
      $("preview-empty").hidden = false;
      $("preview-empty").textContent = err.message;
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

  function jobBody() {
    const body = previewBody();
    const scales = [...document.querySelectorAll('input[name="scale"]:checked')].map((c) => Number(c.value));
    Object.assign(body, {
      rot_max: Number($("rot-max").value),
      rot_step: Number($("rot-max").value) >= 180 ? 20 : 15,
      scales: scales.length ? scales : [1],
      flip: $("flip").checked,
      hemisphere_flip: $("hemisphere-flip").checked,
      top: Number($("top").value) || 15,
      min_score: Number($("min-score").value) || 0.5,
      detail_weight: Number($("detail-weight").value),
      band_px: Number($("band-px").value) || 1,
      same_hemisphere: $("same-hemisphere").checked,
      lat_band: $("lat-band").value === "" ? null : Number($("lat-band").value),
      bbox: state.bbox,
      climate: $("climate").value,
      vector_top: $("vector-sharpen").checked ? 20 : 0,
      exclude_km: state.mode === "draw" ? 0 : ($("exclude-km").value === "" ? null : Number($("exclude-km").value)),
      workers: $("workers").value === "" ? null : Number($("workers").value),
      label: $("label").value.trim() || null,
      home_name: homeName(),
    });
    return body;
  }

  const interimMarkers = [];
  function clearInterim() {
    for (const mk of interimMarkers) mk.remove();
    interimMarkers.length = 0;
    const list = $("status-interim");
    list.innerHTML = "";
    list.hidden = true;
  }
  function renderInterim(leaders) {
    const list = $("status-interim");
    list.innerHTML = "";
    if (!leaders || !leaders.length) { list.hidden = true; return; }
    const title = document.createElement("li");
    title.className = "interim-title";
    title.textContent = "Leading so far";
    title.style.display = "block";
    list.appendChild(title);
    leaders.forEach((m, i) => {
      const li = document.createElement("li");
      const where = `${fmtCoords(m.dot_lat, m.dot_lon)}${m.climate ? " · " + m.climate : ""}`;
      li.innerHTML = `<span class="rank">${i + 1}</span><span>${where}<br><span class="small">rotated ${thetaOf(m) > 0 ? "+" : ""}${Math.round(thetaOf(m))}°${mirrorText(m)}, ${m.side_km.toFixed(0)} km</span></span><b>${m.score.toFixed(3)}</b>`;
      list.appendChild(li);
    });
    list.hidden = false;
    for (const mk of interimMarkers) mk.remove();
    interimMarkers.length = 0;
    if (!webgl) return;
    leaders.forEach((m, i) => {
      const mk = makePin("pin-match interim", { text: String(i + 1) });
      mk.setLngLat([m.dot_lon, m.dot_lat]).addTo(map);
      interimMarkers.push(mk);
    });
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

  window.addEventListener("beforeunload", (e) => { if (state.running) { e.preventDefault(); e.returnValue = ""; } });
  $("run-button").addEventListener("click", async () => {
    if ((state.mode === "draw" ? !draw.land : !state.home) || state.running) return;
    $("run-button").disabled = true;
    try {
      const body = jobBody();
      if (state.mode !== "draw" && state.home) body.home_name = (await placeLevelName(state.home.lat, state.home.lon)) || body.home_name;
      const job = await api("/api/jobs", { method: "POST", body: JSON.stringify(body) });
      toast("Search started");
      attachJob(job);
      refreshRunsCount();
    } catch (err) {
      toast(`Could not start: ${err.message}`);
      $("run-button").disabled = false;
    }
  });
  $("cancel-button").addEventListener("click", async () => {
    if (!state.job) return;
    try {
      const job = await api(`/api/jobs/${state.job.id}/cancel`, { method: "POST" });
      renderJobStatus(job);
    } catch (err) {
      toast(err.message);
    }
  });
  function attachJob(job) {
    state.job = job;
    renderJobStatus(job);
    clearInterval(state.pollTimer);
    if (job.status === "running" || job.status === "cancelling") {
      state.running = true;
      state.pollTimer = setInterval(pollJob, 1000);
    } else {
      showJob(job.id);
    }
  }
  async function pollJob() {
    if (!state.job) return;
    try {
      const job = await api(`/api/jobs/${state.job.id}`);
      state.job = job;
      renderJobStatus(job);
      if (job.status !== "running" && job.status !== "cancelling") {
        clearInterval(state.pollTimer);
        state.running = false;
        $("run-button").disabled = state.mode === "draw" ? !draw.land : !state.home;
        if (job.status === "done") {
          toast(`Done: ${job.count} matches in ${fmtDuration(job.seconds)}`);
          showRun(runFromJob(job));
        } else {
          toast(job.error || `Run ${job.status}`);
        }
        refreshRunsCount();
      }
    } catch (err) {
      clearInterval(state.pollTimer);
      state.running = false;
      toast(err.message);
      $("run-button").disabled = state.mode === "draw" ? !draw.land : !state.home;
    }
  }
  function renderJobStatus(job) {
    const p = job.progress || { done: 0, total: 0 };
    const pct = p.total ? Math.round(100 * p.done / p.total) : 0;
    if (job.status === "running") renderInterim(p.interim || []);
    else clearInterim();
    if (job.status === "running" && p.stage === "vector") {
      setStatus("Sharpening with vector coastlines…", `${p.vector_done} of ${p.vector_total} matches re-scored at about 250 m`, 100, { cancellable: true });
    } else if (job.status === "running") {
      const eta = p.eta != null ? `, about ${fmtDuration(p.eta)} left` : "";
      setStatus(p.total ? `Searching… ${pct}%` : "Preparing the search…",
        p.total ? `${p.done} of ${p.total} tiles, ${fmtDuration(p.elapsed)} elapsed${eta}` : "Building the template and its variants", pct, { cancellable: true });
    } else if (job.status === "cancelling") {
      setStatus("Stopping…", "", pct, {});
    } else if (job.status === "done") {
      setStatus("Done", `${job.count} matches from ${job.template ? job.template.tiles : "?"} tiles in ${fmtDuration(job.seconds)}`, 100, { done: true });
    } else {
      setStatus(job.status === "cancelled" ? "Cancelled" : "Failed", job.error || "", 0, { failed: true });
    }
  }
  function runFromJob(job) {
    const meta = job.meta || {};
    const t = job.template || {};
    const filters = meta.filters || {};
    const home = meta.home ? { lat: meta.home[0], lon: meta.home[1] } : (job.params && job.params.home) || null;
    const center = meta.center ? { lat: meta.center[0], lon: meta.center[1] } : home;
    return {
      id: job.id, label: job.label || job.id, started: (job.started || 0) * 1000, seconds: meta.seconds, tiles: meta.tiles,
      params: { home, center, custom: !home, home_name: job.params && job.params.home_name, side_km: meta.side_km || job.params.side_km, band_px: meta.band_px, hemisphere_flip: meta.hemisphere_flip, climate: filters.climate, same_hemisphere: filters.same_hemisphere, lat_band: filters.lat_band, bbox: filters.bbox },
      home_climate: meta.home_climate,
      scored: meta.scored || null,
      template: t.land ? { n: t.n, res: t.res_m, land: t.land, dot: t.dot_xy_m } : null,
      matches: job.matches || [],
      files: job.files || null,
    };
  }
  async function showJob(id) {
    try {
      const job = await api(`/api/jobs/${id}`);
      state.job = job;
      renderJobStatus(job);
      if (job.status === "running" || job.status === "cancelling") {
        clearInterval(state.pollTimer);
        state.running = true;
        state.pollTimer = setInterval(pollJob, 1000);
        $("run-button").disabled = true;
      } else if (job.status === "done") {
        const run = runFromJob(job);
        restoreRunInputs(run);
        showRun(run);
      }
    } catch (err) {
      toast(err.message);
    }
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
      distance: (m) => (home ? haversineKm(home.lat, home.lon, m.dot_lat, m.dot_lon) : 0),
      rotation: (m) => Math.abs(m.theta) + (m.flip ? 1000 : 0),
    }[view.sort] || ((m) => -m.score);
    return run.matches.filter((m) => !view.hideMirrored || !m.flip).map((m) => [key(m), m]).sort((a, b) => a[0] - b[0]).map(([, m]) => m);
  }
  function showRun(run) {
    run.label_shift = labelShift(run);
    state.run = run;
    const distanceOption = $("sort-by").querySelector('option[value="distance"]');
    distanceOption.disabled = !run.params.home;
    if (!run.params.home && view.sort === "distance") { view.sort = "score"; $("sort-by").value = "score"; saveView(); }
    $("results").hidden = false;
    $("results-title").textContent = run.label;
    const bits = [`${run.params.side_km} km square`, `${run.tiles} tiles`, fmtDuration(run.seconds)];
    if (run.params.same_hemisphere) bits.push("same hemisphere");
    if (run.params.lat_band != null) bits.push(`±${run.params.lat_band}° latitude`);
    if (run.params.hemisphere_flip) bits.push("north–south mirrors");
    if (run.params.bbox) bits.push("region limited");
    if (run.scored && run.scored.n) bits.push(`${run.scored.n.toLocaleString()} placements scored`);
    if (run.params.climate) bits.push(run.params.climate === "same" ? `climate ${run.home_climate || "same"}` : run.params.climate === "group" ? `climate group ${(run.home_climate || "?")[0]}` : `climate ${run.params.climate}`);
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
    if (!matches.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = run.matches.length ? "Every match is mirrored. Untick Hide mirrored to see them." : "No matches cleared the minimum score. Lower it under Advanced, widen the filters, or enlarge the square and search again.";
      list.appendChild(empty);
    }
    const sheet = $("sheet");
    sheet.innerHTML = "";
    const bounds = [];
    const squares = [];
    matches.forEach((m, index) => {
      const place = m.place || fmtCoords(m.dot_lat, m.dot_lon);
      const flip = mirrorText(m);
      const distance = run.params.home ? fmtKm(haversineKm(run.params.home.lat, run.params.home.lon, m.dot_lat, m.dot_lon)) + " from home" : "drawn coastline";
      const osm = `https://www.openstreetmap.org/?mlat=${m.dot_lat.toFixed(5)}&mlon=${m.dot_lon.toFixed(5)}#map=11/${m.dot_lat.toFixed(5)}/${m.dot_lon.toFixed(5)}`;
      const gm = `https://www.google.com/maps/search/?api=1&query=${m.dot_lat.toFixed(5)},${m.dot_lon.toFixed(5)}`;
      const li = document.createElement("li");
      li.className = "match";
      li.tabIndex = 0;
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === li) selectMatch(m.rank, true); });
      li.innerHTML = `
        <div class="rank">${m.rank}</div>
        <div class="place">${escapeHtml(place)} <span class="chip ${scoreLabel(m.score, run)[1]}"${topShare(run, m) != null ? ` title="${topText(run, m)} in this run"` : ""}>${scoreLabel(m.score, run)[0]}</span></div>
        <div class="score">${m.score.toFixed(3)}</div>
        <div class="detail">${topShare(run, m) != null ? `${topText(run, m)} · ` : ""}rotated ${thetaOf(m) > 0 ? "+" : ""}${Math.round(thetaOf(m))}°${flip}, ${m.side_km.toFixed(0)} km square · ${distance}${m.climate ? ` · ${m.climate}${m.climate_name ? " " + m.climate_name : ""}` : ""}${m.vector ? ` · sharpened at ${m.vector_res_m} m` : ""} · dot at ${fmtCoords(m.dot_lat, m.dot_lon)}</div>
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
      row.innerHTML = `<div class="title">#${m.rank} ${escapeHtml(place)} · ${m.score.toFixed(3)}</div><div class="muted small">rotated ${thetaOf(m) > 0 ? "+" : ""}${Math.round(thetaOf(m))}°${flip}, ${m.side_km.toFixed(0)} km square · <a href="#" data-compare>compare on the map</a></div>
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

  function renderFiles(run) {
    const list = $("file-list");
    list.innerHTML = "";
    if (!run.files) return;
    for (const [key, label] of [["report", "HTML report"], ["sheet", "Contact sheet (PNG)"], ["template", "Home square (PNG)"], ["json", "Matches (JSON)"], ["geojson", "Matches (GeoJSON)"]]) {
      const li = document.createElement("li");
      li.innerHTML = `<a href="${run.files[key]}" target="_blank" rel="noopener">${label}</a>`;
      list.appendChild(li);
    }
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
    const runs = runsOf(homeCoast, matchBand, n, Math.max(8, Math.round(n / 2)));
    return { cls, agree: agree / (n * n), homeCoastMatched: hc ? hcMatched / hc : 0, matchCoastExplained: mc ? mcMatched / mc : 0, missing, extra, cells, homeBand, matchBand, continuity: runs.continuity, longest: runs.longest, largestShare: hc ? runs.longest / hc : 0 };
  }
  function runsOf(homeCoast, matchBand, n, runFull) {
    const matched = new Uint8Array(n * n);
    let total = 0;
    for (let k = 0; k < n * n; k++) if (homeCoast[k]) { total++; if (matchBand[k]) matched[k] = 1; }
    if (!total) return { continuity: 0, longest: 0 };
    const seen = new Uint8Array(n * n), stack = new Int32Array(n * n);
    let acc = 0, longest = 0;
    for (let start = 0; start < n * n; start++) {
      if (!matched[start] || seen[start]) continue;
      let top = 0, size = 0;
      stack[top++] = start; seen[start] = 1;
      while (top > 0) {
        const k = stack[--top];
        size++;
        const r = (k / n) | 0, c = k % n;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
          const kk = rr * n + cc;
          if (matched[kk] && !seen[kk]) { seen[kk] = 1; stack[top++] = kk; }
        }
      }
      acc += size * Math.min(1, size / runFull);
      if (size > longest) longest = size;
    }
    return { continuity: acc / total, longest };
  }
  function whyText(a, m, run, res, bandKm) {
    const pct = (v) => `${Math.round(v * 100)}%`;
    const points = [];
    const avgBad = a.cells.reduce((s, c) => s + c.bad / Math.max(1, c.total), 0) / 9;
    const ranked = a.cells.map((c, i) => ({ i, frac: c.bad / Math.max(1, c.total), missing: c.missing, extra: c.extra })).sort((x, y) => y.frac - x.frac);
    const worst = ranked[0];
    const best = a.cells.map((c, i) => ({ i, ok: c.coast ? c.coastOk / c.coast : -1, coast: c.coast })).filter((c) => c.coast >= 5).sort((x, y) => y.ok - x.ok)[0];
    const name = (i) => DIRS[Math.floor(i / 3)][i % 3];
    let summary;
    if (a.homeCoastMatched >= 0.75) summary = `A close twin: ${pct(a.homeCoastMatched)} of your coastline has the match's shoreline within ${bandKm} km, and the land and water agree on ${pct(a.agree)} of the square.`;
    else if (a.homeCoastMatched >= 0.5) summary = `The broad shape agrees on ${pct(a.agree)} of the square, and ${pct(a.homeCoastMatched)} of your coastline has the match's shoreline within ${bandKm} km. The rest runs a different course.`;
    else summary = `The land and water agree on ${pct(a.agree)} of the square, but only ${pct(a.homeCoastMatched)} of your coastline has the match's shoreline within ${bandKm} km. This is a match of outline, not of detail.`;
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
    if (a.homeCoastMatched >= 0.5 && a.continuity < a.homeCoastMatched * 0.6) points.push(`The matched shoreline comes in short scattered pieces rather than long stretches; the largest connected piece covers ${pct(a.largestShare)} of your coastline.`);
    else if (a.continuity >= 0.7) points.push(`The matched shoreline runs in long continuous stretches; the largest connected piece covers ${pct(a.largestShare)} of your coastline.`);
    if (a.matchCoastExplained < a.homeCoastMatched - 0.2) points.push(`The match has extra shoreline of its own: only ${pct(a.matchCoastExplained)} of its coast corresponds to yours, so it is more intricate than home.`);
    else if (a.matchCoastExplained > a.homeCoastMatched + 0.2) points.push(`The match has less shoreline than home: ${pct(a.matchCoastExplained)} of its coast corresponds to yours, but much of yours has no counterpart, so it is a simpler coast.`);
    if (topShare(run, m) != null) points.push(`Among the ${run.scored.n.toLocaleString()} coastal placements this run scored, its raw score sits in the ${fmtTop(topShare(run, m))}.`);
    if (m.mirror === "ns") points.push("This match is mirrored north to south: the sea sits on the same side as home but the sun comes from the other direction, as across the equator.");
    else if (m.flip) points.push("This match is mirrored: the sea sits on the opposite side compared with home.");
    if (Math.abs(thetaOf(m)) >= 30) points.push(`It is rotated ${Math.round(Math.abs(thetaOf(m)))} degrees, so the coast faces a different direction than yours.`);
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
  const why = { run: null, index: 0, seq: 0 };
  function renderWhy(run, m, home, win, n, bandPx, res, note) {
    const a = analyzeMatch(home, win, n, bandPx);
    const bandKm = Math.round(bandPx * res / 100) / 10;
    const place = m.place || fmtCoords(m.dot_lat, m.dot_lon);
    $("why-title").textContent = `Why #${m.rank} ${place} matched`;
    $("why-meta").textContent = `score ${m.score.toFixed(3)}${topShare(run, m) != null ? ` · ${fmtTop(topShare(run, m))} of run` : ""} · mask ${m.mask_score.toFixed(2)} · coast ${m.coast_score.toFixed(2)} · rotated ${thetaOf(m) > 0 ? "+" : ""}${Math.round(thetaOf(m))}°${mirrorText(m)}, ${m.side_km.toFixed(0)} km square${note ? " · " + note : ""}`;
    drawWhy($("why-canvas"), a, n);
    $("why-agree").textContent = `${Math.round(a.agree * 100)}%`;
    $("why-home-coast").textContent = `${Math.round(a.homeCoastMatched * 100)}%`;
    $("why-match-coast").textContent = `${Math.round(a.matchCoastExplained * 100)}%`;
    $("why-score").textContent = m.score.toFixed(3);
    $("why-continuity").textContent = `${Math.round(a.continuity * 100)}%`;
    $("why-longest").textContent = `${Math.round(a.largestShare * 100)}% of your coast`;
    const text = whyText(a, { ...m, n }, run, res, bandKm);
    $("why-summary").textContent = text.summary;
    $("why-points").innerHTML = text.points.map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  }
  function openWhy(run, index) {
    if (!run.template || !run.template.land) { toast("This run predates the analysis view. Run the search again to enable it."); return; }
    const list = state.run === run ? state.matches : run.matches;
    const m = list[index];
    if (!m || !m.window) return;
    why.run = run; why.index = index;
    const seq = ++why.seq;
    const n = run.template.n;
    renderWhy(run, m, landFrom(run.template.land), landFrom(m.window), n, run.params.band_px || 2, run.template.res, m.vector ? "loading the 250 m windows…" : "");
    $("why-dialog").showModal();
    if (m.vector) {
      loadFineOverlay(run, m).then((fine) => {
        if (why.seq !== seq || !$("why-dialog").open) return;
        renderWhy(run, m, fine.home, fine.match, fine.n, fine.bandPx, fine.res, `analyzed at ${Math.round(fine.res)} m`);
      }).catch(() => { if (why.seq === seq) $("why-meta").textContent = $("why-meta").textContent.replace(" · loading the 250 m windows…", " · 1 km windows"); });
    }
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
      const m = new maplibregl.Map({ container: `compare-${key}`, style: styleFor(currentScheme()), interactive: false, attributionControl: false, canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true } });
      m.__styleKey = styleKey(currentScheme());
      m.on("style.load", () => compareLayers(m));
      compare[key] = m;
    }
  }
  function setCompareData(m, data) {
    m.__data = data;
    for (const [id, fc] of Object.entries(data)) { const src = m.getSource(id); if (src) src.setData(fc); }
  }
  async function fetchFineWindow(run, m) {
    return api("/api/vector-window", { method: "POST", body: JSON.stringify({ job_id: run.id, rank: m.rank }) });
  }
  const fineCache = new Map();
  async function loadFineOverlay(run, m) {
    const key = `${run.id}:${m.rank}`;
    if (fineCache.has(key)) return fineCache.get(key);
    const promise = fetchFineWindow(run, m).then((r) => ({ n: r.n, res: r.res, bandPx: r.band_px, home: r.home instanceof ArrayBuffer ? new Uint8Array(r.home) : landFrom(r.home), match: r.match instanceof ArrayBuffer ? new Uint8Array(r.match) : landFrom(r.match) }));
    fineCache.set(key, promise);
    promise.catch(() => fineCache.delete(key));
    return promise;
  }
  function applyFineOverlay(run, m, fine) {
    const drawn = !run.params.center;
    const homeFrame = drawn ? null : makeFrame(run.params.center.lat, run.params.center.lon);
    const matchFrame = makeFrame(m.center_lat, m.center_lon);
    const toLonLat = (frame, x, y) => { const [la, lo] = toLatLon(frame, x, y); return [lo, la]; };
    const segs = coastSegments(fine.home, fine.n, fine.res);
    const band = bandOf(fine.match, fine.n, fine.bandPx);
    const half = fine.n * fine.res / 2;
    const ok = (seg) => {
      const mx = (seg[0][0] + seg[1][0]) / 2, my = (seg[0][1] + seg[1][1]) / 2;
      const c = Math.min(fine.n - 1, Math.max(0, Math.floor((mx + half) / fine.res))), r = Math.min(fine.n - 1, Math.max(0, Math.floor((half - my) / fine.res)));
      const c2 = Math.min(fine.n - 1, Math.max(0, Math.round((mx + half) / fine.res) - 1)), r2 = Math.min(fine.n - 1, Math.max(0, Math.round((half - my) / fine.res) - 1));
      return !!(band[r * fine.n + c] || band[r2 * fine.n + c2] || band[r * fine.n + c2] || band[r2 * fine.n + c]);
    };
    const okSegs = segs.filter(ok), badSegs = segs.filter((sg) => !ok(sg));
    const lines = (list, frame, transform) => ({ type: "Feature", geometry: { type: "MultiLineString", coordinates: list.map((seg) => seg.map(([x, y]) => { const [qx, qy] = transform ? forward(x, y, m.theta, m.flip, m.scale) : [x, y]; return toLonLat(frame, qx, qy); })) } });
    if (!drawn) setCompareData(compare.home, { ...(compare.home.__data || {}), coast: { type: "FeatureCollection", features: [lines(badSegs, homeFrame, false)] }, "coast-ok": { type: "FeatureCollection", features: [lines(okSegs, homeFrame, false)] } });
    setCompareData(compare.match, { ...(compare.match.__data || {}), coast: { type: "FeatureCollection", features: [lines(badSegs, matchFrame, true)] }, "coast-ok": { type: "FeatureCollection", features: [lines(okSegs, matchFrame, true)] } });
    for (const cm of [compare.home, compare.match]) for (const id of ["coast", "coast-ok"]) if (cm.getLayer(id)) { cm.setPaintProperty(id, "line-width", 1.1); cm.setPaintProperty(id, "line-opacity", 0.85); }
    $("compare-match-caption").textContent = `${m.place || fmtCoords(m.dot_lat, m.dot_lon)}${m.flip ? " · mirrored, labels off" : ""} · shoreline at ${Math.round(fine.res)} m`;
  }
  function openCompare(run, index) {
    compare.list = state.run === run ? state.matches : run.matches;
    if (!webgl) { toast("The comparison view needs WebGL, which this browser does not provide."); return; }
    if (!run.template || !run.template.land) { toast("This run predates the comparison view. Run the search again to enable it."); return; }
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
    const drawn = !run.params.center;
    const homeFrame = drawn ? null : makeFrame(run.params.center.lat, run.params.center.lon);
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
    const matchCoast = lines(badSegs, matchFrame, true), matchCoastOk = lines(okSegs, matchFrame, true);
    const h = t.n * t.res / 2;
    const matchSquare = polygonFeature(m.square);
    $("compare-home").hidden = drawn;
    $("compare-home-canvas").hidden = !drawn;
    for (const d of compare.dots) d.remove();
    compare.dots = [makePin("pin-dot").setLngLat([m.dot_lon, m.dot_lat]).addTo(compare.match)];
    if (drawn) {
      drawMask($("compare-home-canvas"), land, t.n, dotPixel(t));
    } else {
      const homeCoast = lines(badSegs, homeFrame, false), homeCoastOk = lines(okSegs, homeFrame, false);
      const homeSquare = polygonFeature([[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].map(([x, y]) => toLonLat(homeFrame, x, y)));
      setCompareData(compare.home, { square: { type: "FeatureCollection", features: [homeSquare] }, coast: { type: "FeatureCollection", features: [homeCoast] }, "coast-ok": { type: "FeatureCollection", features: [homeCoastOk] } });
      compare.dots.push(makePin("pin-dot").setLngLat([run.params.home.lon, run.params.home.lat]).addTo(compare.home));
    }
    setCompareData(compare.match, { square: { type: "FeatureCollection", features: [matchSquare] }, coast: { type: "FeatureCollection", features: [matchCoast] }, "coast-ok": { type: "FeatureCollection", features: [matchCoastOk] } });
    const rect = $("compare-match").getBoundingClientRect();
    const px = Math.max(200, Math.min(rect.width, rect.height));
    const offset = Number($("compare-zoom").value);
    const side = run.params.side_km * 1000;
    if (!drawn) compare.home.jumpTo({ center: [run.params.center.lon, run.params.center.lat], zoom: zoomFor(run.params.center.lat, side * 1.3, px) + offset, bearing: 0, pitch: 0 });
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
    $("compare-meta").innerHTML = "";
    $("compare-meta").textContent = `score ${m.score.toFixed(3)} · rotated ${thetaOf(m) > 0 ? "+" : ""}${Math.round(thetaOf(m))}°${mirrorText(m)}, ${m.side_km.toFixed(0)} km square · ${run.params.home ? fmtKm(haversineKm(run.params.home.lat, run.params.home.lon, m.dot_lat, m.dot_lon)) + " from home" : "drawn coastline"} · dot lands at ${fmtCoords(m.dot_lat, m.dot_lon)}`;
    const gmap = document.createElement("a");
    gmap.href = `https://www.google.com/maps/search/?api=1&query=${m.dot_lat.toFixed(5)},${m.dot_lon.toFixed(5)}`;
    gmap.target = "_blank"; gmap.rel = "noopener"; gmap.textContent = "open in Google Maps";
    $("compare-meta").append(" · ", gmap);
    $("compare-home-caption").textContent = `${drawn ? "Your drawing" : "Home"} · ${run.params.side_km} km square`;
    $("compare-match-caption").textContent = `${place}${m.mirror === "ns" ? " · mirrored north–south, labels off" : m.flip ? " · mirrored, labels off" : ""}`;
    for (const cm of [compare.home, compare.match]) for (const id of ["coast", "coast-ok"]) if (cm.getLayer(id)) { cm.setPaintProperty(id, "line-width", 2.5); cm.setPaintProperty(id, "line-opacity", 0.9); }
    if (m.vector) {
      const wanted = compare.index;
      loadFineOverlay(run, m).then((fine) => { if (compare.run === run && compare.index === wanted && $("compare-dialog").open) applyFineOverlay(run, m, fine); }).catch(() => {});
    }
    $("compare-prev").disabled = compare.index === 0;
    $("compare-next").disabled = compare.index >= compare.list.length - 1;
  }
  function shortName(name) {
    if (!name) return "";
    const parts = name.split(", ").map((x) => x.trim()).filter(Boolean);
    if (parts.length <= 3) return parts.join(", ");
    return `${parts[0]}, ${parts[parts.length - 1]}`;
  }
  function mapIdle(m) {
    return new Promise((resolve) => { if (m.loaded()) resolve(); else m.once("idle", resolve); });
  }
  function fitText(ctx, text, maxWidth, size, weight) {
    let s = size;
    do { ctx.font = `${weight} ${s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; s -= 2; } while (ctx.measureText(text).width > maxWidth && s > 14);
    return s + 2;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function drawPane(ctx, source, x, y, size, mirrored, dotCss, m) {
    const canvas = source.getCanvas();
    const cw = canvas.width, ch = canvas.height;
    const s = Math.min(cw, ch);
    const sx = (cw - s) / 2, sy = (ch - s) / 2;
    ctx.save();
    roundRect(ctx, x, y, size, size, 14);
    ctx.clip();
    if (mirrored) { ctx.translate(x + size, y); ctx.scale(-1, 1); ctx.drawImage(canvas, sx, sy, s, s, 0, 0, size, size); }
    else ctx.drawImage(canvas, sx, sy, s, s, x, y, size, size);
    ctx.restore();
    if (dotCss) {
      const container = source.getContainer();
      const scale = cw / container.clientWidth;
      let px = (dotCss.x * scale - sx) * size / s, py = (dotCss.y * scale - sy) * size / s;
      if (mirrored) px = size - px;
      if (px >= 0 && px <= size && py >= 0 && py <= size) {
        ctx.beginPath(); ctx.arc(x + px, y + py, 11, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
        ctx.beginPath(); ctx.arc(x + px, y + py, 7.5, 0, Math.PI * 2); ctx.fillStyle = "#d62728"; ctx.fill();
      }
    }
  }
  function drawCaption(ctx, text, x, y) {
    ctx.font = '600 20px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const w = ctx.measureText(text).width + 28;
    roundRect(ctx, x, y - 34, w, 36, 18);
    ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fill();
    ctx.fillStyle = "#1e232a"; ctx.textBaseline = "middle"; ctx.fillText(text, x + 14, y - 16);
  }
  async function buildShareCard() {
    const run = compare.run, m = compare.list[compare.index];
    if (!run || !m) return null;
    await Promise.all([compare.match.loaded() ? null : mapIdle(compare.match), run.params.center && !compare.home.loaded() ? mapIdle(compare.home) : null]);
    const W = 1600, gap = 28, header = 168, footer = 64;
    const pane = (W - 3 * gap) / 2;
    const H = header + pane + footer + gap;
    const card = document.createElement("canvas");
    card.width = W; card.height = H;
    const ctx = card.getContext("2d");
    ctx.fillStyle = "#f4f1ea"; ctx.fillRect(0, 0, W, H);
    const homeName = run.params.home ? shortName(run.params.home_name || fmtCoords(run.params.home.lat, run.params.home.lon)) : "A coastline I drew";
    const matchName = shortName(m.place || fmtCoords(m.dot_lat, m.dot_lon));
    ctx.fillStyle = "#145a86";
    ctx.font = '700 22px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'; ctx.textBaseline = "alphabetic";
    ctx.fillText("COASTLINE TWIN", gap, 44);
    ctx.fillStyle = "#1e232a";
    const title = `${homeName}  ↔  ${matchName}`;
    const size = fitText(ctx, title, W - 2 * gap, 46, 700);
    ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillText(title, gap, 98);
    ctx.fillStyle = "#6b7280";
    const apart = run.params.home ? ` · ${fmtKm(haversineKm(run.params.home.lat, run.params.home.lon, m.dot_lat, m.dot_lon))} apart` : "";
    const climateText = m.climate ? ` · climate ${run.home_climate ? run.home_climate + " → " : ""}${m.climate}` : "";
    const topLine = topShare(run, m) != null ? ` · ${fmtTop(topShare(run, m))} of run` : "";
    const line = `score ${m.score.toFixed(3)} · ${scoreLabel(m.score, run)[0]}${topLine} · rotated ${thetaOf(m) > 0 ? "+" : ""}${Math.round(thetaOf(m))}°${mirrorText(m)}, ${m.side_km.toFixed(0)} km square${apart}${climateText}`;
    ctx.font = `400 ${fitText(ctx, line, W - 2 * gap, 24, 400)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillText(line, gap, 140);
    const y = header;
    if (run.params.center) {
      const p0 = compare.home.project([run.params.home.lon, run.params.home.lat]);
      drawPane(ctx, compare.home, gap, y, pane, false, p0, m);
    } else {
      ctx.save(); roundRect(ctx, gap, y, pane, pane, 14); ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage($("compare-home-canvas"), gap, y, pane, pane);
      ctx.restore();
    }
    const p1 = compare.match.project([m.dot_lon, m.dot_lat]);
    drawPane(ctx, compare.match, gap * 2 + pane, y, pane, !!m.flip, p1, m);
    drawCaption(ctx, run.params.home ? `Home · ${run.params.side_km} km square` : `Your drawing · ${run.params.side_km} km square`, gap + 16, y + pane - 16);
    drawCaption(ctx, `${matchName}${m.mirror === "ns" ? " · mirrored north–south" : m.flip ? " · mirrored" : ""}`, gap * 2 + pane + 16, y + pane - 16);
    ctx.fillStyle = "#6b7280";
    ctx.font = '400 18px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = "alphabetic";
    const attribution = layerPrefs.basemap === "satellite" ? "Imagery © Esri, Maxar, Earthstar Geographics" : layerPrefs.basemap === "topo" ? "Map © OpenTopoMap (CC-BY-SA), data © OpenStreetMap contributors" : "Map data © OpenStreetMap contributors, © OpenMapTiles, tiles by OpenFreeMap";
    ctx.fillText(`silentoplayz.github.io/coastline-twin · ${attribution}`, gap, H - 24);
    return new Promise((resolve) => card.toBlob(resolve, "image/png"));
  }
  async function fetchMatchWindow(home, center, drawn, m) {
    const body = { home, center: drawn ? null : center, side_km: Number($("side-km").value), match: { center_lat: m.center_lat, center_lon: m.center_lon, theta: m.theta, flip: m.flip, scale: m.scale } };
    if (drawn) body.custom = customParams();
    const r = await api("/api/match-window", { method: "POST", body: JSON.stringify(body) });
    return r.window;
  }
  function comparisonLink(run, m) {
    const u = new URL(location.href);
    u.search = "";
    u.searchParams.set("side", String(run.params.side_km));
    if (run.params.home) {
      u.searchParams.set("lat", run.params.home.lat.toFixed(4));
      u.searchParams.set("lon", run.params.home.lon.toFixed(4));
      if (run.params.center && (Math.abs(run.params.center.lat - run.params.home.lat) > 1e-6 || Math.abs(run.params.center.lon - run.params.home.lon) > 1e-6)) {
        u.searchParams.set("clat", run.params.center.lat.toFixed(4));
        u.searchParams.set("clon", run.params.center.lon.toFixed(4));
      }
    } else if (run.template && run.template.land) {
      const n = run.template.n, land = landFrom(run.template.land);
      const bytes = new Uint8Array(Math.ceil(n * n / 8));
      for (let k = 0; k < n * n; k++) if (land[k]) bytes[k >> 3] |= 1 << (k & 7);
      const packed = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      u.searchParams.set("d", `${n}.${packed}`);
      const half = n * run.template.res / 2;
      u.searchParams.set("dot", `${Math.max(0, Math.min(n - 1, Math.floor((run.template.dot[0] + half) / run.template.res)))},${Math.max(0, Math.min(n - 1, Math.floor((half - run.template.dot[1]) / run.template.res)))}`);
    }
    u.searchParams.set("m", [m.center_lat.toFixed(4), m.center_lon.toFixed(4), m.theta.toFixed(1), m.flip ? 1 : 0, m.scale, m.score.toFixed(3), (m.mask_score || 0).toFixed(2), (m.coast_score || 0).toFixed(2)].join(","));
    if (m.place) u.searchParams.set("place", m.place);
    if (m.climate) u.searchParams.set("cl", m.climate);
    return u.toString();
  }
  async function copyComparisonLink() {
    const m = compare.list && compare.list[compare.index];
    if (!compare.run || !m) return;
    const link = comparisonLink(compare.run, m);
    try { await navigator.clipboard.writeText(link); toast("Link to this comparison copied"); }
    catch (e) { prompt("Copy this link", link); }
  }
  $("compare-link").addEventListener("click", copyComparisonLink);
  $("card-link").addEventListener("click", copyComparisonLink);
  async function openSharedComparison(q) {
    const parts = (q.get("m") || "").split(",").map(Number);
    if (parts.length < 5 || parts.some((v) => !isFinite(v))) return;
    const [clat, clon, theta, flipN, scale, score, mask, coast] = parts;
    for (let i = 0; i < 40 && !state.template; i++) await sleep(250);
    if (!state.template) return;
    const drawn = state.mode === "draw";
    const home = drawn ? null : state.home;
    const center = drawn ? null : effectiveCenter();
    const m = { rank: 1, center_lat: clat, center_lon: clon, theta, flip: flipN === 1, scale, score: isFinite(score) ? score : 0, mask_score: isFinite(mask) ? mask : 0, coast_score: isFinite(coast) ? coast : 0, side_km: Math.round(Number($("side-km").value) * scale * 10) / 10, place: q.get("place") || "", climate: q.get("cl") || null };
    const [mirror, thetaDisplay] = m.flip && Math.abs(theta) > 90 ? ["ns", ((theta - 180 + 180) % 360 + 360) % 360 - 180] : [m.flip ? "ew" : null, theta];
    m.mirror = mirror; m.theta_display = thetaDisplay;
    const frame = makeFrame(clat, clon);
    const h = Number($("side-km").value) * 500;
    m.square = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => { const [fx, fy] = forward(x, y, theta, m.flip, scale); const [la, lo] = toLatLon(frame, fx, fy); return [lo, la]; });
    m.square.push(m.square[0]);
    const t = state.template;
    const [qx, qy] = forward(t.dot[0], t.dot[1], theta, m.flip, scale);
    [m.dot_lat, m.dot_lon] = toLatLon(frame, qx, qy);
    try {
      const win = await fetchMatchWindow(home, center, drawn, m);
      m.window = win;
    } catch (e) {
      m.window = null;
    }
    const run = {
      id: "shared", label: "Shared comparison", started: Date.now(), seconds: 0, tiles: 0,
      params: { home, center, custom: drawn, home_name: null, side_km: Number($("side-km").value), band_px: 2 },
      template: { n: t.n, res: t.res, land: Array.from(t.land).join(""), dot: t.dot },
      matches: [m],
    };
    showRun(run);
    openCompare(run, 0);
  }
  const cardState = { blob: null, url: null };
  $("compare-share").addEventListener("click", async () => {
    $("compare-share").disabled = true;
    try {
      const blob = await buildShareCard();
      if (!blob) return;
      if (cardState.url) URL.revokeObjectURL(cardState.url);
      cardState.blob = blob;
      cardState.url = URL.createObjectURL(blob);
      $("card-image").src = cardState.url;
      $("card-share").hidden = !(navigator.canShare && navigator.canShare({ files: [new File([blob], "coastline-twin.png", { type: "image/png" })] }));
      $("card-dialog").showModal();
    } catch (err) {
      toast(`Could not build the card: ${err.message}`);
    } finally {
      $("compare-share").disabled = false;
    }
  });
  $("card-close").addEventListener("click", () => $("card-dialog").close());
  $("card-download").addEventListener("click", () => {
    if (!cardState.blob) return;
    const a = document.createElement("a");
    a.href = cardState.url; a.download = "coastline-twin.png"; a.click();
  });
  $("card-copy").addEventListener("click", async () => {
    if (!cardState.blob) return;
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": cardState.blob })]); toast("Image copied"); }
    catch (e) { toast("Copying images is not available here. Use Download instead."); }
  });
  $("card-share").addEventListener("click", async () => {
    if (!cardState.blob) return;
    try { await navigator.share({ files: [new File([cardState.blob], "coastline-twin.png", { type: "image/png" })], title: "Coastline Twin" }); } catch (e) {}
  });

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

  function restoreRunInputs(run) {
    $("side-km").value = run.params.side_km;
    $("side-out").textContent = run.params.side_km;
    if (run.params.home) {
      if (state.mode !== "place") setMode("place", { silent: true });
      if (!state.home || Math.abs(state.home.lat - run.params.home.lat) > 1e-6 || Math.abs(state.home.lon - run.params.home.lon) > 1e-6) setHome(run.params.home.lat, run.params.home.lon);
    } else if (run.template && run.template.land) {
      const t = { n: run.template.n, res: run.template.res, land: landFrom(run.template.land), dot: run.template.dot };
      const n = drawGridSize();
      const half = t.n * t.res / 2;
      setDrawing(n, resampleGrid(t.land, t.n, n), [Math.max(0, Math.min(n - 1, Math.floor((t.dot[0] + half) / (t.n * t.res) * n))), Math.max(0, Math.min(n - 1, Math.floor((half - t.dot[1]) / (t.n * t.res) * n)))]);
      setMode("draw");
    }
  }
  async function refreshRunsCount() {
    try {
      const runs = await api("/api/jobs");
      $("runs-count").textContent = runs.length ? String(runs.length) : "";
      return runs;
    } catch (e) {
      return [];
    }
  }
  $("runs-button").addEventListener("click", async () => {
    const runs = await refreshRunsCount();
    const body = $("runs-body");
    body.innerHTML = "";
    $("runs-empty").hidden = runs.length > 0;
    for (const r of runs) {
      const tr = document.createElement("tr");
      const home = r.params && r.params.home ? escapeHtml(r.params.home_name ? shortName(r.params.home_name) : fmtCoords(r.params.home.lat, r.params.home.lon)) : "drawn";
      const side = r.params && r.params.side_km ? `${r.params.side_km} km` : "";
      const top = r.top && r.top[0] ? `${escapeHtml(r.top[0].place || fmtCoords(r.top[0].dot_lat, r.top[0].dot_lon))} (${r.top[0].score.toFixed(3)})` : "";
      const progress = r.status === "running" && r.progress && r.progress.total ? ` ${Math.round(100 * r.progress.done / r.progress.total)}%` : "";
      tr.innerHTML = `
        <td><b>${escapeHtml(r.label || r.id)}</b><br><span class="muted small">${timeAgo(r.started * 1000)}</span></td>
        <td>${home}</td><td>${side}</td>
        <td><span class="status-pill ${r.status}">${r.status}${progress}</span></td>
        <td>${top}</td>
        <td class="actions"><button type="button" class="small" data-open="${r.id}">Open</button><button type="button" class="ghost small" data-delete="${r.id}">Delete</button></td>`;
      body.appendChild(tr);
    }
    body.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => { $("runs-dialog").close(); showJob(b.dataset.open); }));
    body.querySelectorAll("[data-delete]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Delete this run and its files?")) return;
      try {
        await api(`/api/jobs/${b.dataset.delete}`, { method: "DELETE" });
        b.closest("tr").remove();
        if (state.run && state.run.id === b.dataset.delete) { $("results").hidden = true; clearResults(); $("status").hidden = true; }
        refreshRunsCount();
      } catch (err) {
        toast(err.message);
      }
    }));
    $("runs-dialog").showModal();
  });
  $("runs-close").addEventListener("click", () => $("runs-dialog").close());
  $("tips-button").addEventListener("click", () => $("tips-dialog").showModal());
  $("tips-close").addEventListener("click", () => $("tips-dialog").close());

  async function init() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch (e) {}
    const q = new URLSearchParams(location.search);
    let savedDraw = null;
    try { savedDraw = JSON.parse(localStorage.getItem(DRAW_KEY) || "null"); } catch (e) {}
    if (savedDraw && savedDraw.land && savedDraw.n * savedDraw.n === savedDraw.land.length) setDrawing(savedDraw.n, landFrom(savedDraw.land), savedDraw.dot);
    let urlDraw = null;
    if (q.has("d")) {
      try {
        const [nText, packed] = q.get("d").split(".");
        const n = Number(nText);
        const dot = (q.get("dot") || "").split(",").map(Number);
        if (n >= 8 && n <= 256 && packed) urlDraw = { n, land: unpackDrawing(n, packed), dot: dot.length === 2 && dot.every(isFinite) ? dot : null, side: Number(q.get("side")) || 60 };
      } catch (e) {}
    }
    if (urlDraw) {
      $("side-km").value = urlDraw.side;
      $("side-out").textContent = $("side-km").value;
      setDrawing(urlDraw.n, urlDraw.land, urlDraw.dot);
    }
    if (q.has("lat") && q.has("lon") && isFinite(Number(q.get("lat"))) && isFinite(Number(q.get("lon")))) {
      saved = { home: { lat: Number(q.get("lat")), lon: Number(q.get("lon")) }, side: Number(q.get("side")) || 60, address: "" };
      if (q.has("clat") && q.has("clon")) { saved.centerMode = "custom"; saved.center = { lat: Number(q.get("clat")), lon: Number(q.get("clon")) }; }
    }
    if (saved && saved.home) {
      if (!urlDraw) $("side-km").value = saved.side || 60;
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
    if (urlDraw || (!q.has("lat") && saved && saved.mode === "draw")) setMode("draw", { silent: true });
    else if (draw.land) renderDrawing();
    if (state.mode === "draw") schedulePreview();
    if (q.has("m")) openSharedComparison(q);
    const runs = await refreshRunsCount();
    const running = runs.find((r) => r.status === "running");
    if (running) showJob(running.id);
  }
  init();
})();
