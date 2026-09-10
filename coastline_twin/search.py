import math
import multiprocessing
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Optional

import numpy as np
from scipy import fft as sfft
from scipy.ndimage import maximum_filter

from .geo import LocalFrame, coast_band, haversine_km, sample_land
from .template import forward


@dataclass
class Tile:
    lat: float
    lon: float
    half_m: float


@dataclass
class SearchConfig:
    res_m: float
    tile_half_m: float
    min_score: float
    nms_px: int
    per_tile: int
    home: tuple
    exclude_km: float
    min_sep_km: float
    top: int
    bbox: Optional[tuple]
    lat_band: Optional[float]
    same_hemisphere: bool
    workers: int
    supersample: int = 2
    band_width: int = 2
    detail_weight: float = 0.5
    variance_floor: float = 0.3
    step_deg: float = 9.0
    lat_limit: float = 81.0


def make_tiles(cfg):
    tiles = []
    lat = -cfg.lat_limit + cfg.step_deg / 2
    while lat < cfg.lat_limit:
        edge = max(abs(lat) - cfg.step_deg / 2, 0.0)
        lon_step = min(360.0, cfg.step_deg / math.cos(math.radians(edge)))
        count = int(math.ceil(360.0 / lon_step))
        lon_step = 360.0 / count
        for k in range(count):
            tiles.append(Tile(round(lat, 4), round(-180.0 + lon_step * (k + 0.5), 4), cfg.tile_half_m))
        lat += cfg.step_deg
    return tiles


def _intervals_overlap(a_lo, a_hi, b_lo, b_hi):
    return a_lo <= b_hi and b_lo <= a_hi


def tile_may_contain(tile, cfg):
    dlat = tile.half_m / 111_000.0 + 0.5
    lat_lo, lat_hi = tile.lat - dlat, tile.lat + dlat
    if lat_lo <= 0.0 <= lat_hi:
        abs_lo, abs_hi = 0.0, max(abs(lat_lo), abs(lat_hi))
    else:
        abs_lo, abs_hi = min(abs(lat_lo), abs(lat_hi)), max(abs(lat_lo), abs(lat_hi))
    if cfg.same_hemisphere:
        if cfg.home[0] >= 0 and lat_hi < 0:
            return False
        if cfg.home[0] < 0 and lat_lo > 0:
            return False
    if cfg.lat_band is not None:
        h = abs(cfg.home[0])
        if not _intervals_overlap(abs_lo, abs_hi, h - cfg.lat_band, h + cfg.lat_band):
            return False
    if cfg.bbox is not None:
        b_lat_lo, b_lon_lo, b_lat_hi, b_lon_hi = cfg.bbox
        if not _intervals_overlap(lat_lo, lat_hi, b_lat_lo, b_lat_hi):
            return False
        near = min(abs(lat_lo), abs(lat_hi)) if not (lat_lo <= 0 <= lat_hi) else 0.0
        dlon = dlat / max(math.cos(math.radians(min(near, 89.0))), 0.05)
        if not _intervals_overlap(tile.lon - dlon, tile.lon + dlon, b_lon_lo, b_lon_hi):
            return False
    return True


def point_allowed(lat, lon, cfg):
    if cfg.same_hemisphere and (lat >= 0) != (cfg.home[0] >= 0):
        return False
    if cfg.lat_band is not None and abs(abs(lat) - abs(cfg.home[0])) > cfg.lat_band:
        return False
    if cfg.bbox is not None:
        b_lat_lo, b_lon_lo, b_lat_hi, b_lon_hi = cfg.bbox
        if not (b_lat_lo <= lat <= b_lat_hi and b_lon_lo <= lon <= b_lon_hi):
            return False
    if haversine_km(lat, lon, cfg.home[0], cfg.home[1]) < cfg.exclude_km:
        return False
    return True


_STATE = {}


def _init(template, variants, cfg):
    _STATE["template"] = template
    _STATE["variants"] = variants
    _STATE["cfg"] = cfg


def _local_rotation(frame, cu, cv, local):
    lat1, lon1 = frame.to_latlon(cu + 1000.0, cv)
    x, y = local.to_xy(lat1, lon1)
    return math.degrees(math.atan2(float(y), float(x)))


def _candidate(template, cfg, frame, tile, var, i, j, score, mask_score, coast_score):
    m = var.size
    cu = -tile.half_m + (j + m / 2) * cfg.res_m
    cv = tile.half_m - (i + m / 2) * cfg.res_m
    lat, lon = frame.to_latlon(cu, cv)
    lat, lon = float(lat), float(lon)
    if not point_allowed(lat, lon, cfg):
        return None
    local = LocalFrame(lat, lon)
    theta = var.theta + _local_rotation(frame, cu, cv, local)
    theta = (theta + 180.0) % 360.0 - 180.0
    dx, dy = forward(template.dot_xy[0], template.dot_xy[1], theta, var.flip, var.scale)
    dot_lat, dot_lon = local.to_latlon(dx, dy)
    corners = []
    for x, y in template.square_corners(theta, var.flip, var.scale):
        clat, clon = local.to_latlon(x, y)
        corners.append([float(clon), float(clat)])
    corners.append(corners[0])
    return {
        "score": float(score),
        "mask_score": float(mask_score),
        "coast_score": float(coast_score),
        "center_lat": lat,
        "center_lon": lon,
        "dot_lat": float(dot_lat),
        "dot_lon": float(dot_lon),
        "theta": round(theta, 2),
        "flip": var.flip,
        "scale": var.scale,
        "side_km": round(template.side_m * var.scale / 1000.0, 2),
        "square": corners,
        "tile": [tile.lat, tile.lon],
    }


def _corr(fa, fb, p, valid):
    return sfft.irfft2(fa * np.conj(fb), s=(p, p))[:valid, :valid].astype(np.float64)


def _ncc(num, std_window, norm_template, floor):
    out = np.zeros_like(num)
    ok = std_window >= floor * norm_template
    out[ok] = num[ok] / (std_window[ok] * norm_template)
    return np.clip(out, -1.0, 1.0)


def process_tile(tile):
    template = _STATE["template"]
    variants = _STATE["variants"]
    cfg = _STATE["cfg"]
    frame = LocalFrame(tile.lat, tile.lon)
    fraction = sample_land(frame, tile.half_m, cfg.res_m, cfg.supersample)
    land = fraction >= 0.5
    if land.all() or not land.any():
        return []
    n = land.shape[0]
    mmax = max(v.size for v in variants)
    p = sfft.next_fast_len(n + mmax - 1, real=True)
    world = (2.0 * fraction - 1.0).astype(np.float32)
    band = coast_band(land, None, cfg.band_width).astype(np.float32)
    fw = sfft.rfft2(world, s=(p, p))
    fw2 = sfft.rfft2(world * world, s=(p, p))
    fb = sfft.rfft2(band, s=(p, p))
    best = np.full((n, n), -np.inf, dtype=np.float32)
    best_mask = np.zeros((n, n), dtype=np.float32)
    best_coast = np.zeros((n, n), dtype=np.float32)
    best_var = np.full((n, n), -1, dtype=np.int16)
    fp_cache = {}
    lam = cfg.detail_weight
    for var in variants:
        m = var.size
        valid = n - m + 1
        if valid <= 0:
            continue
        key = (var.theta, var.scale)
        if key not in fp_cache:
            fm = sfft.rfft2(var.footprint.astype(np.float32), s=(p, p))
            sum_w = _corr(fw, fm, p, valid)
            sum_w2 = _corr(fw2, fm, p, valid)
            sum_b = _corr(fb, fm, p, valid)
            std_w = np.sqrt(np.maximum(sum_w2 - sum_w**2 / var.count, 0.0))
            std_b = np.sqrt(np.maximum(sum_b - sum_b**2 / var.count, 0.0))
            fp_cache[key] = (std_w, std_b)
        std_w, std_b = fp_cache[key]
        num_w = _corr(fw, sfft.rfft2(var.values, s=(p, p)), p, valid)
        mask_score = _ncc(num_w, std_w, var.norm, cfg.variance_floor)
        if lam > 0 and var.band_norm > 0:
            num_b = _corr(fb, sfft.rfft2(var.band_values, s=(p, p)), p, valid)
            coast_score = _ncc(num_b, std_b, var.band_norm, cfg.variance_floor)
        else:
            coast_score = np.zeros_like(num_w)
        score = ((1.0 - lam) * mask_score + lam * coast_score).astype(np.float32)
        off = m // 2
        sl = (slice(off, off + valid), slice(off, off + valid))
        better = score > best[sl]
        best[sl][better] = score[better]
        best_mask[sl][better] = mask_score[better]
        best_coast[sl][better] = coast_score[better]
        best_var[sl][better] = var.index
    size = max(3, int(cfg.nms_px)) | 1
    local_max = maximum_filter(best, size=size, mode="nearest")
    peaks = (best >= local_max) & (best >= cfg.min_score) & (best_var >= 0)
    rows, cols = np.nonzero(peaks)
    if rows.size == 0:
        return []
    order = np.argsort(best[rows, cols])[::-1][: cfg.per_tile]
    out = []
    for r, c in zip(rows[order], cols[order]):
        var = variants[int(best_var[r, c])]
        cand = _candidate(
            template, cfg, frame, tile, var, r - var.size // 2, c - var.size // 2,
            best[r, c], best_mask[r, c], best_coast[r, c],
        )
        if cand is not None:
            out.append(cand)
    return out


def merge(candidates, cfg):
    candidates = sorted(candidates, key=lambda c: c["score"], reverse=True)
    kept = []
    for cand in candidates:
        far = all(
            haversine_km(cand["center_lat"], cand["center_lon"], k["center_lat"], k["center_lon"]) >= cfg.min_sep_km
            for k in kept
        )
        if far:
            kept.append(cand)
        if len(kept) >= cfg.top:
            break
    for rank, cand in enumerate(kept, start=1):
        cand["rank"] = rank
    return kept


def run_search(template, variants, cfg, progress=None):
    tiles = [t for t in make_tiles(cfg) if tile_may_contain(t, cfg)]
    candidates = []
    if cfg.workers <= 1:
        _init(template, variants, cfg)
        for tile in tiles:
            candidates.extend(process_tile(tile))
            if progress:
                progress(1)
    else:
        ctx = multiprocessing.get_context("fork")
        with ProcessPoolExecutor(
            max_workers=cfg.workers, mp_context=ctx, initializer=_init, initargs=(template, variants, cfg)
        ) as pool:
            futures = [pool.submit(process_tile, t) for t in tiles]
            for fut in as_completed(futures):
                candidates.extend(fut.result())
                if progress:
                    progress(1)
    return merge(candidates, cfg), len(tiles), len(candidates)
