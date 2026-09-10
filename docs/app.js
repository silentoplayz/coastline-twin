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
    container: "map", style: STYLES[currentScheme()], center: [-20, 30], zoom: 1.6,
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
    const url = STYLES[scheme];
    if (map.__styleUrl !== url) { map.__styleUrl = url; map.setStyle(url); }
    for (const cm of [compare.home, compare.match]) if (cm && cm.__styleUrl !== url) { cm.__styleUrl = url; cm.setStyle(url); }
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
  map.__styleUrl = STYLES[currentScheme()];

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
    const half = sideKm * 500;
    const dlat = half / 111320;
    const dlon = half / (111320 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
    return [[lat - dlat, lon - dlon], [lat - dlat, lon + dlon], [lat + dlat, lon + dlon], [lat + dlat, lon - dlon]];
  }
  function effectiveCenter() { return state.centerMode === "custom" && state.center ? state.center : state.home; }
  function saveSettings() {
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
  $("search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("address").value.trim();
    const list = $("geocode-results");
    list.innerHTML = "";
    list.hidden = true;
    if (!q) return;
    const m = q.match(COORD_RE);
    if (m) { setHome(Number(m[1]), Number(m[2]), { pan: true }); return; }
    $("search-button").disabled = true;
    try {
      const rows = await geocode(q);
      if (!rows.length) { toast("Nothing found for that search"); return; }
      if (rows.length === 1) { setHome(rows[0].lat, rows[0].lon, { pan: true, address: rows[0].name }); return; }
      for (const r of rows) {
        const li = document.createElement("li");
        li.tabIndex = 0;
        li.innerHTML = `<div>${escapeHtml(r.name)}</div><div class="type">${escapeHtml(r.type)}</div>`;
        const pick = () => { list.hidden = true; $("address").value = r.name; setHome(r.lat, r.lon, { pan: true, address: r.name }); };
        li.addEventListener("click", pick);
        li.addEventListener("keydown", (ev) => { if (ev.key === "Enter") pick(); });
        list.appendChild(li);
      }
      list.hidden = false;
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
    const fine_res = Math.max(1000, side_m / 64);
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
      supersample: 2, band_px: 1, detail_weight: Number($("detail-weight").value), variance_floor: 0.3,
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
      const res = await pool.call(0, { type: "prepare", params: p });
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
          detail_weight: p.detail_weight, same_hemisphere: p.same_hemisphere, lat_band: p.lat_band, bbox: p.bbox, quality: p.quality, min_score: p.min_score },
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
  function showRun(run) {
    clearResults();
    state.run = run;
    const t = { n: run.template.n, res: run.template.res, land: landFrom(run.template.land), dot: run.template.dot };
    const dot = dotPixel(t);
    const matches = run.matches;
    state.matches = matches;
    $("results").hidden = false;
    $("results-title").textContent = run.label;
    const bits = [`${run.params.side_km} km square`, `${run.tiles} tiles`, fmtDuration(run.seconds)];
    if (run.params.same_hemisphere) bits.push("same hemisphere");
    if (run.params.lat_band != null) bits.push(`±${run.params.lat_band}° latitude`);
    if (run.params.bbox) bits.push("region limited");
    $("results-meta").textContent = bits.join(" · ");
    const list = $("match-list");
    list.innerHTML = "";
    const sheet = $("sheet");
    sheet.innerHTML = "";
    const bounds = [];
    const squares = [];
    for (const m of matches) {
      const place = m.place || fmtCoords(m.dot_lat, m.dot_lon);
      const flip = m.flip ? ", mirrored" : "";
      const osm = `https://www.openstreetmap.org/?mlat=${m.dot_lat.toFixed(5)}&mlon=${m.dot_lon.toFixed(5)}#map=11/${m.dot_lat.toFixed(5)}/${m.dot_lon.toFixed(5)}`;
      const gm = `https://www.google.com/maps/search/?api=1&query=${m.dot_lat.toFixed(5)},${m.dot_lon.toFixed(5)}`;
      const li = document.createElement("li");
      li.className = "match";
      li.innerHTML = `
        <div class="rank">${m.rank}</div>
        <div class="place">${escapeHtml(place)}</div>
        <div class="score">${m.score.toFixed(3)}</div>
        <div class="detail">rotated ${m.theta > 0 ? "+" : ""}${Math.round(m.theta)}°${flip}, ${m.side_km.toFixed(0)} km square · dot at ${fmtCoords(m.dot_lat, m.dot_lon)}</div>
        <div class="bars"><span>mask</span><div class="bar"><i style="width:${Math.max(0, m.mask_score) * 100}%"></i></div><span>coast</span><div class="bar"><i style="width:${Math.max(0, m.coast_score) * 100}%"></i></div></div>
        <div class="strip"><div><canvas></canvas><span>home</span></div><div><canvas></canvas><span>match</span></div><div><canvas></canvas><span>overlay</span></div></div>
        <div class="links"><a href="${osm}" target="_blank" rel="noopener">OpenStreetMap</a><a href="${gm}" target="_blank" rel="noopener">Google Maps</a><button type="button" class="small" data-compare="${m.rank}">Compare</button></div>`;
      const win = landFrom(m.window);
      const cv = li.querySelectorAll("canvas");
      drawMask(cv[0], t.land, t.n, dot);
      drawMask(cv[1], win, t.n, dot);
      drawMask(cv[2], win, t.n, dot, t.land);
      li.addEventListener("click", (e) => { if (e.target.tagName !== "A" && e.target.tagName !== "BUTTON") selectMatch(m.rank, true); });
      li.querySelector("[data-compare]").addEventListener("click", () => openCompare(run, m.rank - 1));
      list.appendChild(li);

      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<div class="title">#${m.rank} ${escapeHtml(place)} · ${m.score.toFixed(3)}</div><div class="muted small">rotated ${m.theta > 0 ? "+" : ""}${Math.round(m.theta)}°${flip}, ${m.side_km.toFixed(0)} km square · <a href="#" data-compare>compare on the map</a></div>
        <div class="strip"><div><canvas></canvas><span>home</span></div><div><canvas></canvas><span>match</span></div><div><canvas></canvas><span>overlay</span></div></div>`;
      const cs = row.querySelectorAll("canvas");
      drawMask(cs[0], t.land, t.n, dot);
      drawMask(cs[1], win, t.n, dot);
      drawMask(cs[2], win, t.n, dot, t.land);
      row.querySelector("[data-compare]").addEventListener("click", (e) => { e.preventDefault(); openCompare(run, m.rank - 1); });
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
    }
    setOverlay("match-squares", squares);
    if (run.params.home) bounds.push([run.params.home.lon, run.params.home.lat]);
    switchTab("matches");
    requestAnimationFrame(() => {
      map.resize();
      if (bounds.length) map.fitBounds(boundsOf(bounds), { padding: 50, maxZoom: 6, duration: 900 });
    });
    renderFiles(run, t);
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

  const compare = { home: null, match: null, run: null, index: 0, dots: [] };
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
    ]) {
      if (!m.getSource(id)) m.addSource(id, { type: "geojson", data: m.__data && m.__data[id] || { type: "FeatureCollection", features: [] } });
      if (!m.getLayer(id)) m.addLayer({ id, type: "line", source: id, paint });
    }
    m.setLayoutProperty("coast", "visibility", $("compare-coast").checked ? "visible" : "none");
    setLabels(m, m.__labels !== false);
  }
  function ensureCompareMaps() {
    if (compare.home) return;
    for (const key of ["home", "match"]) {
      const m = new maplibregl.Map({ container: `compare-${key}`, style: STYLES[currentScheme()], interactive: false, attributionControl: false });
      m.__styleUrl = STYLES[currentScheme()];
      m.on("style.load", () => compareLayers(m));
      compare[key] = m;
    }
  }
  function setCompareData(m, data) {
    m.__data = data;
    for (const [id, fc] of Object.entries(data)) { const src = m.getSource(id); if (src) src.setData(fc); }
  }
  function openCompare(run, index) {
    if (!webgl) { toast("The comparison view needs WebGL, which this browser does not provide."); return; }
    compare.run = run;
    compare.index = Math.max(0, Math.min(run.matches.length - 1, index));
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
    if (!run) return;
    const m = run.matches[compare.index];
    const t = run.template;
    const land = landFrom(t.land);
    const homeFrame = makeFrame(run.params.center.lat, run.params.center.lon);
    const matchFrame = makeFrame(m.center_lat, m.center_lon);
    const segs = coastSegments(land, t.n, t.res);
    const toLonLat = (frame, x, y) => { const [la, lo] = toLatLon(frame, x, y); return [lo, la]; };
    const homeCoast = { type: "Feature", geometry: { type: "MultiLineString", coordinates: segs.map((seg) => seg.map(([x, y]) => toLonLat(homeFrame, x, y))) } };
    const matchCoast = { type: "Feature", geometry: { type: "MultiLineString", coordinates: segs.map((seg) => seg.map(([x, y]) => { const [qx, qy] = forward(x, y, m.theta, m.flip, m.scale); return toLonLat(matchFrame, qx, qy); })) } };
    const h = t.n * t.res / 2;
    const homeSquare = polygonFeature([[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].map(([x, y]) => toLonLat(homeFrame, x, y)));
    const matchSquare = polygonFeature(m.square);
    setCompareData(compare.home, { square: { type: "FeatureCollection", features: [homeSquare] }, coast: { type: "FeatureCollection", features: [homeCoast] } });
    setCompareData(compare.match, { square: { type: "FeatureCollection", features: [matchSquare] }, coast: { type: "FeatureCollection", features: [matchCoast] } });
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
    for (const cm of [compare.home, compare.match]) if (cm.getLayer("coast")) cm.setLayoutProperty("coast", "visibility", $("compare-coast").checked ? "visible" : "none");
    const place = m.place || fmtCoords(m.dot_lat, m.dot_lon);
    $("compare-title").textContent = `#${m.rank} ${place}`;
    $("compare-meta").textContent = `score ${m.score.toFixed(3)} · rotated ${m.theta > 0 ? "+" : ""}${Math.round(m.theta)}°${m.flip ? ", mirrored" : ""}, ${m.side_km.toFixed(0)} km square · dot lands at ${fmtCoords(m.dot_lat, m.dot_lon)}`;
    $("compare-home-caption").textContent = `Home · ${run.params.side_km} km square`;
    $("compare-match-caption").textContent = `${place}${m.flip ? " · mirrored, labels off" : ""}`;
    $("compare-prev").disabled = compare.index === 0;
    $("compare-next").disabled = compare.index >= run.matches.length - 1;
  }
  $("compare-close").addEventListener("click", () => $("compare-dialog").close());
  $("compare-prev").addEventListener("click", () => { compare.index--; renderCompare(); });
  $("compare-next").addEventListener("click", () => { compare.index++; renderCompare(); });
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

  function init() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch (e) {}
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
