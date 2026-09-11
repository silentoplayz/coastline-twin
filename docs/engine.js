importScripts("geo.js", "fft.js");

let INDEX = null;
let BASE = "";
const TILES = new Map();
const PENDING = new Map();
const FFTS = new Map();

function fft(n) {
  if (!FFTS.has(n)) FFTS.set(n, new FFT2D(n));
  return FFTS.get(n);
}

async function loadIndex(base) {
  BASE = base;
  const res = await fetch(base + "data/index.json");
  if (!res.ok) throw new Error("could not load data/index.json");
  INDEX = await res.json();
}

function tileKey(i, j) {
  return i * INDEX.cols + j;
}

async function loadTile(i, j) {
  const key = tileKey(i, j);
  if (TILES.has(key)) return;
  if (PENDING.has(key)) return PENDING.get(key);
  const p = (async () => {
    if (INDEX.classes[i][j] !== 2) {
      TILES.set(key, null);
      return;
    }
    const T = INDEX.tile;
    const res = await fetch(`${BASE}data/tiles/r${i}_c${j}.png`);
    if (!res.ok) throw new Error(`tile r${i}_c${j} missing`);
    const bitmap = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(T, T);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, T, T).data;
    const bits = new Uint8Array((T * T) >> 3);
    for (let k = 0; k < T * T; k++) if (data[k * 4] > 127) bits[k >> 3] |= 1 << (k & 7);
    bitmap.close();
    TILES.set(key, bits);
  })();
  PENDING.set(key, p);
  await p;
  PENDING.delete(key);
}

async function ensureRegion(latMin, latMax, lonMin, lonMax) {
  const T = INDEX.tile;
  const degPerTile = Math.abs(INDEX.dlat) * T;
  const rowOf = (lat) => Math.min(INDEX.rows - 1, Math.max(0, Math.floor((lat - INDEX.lat0) / INDEX.dlat / T)));
  const r0 = rowOf(latMax), r1 = rowOf(latMin);
  const jobs = [];
  const allLon = lonMax - lonMin >= 360;
  for (let i = r0; i <= r1; i++) {
    if (allLon) {
      for (let j = 0; j < INDEX.cols; j++) jobs.push(loadTile(i, j));
    } else {
      const c0 = Math.floor((lonMin - INDEX.lon0) / degPerTile);
      const c1 = Math.floor((lonMax - INDEX.lon0) / degPerTile);
      for (let c = c0; c <= c1; c++) jobs.push(loadTile(i, ((c % INDEX.cols) + INDEX.cols) % INDEX.cols));
    }
  }
  await Promise.all(jobs);
}

function landAt(lat, lon) {
  const T = INDEX.tile;
  let li = Math.trunc((lat - INDEX.lat0) / INDEX.dlat);
  const maxRow = INDEX.rows * T - 1;
  if (li < 0) li = 0; else if (li > maxRow) li = maxRow;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  let lo = Math.trunc((lon - INDEX.lon0) / INDEX.dlon);
  const maxCol = INDEX.cols * T - 1;
  if (lo < 0) lo = 0; else if (lo > maxCol) lo = maxCol;
  const ti = (li / T) | 0, tj = (lo / T) | 0;
  const cls = INDEX.classes[ti][tj];
  if (cls !== 2) return cls;
  const bits = TILES.get(ti * INDEX.cols + tj);
  if (!bits) throw new Error(`tile r${ti}_c${tj} not loaded`);
  const idx = (li - ti * T) * T + (lo - tj * T);
  return (bits[idx >> 3] >> (idx & 7)) & 1;
}



function regionOf(frame, halfM) {
  const dlat = halfM / 111195 + 0.3;
  const latMin = Math.max(-90, frame.lat0 - dlat), latMax = Math.min(90, frame.lat0 + dlat);
  const near = Math.min(Math.abs(latMin), Math.abs(latMax));
  const cosv = Math.cos(Math.max(Math.abs(latMin), Math.abs(latMax)) * D2R);
  if (Math.max(Math.abs(latMin), Math.abs(latMax)) > 84 || cosv < 0.02) return [latMin, latMax, -180, 180];
  const dlon = dlat / cosv;
  if (dlon >= 180) return [latMin, latMax, -180, 180];
  return [latMin, latMax, frame.lon0 - dlon, frame.lon0 + dlon];
}

function sampleGrid(frame, n, resM, ss) {
  const out = new Float32Array(n * n);
  const half = n * resM / 2;
  const subs = [];
  for (let k = 0; k < ss; k++) subs.push(((k + 0.5) / ss - 0.5) * resM);
  const inv = 1 / (ss * ss);
  for (let r = 0; r < n; r++) {
    const v = half - (r + 0.5) * resM;
    for (let c = 0; c < n; c++) {
      const u = -half + (c + 0.5) * resM;
      let acc = 0;
      for (const du of subs) for (const dv of subs) {
        const ll = toLatLon(frame, u + du, v + dv);
        acc += landAt(ll[0], ll[1]);
      }
      out[r * n + c] = acc * inv;
    }
  }
  return out;
}

function coastBand(binary, valid, n, width) {
  const coast = new Uint8Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const k = r * n + c;
    if (valid && !valid[k]) continue;
    if (r + 1 < n && (!valid || valid[k + n]) && binary[k] !== binary[k + n]) { coast[k] = 1; coast[k + n] = 1; }
    if (c + 1 < n && (!valid || valid[k + 1]) && binary[k] !== binary[k + 1]) { coast[k] = 1; coast[k + 1] = 1; }
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
  if (valid) for (let k = 0; k < n * n; k++) if (!valid[k]) cur[k] = 0;
  return cur;
}

function continuity(homeCoast, matchBand, n, runFull) {
  const matched = new Uint8Array(n * n);
  let total = 0;
  for (let k = 0; k < n * n; k++) if (homeCoast[k]) { total++; if (matchBand[k]) matched[k] = 1; }
  if (!total) return { continuity: 0, longest: 0, matched: 0 };
  const seen = new Uint8Array(n * n);
  const stack = new Int32Array(n * n);
  let acc = 0, longest = 0, matchedCount = 0;
  for (let start = 0; start < n * n; start++) {
    if (!matched[start] || seen[start]) continue;
    let top = 0, size = 0;
    stack[top++] = start;
    seen[start] = 1;
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
    matchedCount += size;
    acc += size * Math.min(1, size / runFull);
    if (size > longest) longest = size;
  }
  return { continuity: acc / total, longest, matched: matchedCount / total };
}

function zeroMean(values, valid, n) {
  let sum = 0, count = 0;
  for (let k = 0; k < n * n; k++) if (!valid || valid[k]) { sum += values[k]; count++; }
  const mean = count ? sum / count : 0;
  const out = new Float64Array(n * n);
  let norm = 0;
  for (let k = 0; k < n * n; k++) if (!valid || valid[k]) { out[k] = values[k] - mean; norm += out[k] * out[k]; }
  return { values: out, norm: Math.sqrt(norm), count, mean };
}

function customSource(p) {
  const g = p.custom.n;
  const cell = p.side_m / g;
  const half = p.side_m / 2;
  const grid = typeof p.custom.land === "string" ? Uint8Array.from(p.custom.land, (ch) => (ch === "1" ? 1 : 0)) : Uint8Array.from(p.custom.land);
  const landXY = (x, y) => {
    let c = Math.floor((x + half) / cell), r = Math.floor((half - y) / cell);
    if (c < 0) c = 0; else if (c >= g) c = g - 1;
    if (r < 0) r = 0; else if (r >= g) r = g - 1;
    return grid[r * g + c];
  };
  const dot = [(p.custom.dot[0] + 0.5) * cell - half, half - (p.custom.dot[1] + 0.5) * cell];
  return { landXY, dot };
}

function sampleTemplateGrid(landXY, n, resM, ss) {
  const out = new Float32Array(n * n);
  const half = n * resM / 2;
  const subs = [];
  for (let k = 0; k < ss; k++) subs.push(((k + 0.5) / ss - 0.5) * resM);
  const inv = 1 / (ss * ss);
  for (let r = 0; r < n; r++) {
    const v = half - (r + 0.5) * resM;
    for (let c = 0; c < n; c++) {
      const u = -half + (c + 0.5) * resM;
      let acc = 0;
      for (const du of subs) for (const dv of subs) acc += landXY(u + du, v + dv);
      out[r * n + c] = acc * inv;
    }
  }
  return out;
}

function buildTemplate(p, resM) {
  const n = Math.max(4, Math.round(p.side_m / resM));
  let frame = null, landXY, dot, frac;
  if (p.custom) {
    const src = customSource(p);
    landXY = src.landXY;
    dot = src.dot;
    frac = sampleTemplateGrid(landXY, n, resM, p.supersample);
  } else {
    frame = makeFrame(p.center.lat, p.center.lon);
    landXY = (x, y) => { const ll = toLatLon(frame, x, y); return landAt(ll[0], ll[1]); };
    frac = sampleGrid(frame, n, resM, p.supersample);
    dot = toXY(frame, p.home.lat, p.home.lon);
  }
  const land = new Uint8Array(n * n);
  let landCount = 0, edges = 0;
  for (let k = 0; k < n * n; k++) { land[k] = frac[k] >= 0.5 ? 1 : 0; landCount += land[k]; }
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const k = r * n + c;
    if (r + 1 < n && land[k] !== land[k + n]) edges++;
    if (c + 1 < n && land[k] !== land[k + 1]) edges++;
  }
  return {
    frame, landXY, n, resM, halfM: p.side_m / 2, frac, land, dot,
    stats: { pixels: n, land_fraction: landCount / (n * n), coast_edges: edges, coast_ratio: edges / n },
  };
}

function footprintExtent(halfM, theta, scale) {
  const c = Math.cos(theta * D2R), s = Math.sin(theta * D2R);
  return halfM * scale * (Math.abs(c) + Math.abs(s));
}

function buildVariant(t, p, index, theta, flip, scale) {
  const ext = footprintExtent(t.halfM, theta, scale);
  const m = Math.ceil(2 * ext / t.resM);
  const c = Math.cos(theta * D2R), s = Math.sin(theta * D2R);
  const ss = p.supersample;
  const subs = [];
  for (let k = 0; k < ss; k++) subs.push(((k + 0.5) / ss - 0.5) * t.resM);
  const inside = new Uint8Array(m * m);
  const frac = new Float64Array(m * m);
  let count = 0;
  for (let r = 0; r < m; r++) {
    const qy0 = m * t.resM / 2 - (r + 0.5) * t.resM;
    for (let col = 0; col < m; col++) {
      const qx0 = -m * t.resM / 2 + (col + 0.5) * t.resM;
      let px = (c * qx0 + s * qy0) / scale, py = (-s * qx0 + c * qy0) / scale;
      if (flip) px = -px;
      if (Math.abs(px) > t.halfM || Math.abs(py) > t.halfM) continue;
      const k = r * m + col;
      inside[k] = 1;
      count++;
      let acc = 0;
      for (const du of subs) for (const dv of subs) {
        const qx = qx0 + du, qy = qy0 + dv;
        let sx = (c * qx + s * qy) / scale, sy = (-s * qx + c * qy) / scale;
        if (flip) sx = -sx;
        acc += t.landXY(sx, sy);
      }
      frac[k] = acc / (ss * ss);
    }
  }
  const vals = new Float64Array(m * m);
  const bin = new Uint8Array(m * m);
  for (let k = 0; k < m * m; k++) { vals[k] = 2 * frac[k] - 1; bin[k] = frac[k] >= 0.5 ? 1 : 0; }
  const zm = zeroMean(vals, inside, m);
  const band = coastBand(bin, inside, m, p.band_px);
  const bandF = Float64Array.from(band);
  const bz = zeroMean(bandF, inside, m);
  return { index, theta, flip, scale, m, inside, values: zm.values, norm: zm.norm, band: bz.values, bandNorm: bz.norm, count };
}

function buildVariants(t, p) {
  const out = [];
  for (const scale of p.scales) for (const theta of p.thetas) for (const flip of p.flips) out.push(buildVariant(t, p, out.length, theta, flip, scale));
  return out;
}

function ncc(num, std, norm, floor, count) {
  const out = new Float32Array(count);
  const thresh = floor * norm;
  for (let k = 0; k < count; k++) {
    const d = std[k];
    if (d >= thresh && d > 0) {
      let v = num[k] / (d * norm);
      out[k] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  }
  return out;
}

function pad(src, n, P, dst) {
  dst.fill(0);
  for (let r = 0; r < n; r++) dst.set(src.subarray(r * n, r * n + n), r * P);
}

function mulConj(are, aim, bre, bim, out_re, out_im, len) {
  for (let k = 0; k < len; k++) {
    out_re[k] = are[k] * bre[k] + aim[k] * bim[k];
    out_im[k] = aim[k] * bre[k] - are[k] * bim[k];
  }
}

function crop(src, P, valid) {
  const out = new Float64Array(valid * valid);
  for (let r = 0; r < valid; r++) out.set(src.subarray(r * P, r * P + valid), r * valid);
  return out;
}

function maxFilter(a, n, size) {
  const h = size >> 1;
  const tmp = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    let m = -Infinity;
    for (let d = -h; d <= h; d++) { const cc = Math.min(n - 1, Math.max(0, c + d)); const v = a[r * n + cc]; if (v > m) m = v; }
    tmp[r * n + c] = m;
  }
  const out = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    let m = -Infinity;
    for (let d = -h; d <= h; d++) { const rr = Math.min(n - 1, Math.max(0, r + d)); const v = tmp[rr * n + c]; if (v > m) m = v; }
    out[r * n + c] = m;
  }
  return out;
}

function pointAllowed(lat, lon, p) {
  if (p.home && p.same_hemisphere && (lat >= 0) !== (p.home.lat >= 0)) return false;
  if (p.home && p.lat_band != null && Math.abs(Math.abs(lat) - Math.abs(p.home.lat)) > p.lat_band) return false;
  if (p.bbox) {
    const [a, b, c, d] = p.bbox;
    if (!(a <= lat && lat <= c && b <= lon && lon <= d)) return false;
  }
  if (p.home && haversineKm(lat, lon, p.home.lat, p.home.lon) < p.exclude_km) return false;
  return true;
}

let CLIMATE = null;
let CLIMATE_PENDING = null;

async function loadClimate() {
  if (CLIMATE) return CLIMATE;
  if (CLIMATE_PENDING) return CLIMATE_PENDING;
  CLIMATE_PENDING = (async () => {
    const legend = await (await fetch(BASE + "data/koppen.json")).json();
    const res = await fetch(BASE + "data/koppen.png");
    if (!res.ok) throw new Error("could not load the climate map");
    const bitmap = await createImageBitmap(await res.blob());
    const w = bitmap.width, h = bitmap.height;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    const grid = new Uint8Array(w * h);
    for (let k = 0; k < grid.length; k++) grid[k] = data[k * 4];
    bitmap.close();
    CLIMATE = { grid, w, h, legend };
    return CLIMATE;
  })();
  return CLIMATE_PENDING;
}

function climateAt(lat, lon) {
  if (!CLIMATE) return null;
  const { grid, w, h, legend } = CLIMATE;
  const x0 = Math.min(w - 1, Math.max(0, Math.floor((lon + 180) / 360 * w)));
  const y0 = Math.min(h - 1, Math.max(0, Math.floor((90 - lat) / 180 * h)));
  for (let ring = 0; ring <= 6; ring++) {
    for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
      const y = y0 + dy;
      if (y < 0 || y >= h) continue;
      const x = ((x0 + dx) % w + w) % w;
      const v = grid[y * w + x];
      if (v && v !== legend.ocean && legend.classes[v]) return legend.classes[v].code;
    }
  }
  return null;
}

function climateAllowed(code, p) {
  const rule = p.climate;
  if (!rule) return true;
  if (!code) return false;
  if (rule === "same") return !!p.home_climate && code === p.home_climate;
  if (rule === "group") return !!p.home_climate && code[0] === p.home_climate[0];
  return rule.split(",").map((g) => g.trim()).filter(Boolean).includes(code[0]);
}

let CTX = null;

async function prepare(p) {
  const fineRes = p.fine_res;
  const coarseRes = p.coarse_res;
  if (!p.custom) {
    const fineFrame = makeFrame(p.center.lat, p.center.lon);
    const reg = regionOf(fineFrame, p.side_m * 1.5 * Math.max(...p.scales));
    await ensureRegion(...reg);
  }
  const fine = buildTemplate(p, fineRes);
  if (p.previewOnly) return { fine, coarse: { n: Math.round(p.side_m / coarseRes) }, variants: [] };
  const coarse = buildTemplate(p, coarseRes);
  const variants = buildVariants(coarse, p);
  const fineBand = coastBand(fine.land, null, fine.n, p.band_px);
  const fineVals = new Float64Array(fine.n * fine.n);
  for (let k = 0; k < fineVals.length; k++) fineVals[k] = 2 * fine.frac[k] - 1;
  const fz = zeroMean(fineVals, null, fine.n);
  const fb = zeroMean(Float64Array.from(fineBand), null, fine.n);
  const fineCoast = coastBand(fine.land, null, fine.n, 0);
  VT = null;
  CTX = { p, fine, coarse, variants, fineZ: fz, fineB: fb, fineBand, fineCoast, runFull: Math.max(8, Math.round(fine.n / 2)) };
  return { fine, coarse, variants };
}

function localRotation(frame, cu, cv, local) {
  const ll = toLatLon(frame, cu + 1000, cv);
  const xy = toXY(local, ll[0], ll[1]);
  return Math.atan2(xy[1], xy[0]) * R2D;
}

function processTile(tile) {
  const { p, coarse: t, variants } = CTX;
  const frame = makeFrame(tile.lat, tile.lon);
  const N = p.N, P = p.P, res = p.coarse_res;
  const halfM = N * res / 2;
  const frac = sampleGrid(frame, N, res, p.supersample);
  let any = false, all = true;
  for (let k = 0; k < N * N; k++) { if (frac[k] >= 0.5) any = true; else all = false; }
  if (!any || all) return { candidates: [], skipped: true };
  const len = P * P;
  const world = new Float64Array(N * N), world2 = new Float64Array(N * N), bandW = new Uint8Array(N * N);
  for (let k = 0; k < N * N; k++) { world[k] = 2 * frac[k] - 1; world2[k] = world[k] * world[k]; bandW[k] = frac[k] >= 0.5 ? 1 : 0; }
  const band = Float64Array.from(coastBand(bandW, null, N, p.band_px));
  const F = fft(P);
  const zre = new Float64Array(len), zim = new Float64Array(len);
  pad(world, N, P, zre); pad(world2, N, P, zim);
  F.transform(zre, zim, false);
  const FWre = new Float64Array(len), FWim = new Float64Array(len), FW2re = new Float64Array(len), FW2im = new Float64Array(len);
  unpackTwoReal(zre, zim, P, FWre, FWim, FW2re, FW2im);
  const FBre = new Float64Array(len), FBim = new Float64Array(len);
  pad(band, N, P, FBre); FBim.fill(0);
  F.transform(FBre, FBim, false);

  const best = new Float32Array(N * N).fill(-Infinity);
  const bestVar = new Int16Array(N * N).fill(-1);
  const bestMask = new Float32Array(N * N), bestCoast = new Float32Array(N * N);
  const keyCache = new Map();
  const xre = new Float64Array(len), xim = new Float64Array(len);
  const tre = new Float64Array(len), tim = new Float64Array(len);
  const vre = new Float64Array(len), vim = new Float64Array(len), bre = new Float64Array(len), bim = new Float64Array(len);
  const lam = p.detail_weight;
  for (const v of variants) {
    const m = v.m, valid = N - m + 1;
    if (valid <= 0) continue;
    const key = `${v.theta}|${v.scale}`;
    if (!keyCache.has(key)) {
      pad(Float64Array.from(v.inside), m, P, tre); tim.fill(0);
      F.transform(tre, tim, false);
      for (let k = 0; k < len; k++) {
        const a = FWre[k] * tre[k] + FWim[k] * tim[k], b = FWim[k] * tre[k] - FWre[k] * tim[k];
        const c2 = FW2re[k] * tre[k] + FW2im[k] * tim[k], d2 = FW2im[k] * tre[k] - FW2re[k] * tim[k];
        xre[k] = a - d2; xim[k] = b + c2;
      }
      F.transform(xre, xim, true);
      const sumW = crop(xre, P, valid), sumW2 = crop(xim, P, valid);
      mulConj(FBre, FBim, tre, tim, xre, xim, len);
      F.transform(xre, xim, true);
      const sumB = crop(xre, P, valid);
      const stdW = new Float64Array(valid * valid), stdB = new Float64Array(valid * valid);
      for (let k = 0; k < valid * valid; k++) {
        stdW[k] = Math.sqrt(Math.max(sumW2[k] - sumW[k] * sumW[k] / v.count, 0));
        stdB[k] = Math.sqrt(Math.max(sumB[k] - sumB[k] * sumB[k] / v.count, 0));
      }
      keyCache.set(key, { stdW, stdB });
    }
    const { stdW, stdB } = keyCache.get(key);
    pad(v.values, m, P, zre); pad(v.band, m, P, zim);
    F.transform(zre, zim, false);
    unpackTwoReal(zre, zim, P, vre, vim, bre, bim);
    for (let k = 0; k < len; k++) {
      const a = FWre[k] * vre[k] + FWim[k] * vim[k], b = FWim[k] * vre[k] - FWre[k] * vim[k];
      const c2 = FBre[k] * bre[k] + FBim[k] * bim[k], d2 = FBim[k] * bre[k] - FBre[k] * bim[k];
      xre[k] = a - d2; xim[k] = b + c2;
    }
    F.transform(xre, xim, true);
    const numW = crop(xre, P, valid), numB = crop(xim, P, valid);
    const maskScore = ncc(numW, stdW, v.norm, p.variance_floor, valid * valid);
    const coastScore = v.bandNorm > 0 ? ncc(numB, stdB, v.bandNorm, p.variance_floor, valid * valid) : new Float32Array(valid * valid);
    const off = m >> 1;
    for (let r = 0; r < valid; r++) for (let c = 0; c < valid; c++) {
      const k = r * valid + c;
      const sc = (1 - lam) * maskScore[k] + lam * coastScore[k];
      const kk = (r + off) * N + c + off;
      if (sc > best[kk]) { best[kk] = sc; bestVar[kk] = v.index; bestMask[kk] = maskScore[k]; bestCoast[kk] = coastScore[k]; }
    }
  }
  const size = Math.max(3, p.nms_px) | 1;
  const lm = maxFilter(best, N, size);
  const peaks = [];
  for (let k = 0; k < N * N; k++) if (bestVar[k] >= 0 && best[k] >= p.coarse_min_score && best[k] >= lm[k]) peaks.push(k);
  peaks.sort((a, b) => best[b] - best[a]);
  const candidates = [];
  for (const k of peaks.slice(0, p.per_tile)) {
    const v = variants[bestVar[k]];
    const r = (k / N) | 0, c = k % N;
    const cu = -halfM + (c - (v.m >> 1) + v.m / 2) * res;
    const cv = halfM - (r - (v.m >> 1) + v.m / 2) * res;
    const [lat, lon] = toLatLon(frame, cu, cv);
    if (!pointAllowed(lat, lon, p)) continue;
    const local = makeFrame(lat, lon);
    let theta = v.theta + localRotation(frame, cu, cv, local);
    theta = ((theta + 180) % 360 + 360) % 360 - 180;
    candidates.push({ lat, lon, theta, flip: v.flip, scale: v.scale, coarse: best[k], coarse_mask: bestMask[k], coarse_coast: bestCoast[k] });
  }
  return { candidates, skipped: false };
}

function sampleLocalFine(frame, extM, resHalf) {
  const g = Math.ceil(2 * extM / resHalf) + 2;
  const out = new Uint8Array(g * g);
  const half = g * resHalf / 2;
  for (let r = 0; r < g; r++) {
    const v = half - (r + 0.5) * resHalf;
    for (let c = 0; c < g; c++) {
      const u = -half + (c + 0.5) * resHalf;
      const ll = toLatLon(frame, u, v);
      out[r * g + c] = landAt(ll[0], ll[1]);
    }
  }
  return { grid: out, g, half, resHalf };
}

function windowFromGrid(lg, t, theta, flip, scale, dx, dy, ss) {
  const n = t.n, res = t.resM;
  const out = new Float32Array(n * n);
  const c = Math.cos(theta * D2R), s = Math.sin(theta * D2R);
  const subs = [];
  for (let k = 0; k < ss; k++) subs.push(((k + 0.5) / ss - 0.5) * res);
  const inv = 1 / (ss * ss);
  const g = lg.g, gh = lg.half, gr = lg.resHalf;
  for (let r = 0; r < n; r++) {
    const py0 = t.halfM - (r + 0.5) * res;
    for (let col = 0; col < n; col++) {
      const px0 = -t.halfM + (col + 0.5) * res;
      let acc = 0;
      for (const du of subs) for (const dv of subs) {
        let px = px0 + du, py = py0 + dv;
        if (flip) px = -px;
        const qx = scale * (c * px - s * py) + dx, qy = scale * (s * px + c * py) + dy;
        let gc = Math.floor((qx + gh) / gr), grow = Math.floor((gh - qy) / gr);
        if (gc < 0) gc = 0; else if (gc >= g) gc = g - 1;
        if (grow < 0) grow = 0; else if (grow >= g) grow = g - 1;
        acc += lg.grid[grow * g + gc];
      }
      out[r * n + col] = acc * inv;
    }
  }
  return out;
}

function scoreWindow(frac, n, p) {
  const { fineZ, fineB, fineCoast, runFull } = CTX;
  const vals = new Float64Array(n * n), bin = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) { vals[k] = 2 * frac[k] - 1; bin[k] = frac[k] >= 0.5 ? 1 : 0; }
  const wz = zeroMean(vals, null, n);
  const band = coastBand(bin, null, n, p.band_px);
  const bz = zeroMean(Float64Array.from(band), null, n);
  let mask = 0, ncc = 0;
  if (wz.norm >= p.variance_floor * fineZ.norm && wz.norm > 0) {
    let num = 0;
    for (let k = 0; k < n * n; k++) num += wz.values[k] * fineZ.values[k];
    mask = Math.max(-1, Math.min(1, num / (wz.norm * fineZ.norm)));
  }
  if (fineB.norm > 0 && bz.norm >= p.variance_floor * fineB.norm && bz.norm > 0) {
    let num = 0;
    for (let k = 0; k < n * n; k++) num += bz.values[k] * fineB.values[k];
    ncc = Math.max(-1, Math.min(1, num / (bz.norm * fineB.norm)));
  }
  const runs = continuity(fineCoast, band, n, runFull);
  const coast = 0.5 * Math.max(0, ncc) + 0.5 * runs.continuity;
  return { score: (1 - p.detail_weight) * mask + p.detail_weight * coast, mask, coast, ncc, continuity: runs.continuity, longest: runs.longest, bin };
}

async function refine(cand) {
  const { p, fine: t } = CTX;
  const frame = makeFrame(cand.lat, cand.lon);
  const scales = [cand.scale * 0.9, cand.scale, cand.scale * 1.1];
  const ext = footprintExtent(t.halfM, 45, scales[2]) + p.coarse_res * 1.5 + t.resM;
  const reg = regionOf(frame, ext);
  await ensureRegion(...reg);
  const lg = sampleLocalFine(frame, ext, t.resM / 2);
  const clampTheta = (th) => {
    th = ((th + 180) % 360 + 360) % 360 - 180;
    return p.rot_max >= 180 ? th : Math.max(-p.rot_max, Math.min(p.rot_max, th));
  };
  const thetas = [...new Set([cand.theta - p.rot_step / 2, cand.theta, cand.theta + p.rot_step / 2].map(clampTheta))];
  const radius = p.coarse_res;
  const step = t.resM;
  let best = null;
  const evaluate = (theta, scale, dx, dy) => {
    const frac = windowFromGrid(lg, t, theta, cand.flip, scale, dx, dy, p.supersample);
    const sc = scoreWindow(frac, t.n, p);
    if (!best || sc.score > best.score) best = { ...sc, theta, scale, dx, dy };
  };
  const r2 = Math.floor(radius / (2 * step)) * 2 * step;
  for (const scale of scales) for (const theta of thetas) {
    for (let dy = -r2; dy <= r2 + 1e-6; dy += 2 * step) for (let dx = -r2; dx <= r2 + 1e-6; dx += 2 * step) evaluate(theta, scale, dx, dy);
  }
  const b0 = { ...best };
  const fine = [...new Set([b0.theta - p.rot_step / 4, b0.theta, b0.theta + p.rot_step / 4].map(clampTheta))];
  for (const theta of fine) for (let dy = -step; dy <= step; dy += step) for (let dx = -step; dx <= step; dx += step) if (dx || dy || theta !== b0.theta) evaluate(theta, b0.scale, b0.dx + dx, b0.dy + dy);
  if (best.score < p.min_score) return null;
  const [clat, clon] = toLatLon(frame, best.dx, best.dy);
  if (!pointAllowed(clat, clon, p)) return null;
  const [qx, qy] = forward(t.dot[0], t.dot[1], best.theta, cand.flip, best.scale);
  const [dlat, dlon] = toLatLon(frame, qx + best.dx, qy + best.dy);
  const climate = climateAt(dlat, dlon);
  if (!climateAllowed(climate, p)) return null;
  const h = t.halfM;
  const square = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => {
    const [fx, fy] = forward(x, y, best.theta, cand.flip, best.scale);
    const [la, lo] = toLatLon(frame, fx + best.dx, fy + best.dy);
    return [lo, la];
  });
  square.push(square[0]);
  let theta = ((best.theta + 180) % 360 + 360) % 360 - 180;
  const scale = Math.round(best.scale * 1000) / 1000;
  return {
    score: best.score, mask_score: best.mask, coast_score: best.coast, coast_ncc: best.ncc, continuity: best.continuity,
    longest_km: Math.round(best.longest / 2 * t.resM / 100) / 10,
    center_lat: clat, center_lon: clon, dot_lat: dlat, dot_lon: dlon,
    theta: Math.round(theta * 10) / 10, flip: cand.flip, scale,
    side_km: Math.round(p.side_m * scale / 100) / 10, square,
    window: Array.from(best.bin), coarse: cand.coarse, climate,
  };
}

async function windowFor(match) {
  const { p, fine: t } = CTX;
  const frame = makeFrame(match.center_lat, match.center_lon);
  const ext = footprintExtent(t.halfM, 45, match.scale) + t.resM;
  await ensureRegion(...regionOf(frame, ext));
  const lg = sampleLocalFine(frame, ext, t.resM / 2);
  const frac = windowFromGrid(lg, t, match.theta, match.flip, match.scale, 0, 0, p.supersample);
  const bin = new Uint8Array(t.n * t.n);
  for (let k = 0; k < bin.length; k++) bin[k] = frac[k] >= 0.5 ? 1 : 0;
  return Array.from(bin);
}


const VTILES = new Map();
let TILE_TEMPLATE = null;
let VT = null;

async function tileTemplate() {
  if (!TILE_TEMPLATE) {
    const j = await (await fetch("https://tiles.openfreemap.org/planet")).json();
    TILE_TEMPLATE = j.tiles[0];
  }
  return TILE_TEMPLATE;
}

function readVarint(bytes, pos) {
  let result = 0, shift = 0;
  while (true) {
    const b = bytes[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if (!(b & 0x80)) return [result, pos];
    shift += 7;
  }
}

function forEachField(bytes, start, end, cb) {
  let pos = start;
  while (pos < end) {
    let key;
    [key, pos] = readVarint(bytes, pos);
    const field = Math.floor(key / 8), wtype = key & 7;
    if (wtype === 0) { let v; [v, pos] = readVarint(bytes, pos); cb(field, v, null); }
    else if (wtype === 2) { let ln; [ln, pos] = readVarint(bytes, pos); cb(field, null, bytes.subarray(pos, pos + ln)); pos += ln; }
    else if (wtype === 5) pos += 4;
    else if (wtype === 1) pos += 8;
    else throw new Error("bad wire type");
  }
}

function zigzag(v) { return (v % 2 === 1) ? -(v + 1) / 2 : v / 2; }

function decodeRings(geom) {
  const cmds = [];
  let pos = 0;
  while (pos < geom.length) { let v; [v, pos] = readVarint(geom, pos); cmds.push(v); }
  const rings = [];
  let ring = null, x = 0, y = 0, i = 0;
  while (i < cmds.length) {
    const cmd = cmds[i] & 7, count = Math.floor(cmds[i] / 8);
    i++;
    if (cmd === 1) {
      for (let k = 0; k < count; k++) { x += zigzag(cmds[i]); y += zigzag(cmds[i + 1]); i += 2; ring = [x, y]; rings.push(ring); }
    } else if (cmd === 2) {
      for (let k = 0; k < count; k++) { x += zigzag(cmds[i]); y += zigzag(cmds[i + 1]); i += 2; ring.push(x, y); }
    }
  }
  return rings;
}

function waterRings(bytes) {
  let extent = 4096;
  const rings = [];
  forEachField(bytes, 0, bytes.length, (field, _, layer) => {
    if (field !== 3 || !layer) return;
    let name = null, ext = 4096;
    const feats = [];
    forEachField(layer, 0, layer.length, (f, v, sub) => {
      if (f === 1) name = new TextDecoder().decode(sub);
      else if (f === 5) ext = v;
      else if (f === 2) feats.push(sub);
    });
    if (name !== "water") return;
    extent = ext;
    for (const fb of feats) {
      let gtype = 0, geom = null;
      forEachField(fb, 0, fb.length, (f, v, sub) => { if (f === 3) gtype = v; else if (f === 4) geom = sub; });
      if (gtype === 3 && geom) for (const r of decodeRings(geom)) rings.push(r);
    }
  });
  return { extent, rings };
}

async function fetchTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (VTILES.has(key)) return VTILES.get(key);
  const p = (async () => {
    const url = (await tileTemplate()).replace("{z}", z).replace("{x}", x).replace("{y}", y);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`tile ${key} ${res.status}`);
    return waterRings(new Uint8Array(await res.arrayBuffer()));
  })();
  VTILES.set(key, p);
  return p;
}

function mercTile(lat, lon, z) {
  const n = Math.pow(2, z);
  const latr = Math.max(-85.05, Math.min(85.05, lat)) * D2R;
  return [(lon + 180) / 360 * n, (1 - Math.log(Math.tan(latr) + 1 / Math.cos(latr)) / Math.PI) / 2 * n];
}

function tileToLatLon(tx, ty, z) {
  const n = Math.pow(2, z);
  return [Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * R2D, tx / n * 360 - 180];
}

function fillRingsEvenOdd(rings, n, target, own) {
  const rows = new Array(n);
  for (const ring of rings) {
    const m = ring.length / 2;
    if (m < 3) continue;
    for (let i = 0; i < m; i++) {
      const x0 = ring[2 * i], y0 = ring[2 * i + 1];
      const j = (i + 1) % m;
      const x1 = ring[2 * j], y1 = ring[2 * j + 1];
      if (y0 === y1) continue;
      const ymin = Math.min(y0, y1), ymax = Math.max(y0, y1);
      const r0 = Math.max(0, Math.ceil(ymin - 0.5)), r1 = Math.min(n - 1, Math.ceil(ymax - 0.5) - 1);
      for (let r = r0; r <= r1; r++) {
        const yc = r + 0.5;
        const x = x0 + (yc - y0) * (x1 - x0) / (y1 - y0);
        (rows[r] || (rows[r] = [])).push(x);
      }
    }
  }
  for (let r = 0; r < n; r++) {
    const xs = rows[r];
    if (!xs) continue;
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const c0 = Math.max(0, Math.ceil(xs[i] - 0.5)), c1 = Math.min(n, Math.ceil(xs[i + 1] - 0.5));
      for (let c = c0; c < c1; c++) if (own[r * n + c]) target[r * n + c] ^= 1;
    }
  }
}

async function landGrid(frame, halfM, resM) {
  const n = Math.round(2 * halfM / resM);
  const half = n * resM / 2;
  const zoom = Math.min(12, Math.max(6, Math.round(Math.log2(40075016.686 * Math.cos(frame.lat0 * D2R) / ((2 * halfM) / 2.5)))));
  const tx = new Int32Array(n * n), ty = new Int32Array(n * n);
  const tiles = new Map();
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const ll = toLatLon(frame, -half + (c + 0.5) * resM, half - (r + 0.5) * resM);
    const [mx, my] = mercTile(ll[0], ll[1], zoom);
    const k = r * n + c;
    tx[k] = Math.floor(mx); ty[k] = Math.floor(my);
    tiles.set(`${tx[k]}/${ty[k]}`, [tx[k], ty[k]]);
  }
  const list = [...tiles.values()];
  const blobs = await Promise.all(list.map(([x, y]) => fetchTile(zoom, x, y)));
  const water = new Uint8Array(n * n);
  const own = new Uint8Array(n * n);
  list.forEach(([x0, y0], idx) => {
    own.fill(0);
    let any = false;
    for (let k = 0; k < n * n; k++) if (tx[k] === x0 && ty[k] === y0) { own[k] = 1; any = true; }
    if (!any) return;
    const { extent, rings } = blobs[idx];
    const pixelRings = [];
    for (const ring of rings) {
      const out = new Array(ring.length);
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (let i = 0; i < ring.length; i += 2) {
        const [la, lo] = tileToLatLon(x0 + ring[i] / extent, y0 + ring[i + 1] / extent, zoom);
        const [rx, ry] = toXY(frame, la, lo);
        const px = (rx + half) / resM, py = (half - ry) / resM;
        out[i] = px; out[i + 1] = py;
        if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py;
      }
      if (maxx < -1 || minx > n + 1 || maxy < -1 || miny > n + 1) continue;
      pixelRings.push(out);
    }
    fillRingsEvenOdd(pixelRings, n, water, own);
  });
  const land = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) land[k] = water[k] ? 0 : 1;
  return { land, n, zoom };
}

function dilateSquare(binary, n, r) {
  if (r <= 0) return Uint8Array.from(binary);
  const tmp = new Uint8Array(n * n), out = new Uint8Array(n * n);
  for (let row = 0; row < n; row++) for (let c = 0; c < n; c++) {
    let v = 0;
    for (let d = -r; d <= r && !v; d++) { const cc = c + d; if (cc >= 0 && cc < n && binary[row * n + cc]) v = 1; }
    tmp[row * n + c] = v;
  }
  for (let row = 0; row < n; row++) for (let c = 0; c < n; c++) {
    let v = 0;
    for (let d = -r; d <= r && !v; d++) { const rr = row + d; if (rr >= 0 && rr < n && tmp[rr * n + c]) v = 1; }
    out[row * n + c] = v;
  }
  return out;
}

function edgePixels(land, n) {
  const coast = new Uint8Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const k = r * n + c;
    if (r + 1 < n && land[k] !== land[k + n]) { coast[k] = 1; coast[k + n] = 1; }
    if (c + 1 < n && land[k] !== land[k + 1]) { coast[k] = 1; coast[k + 1] = 1; }
  }
  return coast;
}

async function vectorTemplate(p) {
  if (VT) return VT;
  const fine = CTX.fine;
  let resM = Math.max(150, Math.min(500, p.side_m / 400));
  const n = Math.round(p.side_m / resM);
  resM = p.side_m / n;
  const halfM = p.side_m / 2;
  let land;
  if (p.custom) {
    land = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) land[r * n + c] = fine.landXY(-halfM + (c + 0.5) * resM, halfM - (r + 0.5) * resM);
  } else {
    land = (await landGrid(makeFrame(p.center.lat, p.center.lon), halfM, resM)).land;
  }
  const bandPx = Math.max(1, Math.round(p.band_px * p.fine_res / resM));
  const vals = new Float64Array(n * n);
  for (let k = 0; k < n * n; k++) vals[k] = land[k] ? 1 : -1;
  const vz = zeroMean(vals, null, n);
  const coast = edgePixels(land, n);
  const band = dilateSquare(coast, n, bandPx);
  const bz = zeroMean(Float64Array.from(band), null, n);
  const px = new Float64Array(n), py = new Float64Array(n);
  for (let i = 0; i < n; i++) { px[i] = -halfM + (i + 0.5) * resM; py[i] = halfM - (i + 0.5) * resM; }
  VT = { n, resM, halfM, bandPx, runFull: Math.max(8, n >> 1), land, vz, coast, bz, px, py, dot: fine.dot };
  return VT;
}

function scoreVector(vt, win, p) {
  const n = vt.n;
  const vals = new Float64Array(n * n);
  for (let k = 0; k < n * n; k++) vals[k] = win[k] ? 1 : -1;
  const wz = zeroMean(vals, null, n);
  const band = dilateSquare(edgePixels(win, n), n, vt.bandPx);
  const bz = zeroMean(Float64Array.from(band), null, n);
  let mask = 0, ncc = 0;
  if (wz.norm >= p.variance_floor * vt.vz.norm && wz.norm > 0) {
    let num = 0;
    for (let k = 0; k < n * n; k++) num += wz.values[k] * vt.vz.values[k];
    mask = Math.max(-1, Math.min(1, num / (wz.norm * vt.vz.norm)));
  }
  if (vt.bz.norm > 0 && bz.norm >= p.variance_floor * vt.bz.norm && bz.norm > 0) {
    let num = 0;
    for (let k = 0; k < n * n; k++) num += bz.values[k] * vt.bz.values[k];
    ncc = Math.max(-1, Math.min(1, num / (bz.norm * vt.bz.norm)));
  }
  const runs = continuity(vt.coast, band, n, vt.runFull);
  const coast = 0.5 * Math.max(0, ncc) + 0.5 * runs.continuity;
  return { score: (1 - p.detail_weight) * mask + p.detail_weight * coast, mask, coast, ncc, continuity: runs.continuity, longest: runs.longest };
}

async function refineVector(match) {
  const p = CTX.p;
  const vt = await vectorTemplate(p);
  const frame = makeFrame(match.center_lat, match.center_lon);
  const scale = match.scale;
  const ext = footprintExtent(vt.halfM, 45, scale) + 4 * vt.resM;
  const { land: grid, n: g, zoom } = await landGrid(frame, ext, vt.resM);
  const ghalf = g * vt.resM / 2;
  const n = vt.n;
  const window = (theta, dx, dy) => {
    const c = Math.cos(theta * D2R), s = Math.sin(theta * D2R);
    const out = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
      let px = vt.px[col], py = vt.py[r];
      if (match.flip) px = -px;
      const qx = scale * (c * px - s * py) + dx, qy = scale * (s * px + c * py) + dy;
      let gc = Math.floor((qx + ghalf) / vt.resM), gr = Math.floor((ghalf - qy) / vt.resM);
      if (gc < 0) gc = 0; else if (gc >= g) gc = g - 1;
      if (gr < 0) gr = 0; else if (gr >= g) gr = g - 1;
      out[r * n + col] = grid[gr * g + gc];
    }
    return out;
  };
  let best = null;
  const step = vt.resM;
  const evaluate = (theta, dx, dy) => {
    const sc = scoreVector(vt, window(theta, dx, dy), p);
    if (!best || sc.score > best.score) best = { ...sc, theta, dx, dy };
  };
  for (const theta of [match.theta - 2, match.theta, match.theta + 2]) for (const dy of [-2 * step, 0, 2 * step]) for (const dx of [-2 * step, 0, 2 * step]) evaluate(theta, dx, dy);
  const b0 = { ...best };
  for (const dy of [-step, 0, step]) for (const dx of [-step, 0, step]) if (dx || dy) evaluate(b0.theta, b0.dx + dx, b0.dy + dy);
  const [clat, clon] = toLatLon(frame, best.dx, best.dy);
  const theta = ((best.theta + 180) % 360 + 360) % 360 - 180;
  const [qx, qy] = forward(vt.dot[0], vt.dot[1], theta, match.flip, scale);
  const [dlat, dlon] = toLatLon(frame, qx + best.dx, qy + best.dy);
  const h = vt.halfM;
  const square = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => {
    const [fx, fy] = forward(x, y, theta, match.flip, scale);
    const [la, lo] = toLatLon(frame, fx + best.dx, fy + best.dy);
    return [lo, la];
  });
  square.push(square[0]);
  return {
    ...match, score: best.score, mask_score: best.mask, coast_score: best.coast, coast_ncc: best.ncc, continuity: best.continuity,
    longest_km: Math.round(best.longest / 2 * vt.resM / 100) / 10,
    center_lat: clat, center_lon: clon, dot_lat: dlat, dot_lon: dlon, theta: Math.round(theta * 10) / 10, square,
    vector: true, vector_res_m: Math.round(vt.resM), vector_zoom: zoom, km_score: match.score,
  };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      await loadIndex(msg.base);
      self.postMessage({ id: msg.id, ok: true });
    } else if (msg.type === "prepare") {
      const { fine, coarse } = await prepare(msg.params);
      self.postMessage({
        id: msg.id, ok: true,
        template: { n: fine.n, res: fine.resM, land: Array.from(fine.land), dot: fine.dot, stats: fine.stats, coarse_n: coarse.n },
      });
    } else if (msg.type === "climate") {
      await loadClimate();
      const code = climateAt(msg.lat, msg.lon);
      self.postMessage({ id: msg.id, ok: true, code, name: code ? CLIMATE.legend.classes[Object.keys(CLIMATE.legend.classes).find((k) => CLIMATE.legend.classes[k].code === code)].name : null });
    } else if (msg.type === "tile") {
      const t0 = performance.now();
      await loadClimate();
      const frame = makeFrame(msg.tile.lat, msg.tile.lon);
      await ensureRegion(...regionOf(frame, CTX.p.N * CTX.p.coarse_res / 2 + 20000));
      const res = processTile(msg.tile);
      const refined = [];
      for (const cand of res.candidates) {
        if (CTX.p.climate && !climateAllowed(climateAt(cand.lat, cand.lon), CTX.p)) continue;
        const r = await refine(cand);
        if (r) refined.push(r);
        if (refined.length >= CTX.p.refine_per_tile) break;
      }
      self.postMessage({ id: msg.id, ok: true, matches: refined, skipped: res.skipped, ms: performance.now() - t0 });
    } else if (msg.type === "raster") {
      await ensureRegion(msg.s, msg.n, msg.w, msg.e);
      const { width, height, w, s, e, n } = msg;
      const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
      const top = merc(n), bottom = merc(s);
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        const ym = top + (bottom - top) * (y + 0.5) / height;
        const lat = Math.atan(Math.sinh(ym)) * R2D;
        for (let x = 0; x < width; x++) {
          const lon = w + (e - w) * (x + 0.5) / width;
          const k = (y * width + x) * 4;
          if (landAt(lat, lon)) { pixels[k] = 217; pixels[k + 1] = 201; pixels[k + 2] = 163; } else { pixels[k] = 158; pixels[k + 1] = 202; pixels[k + 2] = 225; }
          pixels[k + 3] = 255;
        }
      }
      self.postMessage({ id: msg.id, ok: true, pixels: pixels.buffer }, [pixels.buffer]);
    } else if (msg.type === "probe") {
      const frame = makeFrame(msg.lat, msg.lon);
      await ensureRegion(...regionOf(frame, 100000));
      const out = { points: msg.points.map(([la, lo]) => [la, lo, landAt(la, lo)]), proj: msg.offsets.map(([x, y]) => [x, y, ...toLatLon(frame, x, y)]), back: msg.offsets.map(([x, y]) => { const ll = toLatLon(frame, x, y); return toXY(frame, ll[0], ll[1]); }) };
      self.postMessage({ id: msg.id, ok: true, ...out });
    } else if (msg.type === "vector") {
      const out = await refineVector(msg.match);
      self.postMessage({ id: msg.id, ok: true, match: out });
    } else if (msg.type === "window") {
      self.postMessage({ id: msg.id, ok: true, window: await windowFor(msg.match) });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) });
  }
};
