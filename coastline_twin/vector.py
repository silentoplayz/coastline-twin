import gzip
import json
import math
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from .geo import LocalFrame
from .template import forward

TILEJSON = "https://tiles.openfreemap.org/planet"
USER_AGENT = "coastline-twin/0.1 (https://github.com/silentoplayz/coastline-twin)"
_TILE_TEMPLATE = None


def tile_template():
    global _TILE_TEMPLATE
    if _TILE_TEMPLATE is None:
        req = urllib.request.Request(TILEJSON, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=20) as r:
            _TILE_TEMPLATE = json.load(r)["tiles"][0]
    return _TILE_TEMPLATE


def _read_varint(buf, pos):
    result = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7


def _fields(buf, start, end):
    pos = start
    while pos < end:
        key, pos = _read_varint(buf, pos)
        field, wtype = key >> 3, key & 7
        if wtype == 0:
            val, pos = _read_varint(buf, pos)
            yield field, val
        elif wtype == 2:
            ln, pos = _read_varint(buf, pos)
            yield field, buf[pos : pos + ln]
            pos += ln
        elif wtype == 5:
            pos += 4
        elif wtype == 1:
            pos += 8
        else:
            raise ValueError(f"unknown wire type {wtype}")


def _zigzag(v):
    return (v >> 1) ^ -(v & 1)


def _rings(data):
    cmds = []
    pos = 0
    while pos < len(data):
        v, pos = _read_varint(data, pos)
        cmds.append(v)
    rings = []
    ring = None
    x = y = 0
    i = 0
    while i < len(cmds):
        cmd, count = cmds[i] & 7, cmds[i] >> 3
        i += 1
        if cmd == 1:
            for _ in range(count):
                x += _zigzag(cmds[i])
                y += _zigzag(cmds[i + 1])
                i += 2
                ring = [(x, y)]
                rings.append(ring)
        elif cmd == 2:
            for _ in range(count):
                x += _zigzag(cmds[i])
                y += _zigzag(cmds[i + 1])
                i += 2
                ring.append((x, y))
    return rings


def water_rings(buf):
    if buf[:2] == b"\x1f\x8b":
        buf = gzip.decompress(buf)
    for field, val in _fields(buf, 0, len(buf)):
        if field != 3:
            continue
        name = None
        extent = 4096
        feats = []
        for f, v in _fields(val, 0, len(val)):
            if f == 1:
                name = v.decode()
            elif f == 5:
                extent = v
            elif f == 2:
                feats.append(v)
        if name != "water":
            continue
        rings = []
        for fb in feats:
            gtype = 0
            geom = None
            for f, v in _fields(fb, 0, len(fb)):
                if f == 3:
                    gtype = v
                elif f == 4:
                    geom = v
            if gtype == 3 and geom:
                rings.extend(_rings(geom))
        return extent, rings
    return 4096, []


def fetch_tile(z, x, y, cache_dir):
    path = Path(cache_dir) / f"{z}_{x}_{y}.pbf"
    if path.exists():
        return path.read_bytes()
    url = tile_template().replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def _merc(lat, lon, z):
    n = 2**z
    x = (lon + 180.0) / 360.0 * n
    lat_r = np.radians(np.clip(lat, -85.05, 85.05))
    y = (1 - np.log(np.tan(lat_r) + 1 / np.cos(lat_r)) / math.pi) / 2 * n
    return x, y


def _tile_to_latlon(tx, ty, z):
    n = 2**z
    lon = tx / n * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * ty / n))))
    return lat, lon


def land_grid(frame, half_m, res_m, cache_dir, zoom=None):
    n = int(round(2 * half_m / res_m))
    c = (np.arange(n) + 0.5) * res_m - n * res_m / 2
    u, v = np.meshgrid(c, -c)
    lat, lon = frame.to_latlon(u.ravel(), v.ravel())
    lat = lat.reshape(n, n)
    lon = lon.reshape(n, n)
    if zoom is None:
        span = 2 * half_m
        zoom = int(min(12, max(6, round(math.log2(40075016.686 * math.cos(math.radians(frame.lat0)) / (span / 2.5))))))
    tx, ty = _merc(lat, lon, zoom)
    txi = np.floor(tx).astype(int)
    tyi = np.floor(ty).astype(int)
    tiles = sorted({(int(a), int(b)) for a, b in zip(txi.ravel(), tyi.ravel())})
    with ThreadPoolExecutor(max_workers=6) as pool:
        blobs = list(pool.map(lambda t: fetch_tile(zoom, t[0], t[1], cache_dir), tiles))
    water = np.zeros((n, n), dtype=bool)
    for (x0, y0), blob in zip(tiles, blobs):
        extent, rings = water_rings(blob)
        own = (txi == x0) & (tyi == y0)
        if not own.any():
            continue
        acc = np.zeros((n, n), dtype=bool)
        for ring in rings:
            if len(ring) < 3:
                continue
            pts = np.array(ring, dtype=float)
            rlat, rlon = _tile_to_latlon(x0 + pts[:, 0] / extent, y0 + pts[:, 1] / extent, zoom)
            rx, ry = frame.to_xy(rlat, rlon)
            px = (rx + n * res_m / 2) / res_m
            py = (n * res_m / 2 - ry) / res_m
            if px.max() < -1 or px.min() > n + 1 or py.max() < -1 or py.min() > n + 1:
                continue
            img = Image.new("L", (n, n), 0)
            ImageDraw.Draw(img).polygon(list(zip(px.tolist(), py.tolist())), fill=1)
            acc ^= np.asarray(img, dtype=bool)
        water[own] = acc[own]
    return ~water, n, zoom


def _coast_band(binary, width):
    from scipy.ndimage import binary_dilation

    coast = np.zeros_like(binary)
    dv = binary[1:, :] != binary[:-1, :]
    dh = binary[:, 1:] != binary[:, :-1]
    coast[1:, :] |= dv
    coast[:-1, :] |= dv
    coast[:, 1:] |= dh
    coast[:, :-1] |= dh
    if width > 0:
        coast = binary_dilation(coast, structure=np.ones((3, 3), dtype=bool), iterations=width)
    return coast


def _continuity(coast, match_band, run_full):
    from scipy.ndimage import label

    total = int(coast.sum())
    if total == 0:
        return 0.0, 0
    labels, count = label(coast & match_band, structure=np.ones((3, 3), dtype=int))
    if count == 0:
        return 0.0, 0
    sizes = np.bincount(labels.ravel())[1:]
    return float((sizes * np.minimum(1.0, sizes / run_full)).sum()) / total, int(sizes.max())


class VectorTemplate:
    def __init__(self, template, cfg, cache_dir):
        self.res_m = max(150.0, min(500.0, template.side_m / 400.0))
        self.n = int(round(template.side_m / self.res_m))
        self.res_m = template.side_m / self.n
        self.half_m = template.side_m / 2
        self.band_px = max(1, int(round(cfg.band_width * cfg.res_m / self.res_m)))
        self.run_full = max(8, self.n // 2)
        if template.grid is not None:
            c = (np.arange(self.n) + 0.5) * self.res_m - self.half_m
            u, v = np.meshgrid(c, -c)
            self.land = template.land_xy(u, v)
        else:
            self.land, _, _ = land_grid(template.frame, self.half_m, self.res_m, cache_dir)
        vals = np.where(self.land, 1.0, -1.0)
        self.vz = vals - vals.mean()
        self.vnorm = float(np.sqrt((self.vz**2).sum()))
        band = _coast_band(self.land, self.band_px).astype(np.float64)
        self.bz = band - band.mean()
        self.bnorm = float(np.sqrt((self.bz**2).sum()))
        self.coast = _coast_band(self.land, 0)
        self.px = (np.arange(self.n) + 0.5) * self.res_m - self.half_m
        self.py = self.half_m - (np.arange(self.n) + 0.5) * self.res_m
        self.dot_xy = template.dot_xy


def _score(vt, land_window, cfg):
    vals = np.where(land_window, 1.0, -1.0)
    wz = vals - vals.mean()
    wnorm = float(np.sqrt((wz**2).sum()))
    band = _coast_band(land_window, vt.band_px)
    bf = band.astype(np.float64)
    bzw = bf - bf.mean()
    bwnorm = float(np.sqrt((bzw**2).sum()))
    mask = float(np.clip((wz * vt.vz).sum() / (wnorm * vt.vnorm), -1, 1)) if wnorm >= cfg.variance_floor * vt.vnorm and wnorm > 0 else 0.0
    ncc = float(np.clip((bzw * vt.bz).sum() / (bwnorm * vt.bnorm), -1, 1)) if vt.bnorm > 0 and bwnorm >= cfg.variance_floor * vt.bnorm and bwnorm > 0 else 0.0
    cont, longest = _continuity(vt.coast, band, vt.run_full)
    coast = 0.5 * max(0.0, ncc) + 0.5 * cont
    return {"score": (1.0 - cfg.detail_weight) * mask + cfg.detail_weight * coast, "mask": mask, "coast": coast, "ncc": ncc, "continuity": cont, "longest": longest}


def refine_match(vt, template, cfg, match, cache_dir):
    frame = LocalFrame(match["center_lat"], match["center_lon"])
    scale = match["scale"]
    ext = template.footprint_extent(45.0, scale) + 4 * vt.res_m
    grid, g, zoom = land_grid(frame, ext, vt.res_m, cache_dir)
    ghalf = g * vt.res_m / 2
    ct = st = None

    def window(theta, dx, dy):
        c, s = math.cos(math.radians(theta)), math.sin(math.radians(theta))
        px, py = np.meshgrid(vt.px, vt.py)
        if match["flip"]:
            px = -px
        qx = scale * (c * px - s * py) + dx
        qy = scale * (s * px + c * py) + dy
        gc = np.clip(np.floor((qx + ghalf) / vt.res_m).astype(int), 0, g - 1)
        gr = np.clip(np.floor((ghalf - qy) / vt.res_m).astype(int), 0, g - 1)
        return grid[gr, gc]

    best = None
    step = vt.res_m
    for theta in (match["theta"] - 2.0, match["theta"], match["theta"] + 2.0):
        for dy in (-2 * step, 0.0, 2 * step):
            for dx in (-2 * step, 0.0, 2 * step):
                sc = _score(vt, window(theta, dx, dy), cfg)
                if best is None or sc["score"] > best["score"]:
                    best = {**sc, "theta": theta, "dx": dx, "dy": dy}
    b0 = dict(best)
    for dy in (-step, 0.0, step):
        for dx in (-step, 0.0, step):
            if dx or dy:
                sc = _score(vt, window(b0["theta"], b0["dx"] + dx, b0["dy"] + dy), cfg)
                if sc["score"] > best["score"]:
                    best = {**sc, "theta": b0["theta"], "dx": b0["dx"] + dx, "dy": b0["dy"] + dy}
    clat, clon = frame.to_latlon(best["dx"], best["dy"])
    theta = (best["theta"] + 180.0) % 360.0 - 180.0
    qx, qy = forward(vt.dot_xy[0], vt.dot_xy[1], theta, match["flip"], scale)
    dlat, dlon = frame.to_latlon(qx + best["dx"], qy + best["dy"])
    corners = []
    for x, y in template.square_corners(theta, match["flip"], scale):
        la, lo = frame.to_latlon(x + best["dx"], y + best["dy"])
        corners.append([float(lo), float(la)])
    corners.append(corners[0])
    out = dict(match)
    out.update({
        "score": float(best["score"]), "mask_score": float(best["mask"]), "coast_score": float(best["coast"]),
        "coast_ncc": float(best["ncc"]), "continuity": float(best["continuity"]),
        "longest_km": round(best["longest"] / 2 * vt.res_m / 1000.0, 1),
        "center_lat": float(clat), "center_lon": float(clon), "dot_lat": float(dlat), "dot_lon": float(dlon),
        "theta": round(theta, 2), "square": corners, "vector": True, "vector_res_m": round(vt.res_m), "vector_zoom": zoom,
        "km_score": match["score"],
    })
    return out


def vector_stage(template, cfg, matches, cache_dir, top_n, progress=None):
    vt = VectorTemplate(template, cfg, cache_dir)
    out = []
    for i, m in enumerate(matches[:top_n]):
        out.append(refine_match(vt, template, cfg, m, cache_dir))
        if progress:
            progress(i + 1, min(top_n, len(matches)))
    out.extend(matches[top_n:])
    out.sort(key=lambda m: m["score"], reverse=True)
    return out
