(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    home: null,
    center: null,
    centerMode: "home",
    bbox: null,
    previewTimer: null,
    previewSeq: 0,
    job: null,
    pollTimer: null,
    selected: null,
    matches: [],
  };

  const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  const map = L.map("map", { zoomControl: true, worldCopyJump: true }).setView([30, -20], 3);
  const tileLayer = L.tileLayer(TILE_URL, { attribution: ATTRIB, maxZoom: 19 }).addTo(map);
  const homeIcon = L.divIcon({ className: "pin-home", iconSize: [22, 22], iconAnchor: [11, 11] });
  const centerIcon = L.divIcon({ className: "pin-center", iconSize: [16, 16], iconAnchor: [8, 8] });
  const homeMarker = L.marker([0, 0], { icon: homeIcon, draggable: true, zIndexOffset: 1000 });
  const centerMarker = L.marker([0, 0], { icon: centerIcon, draggable: true, zIndexOffset: 900 });
  const squareLayer = L.polygon([], { color: "#d62728", weight: 2, fill: false, dashArray: "6 4" });
  const bboxLayer = L.rectangle([[0, 0], [0, 0]], { color: "#1f77b4", weight: 1, fill: true, fillOpacity: 0.04, dashArray: "2 6" });
  const resultLayer = L.layerGroup().addTo(map);
  const markersByRank = new Map();

  function currentScheme() {
    const cls = document.documentElement.classList;
    if (cls.contains("theme-dark")) return "dark";
    if (cls.contains("theme-light")) return "light";
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function applyTiles() {
    document.documentElement.classList.toggle("map-dark", currentScheme() === "dark");
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
  applyTiles();

  let toastTimer = null;
  function toast(msg, ms = 3500) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); msg = j.detail || msg; } catch (e) {}
      throw new Error(msg);
    }
    return res.json();
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
    const d = (Date.now() / 1000) - ts;
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.floor(d / 60)} min ago`;
    if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
    return new Date(ts * 1000).toLocaleDateString();
  }

  function squareCorners(lat, lon, sideKm) {
    const half = sideKm * 500;
    const dlat = half / 111320;
    const dlon = half / (111320 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
    return [[lat - dlat, lon - dlon], [lat - dlat, lon + dlon], [lat + dlat, lon + dlon], [lat + dlat, lon - dlon]];
  }

  function effectiveCenter() {
    return state.centerMode === "custom" && state.center ? state.center : state.home;
  }

  function saveSettings() {
    try {
      localStorage.setItem("coastline-twin", JSON.stringify({
        home: state.home, center: state.center, centerMode: state.centerMode,
        side: $("side-km").value, address: $("address").value,
      }));
    } catch (e) {}
  }

  function drawSquare() {
    const c = effectiveCenter();
    if (!c) return;
    squareLayer.setLatLngs(squareCorners(c.lat, c.lon, Number($("side-km").value)));
    if (!map.hasLayer(squareLayer)) squareLayer.addTo(map);
    if (state.centerMode === "custom") {
      centerMarker.setLatLng([c.lat, c.lon]);
      if (!map.hasLayer(centerMarker)) centerMarker.addTo(map);
    } else if (map.hasLayer(centerMarker)) {
      map.removeLayer(centerMarker);
    }
  }

  let reverseTimer = null;
  function setHome(lat, lon, { pan = false, address = null } = {}) {
    lat = Math.max(-90, Math.min(90, lat));
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    state.home = { lat, lon };
    $("home-lat").value = fmt(lat);
    $("home-lon").value = fmt(lon);
    homeMarker.setLatLng([lat, lon]);
    if (!map.hasLayer(homeMarker)) homeMarker.addTo(map);
    if (pan) map.flyTo([lat, lon], Math.max(map.getZoom(), 8), { duration: 0.8 });
    $("map-hint").classList.add("faded");
    if (address) {
      $("home-address").textContent = address;
    } else {
      $("home-address").textContent = "Looking up address…";
      clearTimeout(reverseTimer);
      reverseTimer = setTimeout(async () => {
        try {
          const r = await api(`/api/reverse?lat=${lat}&lon=${lon}`);
          $("home-address").textContent = r.name || "No address here";
        } catch (e) {
          $("home-address").textContent = "Address lookup unavailable";
        }
      }, 400);
    }
    if (state.centerMode !== "custom" || !state.center) state.center = { lat, lon };
    drawSquare();
    schedulePreview();
    $("run-button").disabled = false;
    saveSettings();
  }

  homeMarker.on("dragend", () => { const p = homeMarker.getLatLng(); setHome(p.lat, p.lng); });
  centerMarker.on("drag", () => { const p = centerMarker.getLatLng(); state.center = { lat: p.lat, lon: p.lng }; drawSquare(); });
  centerMarker.on("dragend", () => { schedulePreview(); saveSettings(); });
  map.on("click", (e) => setHome(e.latlng.lat, e.latlng.lng));

  $("home-lat").addEventListener("change", () => setHome(Number($("home-lat").value), Number($("home-lon").value || 0), { pan: true }));
  $("home-lon").addEventListener("change", () => setHome(Number($("home-lat").value || 0), Number($("home-lon").value), { pan: true }));

  document.querySelectorAll('input[name="center-mode"]').forEach((r) => r.addEventListener("change", () => {
    state.centerMode = r.value;
    if (state.centerMode === "custom" && state.home && !state.center) state.center = { ...state.home };
    drawSquare();
    schedulePreview();
    saveSettings();
  }));

  $("side-km").addEventListener("input", () => {
    $("side-out").textContent = $("side-km").value;
    drawSquare();
    schedulePreview();
    saveSettings();
  });
  $("detail-weight").addEventListener("input", () => { $("detail-out").textContent = $("detail-weight").value; });

  const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/;
  $("search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("address").value.trim();
    const list = $("geocode-results");
    list.innerHTML = "";
    list.hidden = true;
    if (!q) return;
    const m = q.match(COORD_RE);
    if (m) {
      setHome(Number(m[1]), Number(m[2]), { pan: true });
      return;
    }
    $("search-button").disabled = true;
    try {
      const rows = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
      if (!rows.length) { toast("Nothing found for that search"); return; }
      if (rows.length === 1) {
        setHome(rows[0].lat, rows[0].lon, { pan: true, address: rows[0].name });
        return;
      }
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function previewBody() {
    const body = { home: state.home, side_km: Number($("side-km").value) };
    if (state.centerMode === "custom" && state.center) body.center = state.center;
    const res = $("res-m").value;
    if (res) body.res_m = Number(res);
    return body;
  }

  function schedulePreview() {
    if (!state.home) return;
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(runPreview, 700);
  }

  async function runPreview() {
    if (!state.home) return;
    const seq = ++state.previewSeq;
    $("preview-empty").hidden = false;
    $("preview-empty").textContent = "Rendering the square…";
    $("preview-warning").hidden = true;
    try {
      const info = await api("/api/preview", { method: "POST", body: JSON.stringify(previewBody()) });
      if (seq !== state.previewSeq) return;
      $("preview-img").src = info.image + "?t=" + Date.now();
      $("preview-img").hidden = false;
      $("preview-empty").hidden = true;
      $("preview-stats").hidden = false;
      $("stat-pixels").textContent = `${info.stats.pixels}²`;
      $("stat-land").textContent = `${Math.round(info.stats.land_fraction * 100)}%`;
      $("stat-coast").textContent = info.stats.coast_ratio.toFixed(2);
      $("stat-tiles").textContent = info.tiles;
      if (info.warnings && info.warnings.length) {
        $("preview-warning").textContent = info.warnings.join(" ");
        $("preview-warning").hidden = false;
      }
    } catch (err) {
      if (seq !== state.previewSeq) return;
      $("preview-img").hidden = true;
      $("preview-stats").hidden = true;
      $("preview-empty").hidden = false;
      $("preview-empty").textContent = err.message;
    }
  }

  $("bbox-set").addEventListener("click", () => {
    const b = map.getBounds();
    state.bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
    bboxLayer.setBounds(b);
    if (!map.hasLayer(bboxLayer)) bboxLayer.addTo(map);
    $("bbox-text").textContent = `Only ${fmt(state.bbox[0], 1)}…${fmt(state.bbox[2], 1)} lat, ${fmt(state.bbox[1], 1)}…${fmt(state.bbox[3], 1)} lon`;
    $("bbox-clear").hidden = false;
  });
  $("bbox-clear").addEventListener("click", () => {
    state.bbox = null;
    if (map.hasLayer(bboxLayer)) map.removeLayer(bboxLayer);
    $("bbox-text").textContent = "Whole planet";
    $("bbox-clear").hidden = true;
  });

  function jobBody() {
    const body = previewBody();
    const scales = [...document.querySelectorAll('input[name="scale"]:checked')].map((c) => Number(c.value));
    Object.assign(body, {
      rot_max: Number($("rot-max").value),
      rot_step: Number($("rot-max").value) >= 180 ? 20 : 15,
      scales: scales.length ? scales : [1],
      flip: $("flip").checked,
      top: Number($("top").value) || 15,
      min_score: Number($("min-score").value) || 0.5,
      detail_weight: Number($("detail-weight").value),
      same_hemisphere: $("same-hemisphere").checked,
      lat_band: $("lat-band").value === "" ? null : Number($("lat-band").value),
      bbox: state.bbox,
      exclude_km: $("exclude-km").value === "" ? null : Number($("exclude-km").value),
      workers: $("workers").value === "" ? null : Number($("workers").value),
      label: $("label").value.trim() || null,
    });
    return body;
  }

  $("run-button").addEventListener("click", async () => {
    if (!state.home) return;
    $("run-button").disabled = true;
    try {
      const job = await api("/api/jobs", { method: "POST", body: JSON.stringify(jobBody()) });
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
      renderStatus(job);
    } catch (err) {
      toast(err.message);
    }
  });

  function attachJob(job) {
    state.job = job;
    renderStatus(job);
    clearInterval(state.pollTimer);
    if (job.status === "running" || job.status === "cancelling") {
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
      renderStatus(job);
      if (job.status !== "running" && job.status !== "cancelling") {
        clearInterval(state.pollTimer);
        $("run-button").disabled = !state.home;
        if (job.status === "done") {
          toast(`Done: ${job.count} matches in ${fmtDuration(job.seconds)}`);
          renderResults(job);
        } else {
          toast(job.error || `Run ${job.status}`);
        }
        refreshRunsCount();
      }
    } catch (err) {
      clearInterval(state.pollTimer);
      toast(err.message);
      $("run-button").disabled = !state.home;
    }
  }

  function renderStatus(job) {
    const box = $("status");
    box.hidden = false;
    box.classList.remove("done", "failed");
    const p = job.progress || { done: 0, total: 0 };
    const pct = p.total ? Math.round(100 * p.done / p.total) : 0;
    $("status-progress").value = pct;
    $("cancel-button").hidden = job.status !== "running";
    if (job.status === "running") {
      $("status-label").textContent = p.total ? `Searching… ${pct}%` : "Preparing the search…";
      const eta = p.eta != null ? `, about ${fmtDuration(p.eta)} left` : "";
      $("status-text").textContent = p.total ? `${p.done} of ${p.total} tiles, ${fmtDuration(p.elapsed)} elapsed${eta}` : "Building the template and its variants";
    } else if (job.status === "cancelling") {
      $("status-label").textContent = "Stopping…";
    } else if (job.status === "done") {
      box.classList.add("done");
      $("status-label").textContent = "Done";
      $("status-progress").value = 100;
      $("status-text").textContent = `${job.count} matches from ${job.template ? job.template.tiles : "?"} tiles in ${fmtDuration(job.seconds)}`;
    } else {
      box.classList.add("failed");
      $("status-label").textContent = job.status === "cancelled" ? "Cancelled" : "Failed";
      $("status-text").textContent = job.error || "";
    }
  }

  async function showJob(id) {
    try {
      const job = await api(`/api/jobs/${id}`);
      state.job = job;
      renderStatus(job);
      if (job.status === "running" || job.status === "cancelling") {
        clearInterval(state.pollTimer);
        state.pollTimer = setInterval(pollJob, 1000);
        $("run-button").disabled = true;
      } else if (job.status === "done") {
        renderResults(job);
      }
      if (job.params && job.params.home) {
        const h = job.params.home;
        if (!state.home || Math.abs(state.home.lat - h.lat) > 1e-6 || Math.abs(state.home.lon - h.lon) > 1e-6) {
          $("side-km").value = job.params.side_km;
          $("side-out").textContent = job.params.side_km;
          setHome(h.lat, h.lon, { pan: false });
        }
      }
    } catch (err) {
      toast(err.message);
    }
  }

  function clearResults() {
    resultLayer.clearLayers();
    markersByRank.clear();
    state.matches = [];
    state.selected = null;
  }

  function renderResults(job) {
    clearResults();
    const matches = job.matches || [];
    state.matches = matches;
    $("results").hidden = false;
    $("results-title").textContent = job.label || job.id;
    const meta = job.meta || {};
    const bits = [];
    if (meta.side_km) bits.push(`${meta.side_km} km square`);
    if (meta.tiles) bits.push(`${meta.tiles} tiles`);
    if (meta.seconds) bits.push(fmtDuration(meta.seconds));
    if (meta.filters) {
      if (meta.filters.same_hemisphere) bits.push("same hemisphere");
      if (meta.filters.lat_band != null) bits.push(`±${meta.filters.lat_band}° latitude`);
      if (meta.filters.bbox) bits.push("region limited");
    }
    $("results-meta").textContent = bits.join(" · ");
    const list = $("match-list");
    list.innerHTML = "";
    const bounds = [];
    for (const m of matches) {
      const li = document.createElement("li");
      li.className = "match";
      li.dataset.rank = m.rank;
      const place = m.place || fmtCoords(m.dot_lat, m.dot_lon);
      const flip = m.flip ? ", mirrored" : "";
      const osm = `https://www.openstreetmap.org/?mlat=${m.dot_lat.toFixed(5)}&mlon=${m.dot_lon.toFixed(5)}#map=11/${m.dot_lat.toFixed(5)}/${m.dot_lon.toFixed(5)}`;
      const gm = `https://www.google.com/maps/search/?api=1&query=${m.dot_lat.toFixed(5)},${m.dot_lon.toFixed(5)}`;
      li.innerHTML = `
        <div class="rank">${m.rank}</div>
        <div class="place">${escapeHtml(place)}</div>
        <div class="score">${m.score.toFixed(3)}</div>
        <div class="detail">rotated ${m.theta > 0 ? "+" : ""}${Math.round(m.theta)}°${flip}, ${m.side_km.toFixed(0)} km square · dot at ${fmtCoords(m.dot_lat, m.dot_lon)}</div>
        <div class="bars"><span>mask</span><div class="bar"><i style="width:${Math.max(0, m.mask_score) * 100}%"></i></div><span>coast</span><div class="bar"><i style="width:${Math.max(0, m.coast_score) * 100}%"></i></div></div>
        <div class="links"><a href="${osm}" target="_blank" rel="noopener">OpenStreetMap</a><a href="${gm}" target="_blank" rel="noopener">Google Maps</a></div>`;
      li.addEventListener("click", (e) => { if (e.target.tagName !== "A") selectMatch(m.rank, true); });
      list.appendChild(li);

      const icon = L.divIcon({ className: "pin-match", html: String(m.rank), iconSize: [26, 26], iconAnchor: [13, 13] });
      const marker = L.marker([m.dot_lat, m.dot_lon], { icon, title: place }).addTo(resultLayer);
      marker.bindPopup(`<b>#${m.rank} ${escapeHtml(place)}</b><br>score ${m.score.toFixed(3)}<br>${fmtCoords(m.dot_lat, m.dot_lon)}`);
      marker.on("click", () => selectMatch(m.rank, false));
      const poly = L.polygon(m.square.map(([lon, lat]) => [lat, lon]), { color: "#d62728", weight: 1.5, fill: false, opacity: 0.8 }).addTo(resultLayer);
      markersByRank.set(m.rank, { marker, poly, li });
      bounds.push([m.dot_lat, m.dot_lon]);
    }
    if (state.home) bounds.push([state.home.lat, state.home.lon]);
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 6 });
    switchTab("matches");
    if (job.files) {
      $("sheet-img").src = job.files.sheet + "?t=" + Date.now();
      $("file-list").innerHTML = [
        ["report", "HTML report"], ["sheet", "Contact sheet (PNG)"], ["template", "Home square (PNG)"],
        ["json", "Matches (JSON)"], ["geojson", "Matches (GeoJSON)"],
      ].map(([k, label]) => `<li><a href="${job.files[k]}" target="_blank" rel="noopener">${label}</a></li>`).join("");
    }
  }

  function selectMatch(rank, fly) {
    if (state.selected && markersByRank.has(state.selected)) {
      const prev = markersByRank.get(state.selected);
      prev.li.classList.remove("selected");
      prev.marker.getElement()?.classList.remove("selected");
    }
    state.selected = rank;
    const cur = markersByRank.get(rank);
    if (!cur) return;
    cur.li.classList.add("selected");
    cur.marker.getElement()?.classList.add("selected");
    cur.li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (fly) {
      map.flyToBounds(cur.poly.getBounds().pad(0.6), { duration: 0.9 });
      cur.marker.openPopup();
    }
  }

  document.querySelectorAll(".tabs [role=tab]").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  function switchTab(name) {
    document.querySelectorAll(".tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    for (const page of ["matches", "sheet", "files"]) $(`tab-${page}`).hidden = page !== name;
  }
  $("results-close").addEventListener("click", () => { $("results").hidden = true; clearResults(); });

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
      const home = r.params && r.params.home ? fmtCoords(r.params.home.lat, r.params.home.lon) : "";
      const side = r.params && r.params.side_km ? `${r.params.side_km} km` : "";
      const top = r.top && r.top[0] ? `${escapeHtml(r.top[0].place || fmtCoords(r.top[0].dot_lat, r.top[0].dot_lon))} (${r.top[0].score.toFixed(3)})` : "";
      const progress = r.status === "running" && r.progress && r.progress.total ? ` ${Math.round(100 * r.progress.done / r.progress.total)}%` : "";
      tr.innerHTML = `
        <td><b>${escapeHtml(r.label || r.id)}</b><br><span class="muted small">${timeAgo(r.started)}</span></td>
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
        if (state.job && state.job.id === b.dataset.delete) { $("results").hidden = true; clearResults(); $("status").hidden = true; }
        refreshRunsCount();
      } catch (err) {
        toast(err.message);
      }
    }));
    $("runs-dialog").showModal();
  });
  $("runs-close").addEventListener("click", () => $("runs-dialog").close());

  async function init() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem("coastline-twin") || "null"); } catch (e) {}
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
      map.setView([saved.home.lat, saved.home.lon], 8);
    }
    const runs = await refreshRunsCount();
    const running = runs.find((r) => r.status === "running");
    if (running) showJob(running.id);
  }
  init();
})();
