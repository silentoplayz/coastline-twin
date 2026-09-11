import math
import multiprocessing
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Optional

import numpy as np
from scipy import fft as sfft
from scipy.ndimage import label, maximum_filter

from .geo import LocalFrame, coast_band, haversine_km, is_land, sample_land
from .template import describe_mirror, forward


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
    refine_per_tile: int = 6
    rot_step: float = 15.0
    rot_max: float = 45.0
    climate: str = ""
    home_climate: Optional[str] = None
    vector_top: int = 20
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
    if cfg.home is not None and cfg.same_hemisphere:
        if cfg.home[0] >= 0 and lat_hi < 0:
            return False
        if cfg.home[0] < 0 and lat_lo > 0:
            return False
    if cfg.home is not None and cfg.lat_band is not None:
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
    if cfg.home is not None and cfg.same_hemisphere and (lat >= 0) != (cfg.home[0] >= 0):
        return False
    if cfg.home is not None and cfg.lat_band is not None and abs(abs(lat) - abs(cfg.home[0])) > cfg.lat_band:
        return False
    if cfg.bbox is not None:
        b_lat_lo, b_lon_lo, b_lat_hi, b_lon_hi = cfg.bbox
        if not (b_lat_lo <= lat <= b_lat_hi and b_lon_lo <= lon <= b_lon_hi):
            return False
    if cfg.home is not None and haversine_km(lat, lon, cfg.home[0], cfg.home[1]) < cfg.exclude_km:
        return False
    return True


_STATE = {}
_CLIMATE = None


def load_climate():
    global _CLIMATE
    if _CLIMATE is None:
        import json
        from pathlib import Path

        from PIL import Image

        root = Path(__file__).resolve().parents[1] / "docs" / "data"
        legend = json.loads((root / "koppen.json").read_text())
        grid = np.asarray(Image.open(root / "koppen.png").convert("L"))
        _CLIMATE = {"grid": grid, "legend": legend}
    return _CLIMATE


def climate_at(lat, lon):
    c = load_climate()
    grid, legend = c["grid"], c["legend"]
    h, w = grid.shape
    x0 = min(w - 1, max(0, int((lon + 180.0) / 360.0 * w)))
    y0 = min(h - 1, max(0, int((90.0 - lat) / 180.0 * h)))
    ocean = legend["ocean"]
    classes = legend["classes"]
    for ring in range(7):
        for dy in range(-ring, ring + 1):
            for dx in range(-ring, ring + 1):
                if max(abs(dx), abs(dy)) != ring:
                    continue
                y = y0 + dy
                if y < 0 or y >= h:
                    continue
                v = int(grid[y, (x0 + dx) % w])
                if v and v != ocean and str(v) in classes:
                    return classes[str(v)]["code"]
    return None


def climate_name(code):
    if not code:
        return None
    for entry in load_climate()["legend"]["classes"].values():
        if entry["code"] == code:
            return entry["name"]
    return None


def climate_allowed(code, cfg):
    rule = cfg.climate
    if not rule:
        return True
    if not code:
        return False
    if rule == "same":
        return bool(cfg.home_climate) and code == cfg.home_climate
    if rule == "group":
        return bool(cfg.home_climate) and code[0] == cfg.home_climate[0]
    return code[0] in [g.strip() for g in rule.split(",") if g.strip()]


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
    return {
        "lat": lat, "lon": lon, "theta": theta, "flip": var.flip, "scale": var.scale,
        "coarse": float(score), "coarse_mask": float(mask_score), "coarse_coast": float(coast_score),
        "tile": [tile.lat, tile.lon],
    }


def _template_features(template, cfg):
    key = "features"
    if key in _STATE:
        return _STATE[key]
    n = template.n
    vals = 2.0 * template.fraction.astype(np.float64) - 1.0
    vz = vals - vals.mean()
    band = coast_band(template.land, None, cfg.band_width).astype(np.float64)
    bz = band - band.mean()
    coast = coast_band(template.land, None, 0)
    feats = {
        "vz": vz, "vnorm": float(np.sqrt((vz**2).sum())),
        "bz": bz, "bnorm": float(np.sqrt((bz**2).sum())),
        "coast": coast, "coast_total": int(coast.sum()),
        "run_full": max(8, int(round(n / 2))),
        "px": (np.arange(n) + 0.5) * template.res_m - template.half_m,
        "py": template.half_m - (np.arange(n) + 0.5) * template.res_m,
        "subs": ((np.arange(cfg.supersample) + 0.5) / cfg.supersample - 0.5) * template.res_m,
    }
    _STATE[key] = feats
    return feats


def _local_grid(frame, ext_m, res_half):
    g = int(math.ceil(2 * ext_m / res_half)) + 2
    half = g * res_half / 2
    c = (np.arange(g) + 0.5) * res_half - half
    u, v = np.meshgrid(c, -c)
    lat, lon = frame.to_latlon(u.ravel(), v.ravel())
    return is_land(lat, lon).reshape(g, g), g, half, res_half


def _window(grid, g, ghalf, gres, feats, theta, flip, scale, dx, dy):
    ct, st = math.cos(math.radians(theta)), math.sin(math.radians(theta))
    acc = None
    for du in feats["subs"]:
        for dv in feats["subs"]:
            px, py = np.meshgrid(feats["px"] + du, feats["py"] + dv)
            if flip:
                px = -px
            qx = scale * (ct * px - st * py) + dx
            qy = scale * (st * px + ct * py) + dy
            gc = np.clip(np.floor((qx + ghalf) / gres).astype(int), 0, g - 1)
            gr = np.clip(np.floor((ghalf - qy) / gres).astype(int), 0, g - 1)
            sample = grid[gr, gc].astype(np.float64)
            acc = sample if acc is None else acc + sample
    return acc / (len(feats["subs"]) ** 2)


_EIGHT = np.ones((3, 3), dtype=int)


def _continuity(coast, match_band, run_full):
    total = int(coast.sum())
    if total == 0:
        return 0.0, 0
    matched = coast & match_band
    labels, count = label(matched, structure=_EIGHT)
    if count == 0:
        return 0.0, 0
    sizes = np.bincount(labels.ravel())[1:]
    acc = float((sizes * np.minimum(1.0, sizes / run_full)).sum())
    return acc / total, int(sizes.max())


def _score_window(frac, feats, cfg):
    vals = 2.0 * frac - 1.0
    binary = frac >= 0.5
    wz = vals - vals.mean()
    wnorm = float(np.sqrt((wz**2).sum()))
    band = coast_band(binary, None, cfg.band_width)
    bf = band.astype(np.float64)
    bzw = bf - bf.mean()
    bwnorm = float(np.sqrt((bzw**2).sum()))
    mask = 0.0
    if wnorm >= cfg.variance_floor * feats["vnorm"] and wnorm > 0:
        mask = float(np.clip((wz * feats["vz"]).sum() / (wnorm * feats["vnorm"]), -1, 1))
    ncc = 0.0
    if feats["bnorm"] > 0 and bwnorm >= cfg.variance_floor * feats["bnorm"] and bwnorm > 0:
        ncc = float(np.clip((bzw * feats["bz"]).sum() / (bwnorm * feats["bnorm"]), -1, 1))
    cont, longest = _continuity(feats["coast"], band, feats["run_full"])
    coast = 0.5 * max(0.0, ncc) + 0.5 * cont
    score = (1.0 - cfg.detail_weight) * mask + cfg.detail_weight * coast
    return {"score": score, "mask": mask, "coast": coast, "ncc": ncc, "continuity": cont, "longest": longest}


def refine(template, cfg, cand):
    feats = _template_features(template, cfg)
    frame = LocalFrame(cand["lat"], cand["lon"])
    scales = [cand["scale"] * 0.9, cand["scale"], cand["scale"] * 1.1]
    ext = template.footprint_extent(45.0, scales[2]) + 3 * cfg.res_m
    grid, g, ghalf, gres = _local_grid(frame, ext, cfg.res_m / 2)
    step = cfg.res_m
    delta = cfg.rot_step / 2
    best = None

    ns = cand["flip"] and abs((cand["theta"] + 180.0) % 360.0 - 180.0) > 90.0

    def clamp_theta(th):
        th = (th + 180.0) % 360.0 - 180.0
        if cfg.rot_max >= 180:
            return th
        if ns:
            base = (th - 180.0 + 180.0) % 360.0 - 180.0
            return (max(-cfg.rot_max, min(cfg.rot_max, base)) + 180.0 + 180.0) % 360.0 - 180.0
        return max(-cfg.rot_max, min(cfg.rot_max, th))

    coarse_thetas = sorted({clamp_theta(t) for t in (cand["theta"] - delta, cand["theta"], cand["theta"] + delta)})

    def evaluate(theta, scale, dx, dy):
        nonlocal best
        frac = _window(grid, g, ghalf, gres, feats, theta, cand["flip"], scale, dx, dy)
        sc = _score_window(frac, feats, cfg)
        if best is None or sc["score"] > best["score"]:
            best = {**sc, "theta": theta, "scale": scale, "dx": dx, "dy": dy}

    for scale in scales:
        for theta in coarse_thetas:
            for dy in (-2 * step, 0.0, 2 * step):
                for dx in (-2 * step, 0.0, 2 * step):
                    evaluate(theta, scale, dx, dy)
    b0 = dict(best)
    for theta in sorted({clamp_theta(t) for t in (b0["theta"] - delta / 2, b0["theta"], b0["theta"] + delta / 2)}):
        for dy in (-step, 0.0, step):
            for dx in (-step, 0.0, step):
                if dx or dy or theta != b0["theta"]:
                    evaluate(theta, b0["scale"], b0["dx"] + dx, b0["dy"] + dy)
    if best["score"] < cfg.min_score:
        return None
    clat, clon = frame.to_latlon(best["dx"], best["dy"])
    clat, clon = float(clat), float(clon)
    if not point_allowed(clat, clon, cfg):
        return None
    theta = (best["theta"] + 180.0) % 360.0 - 180.0
    scale = round(best["scale"], 3)
    mirror, theta_display = describe_mirror(theta, cand["flip"])
    qx, qy = forward(template.dot_xy[0], template.dot_xy[1], theta, cand["flip"], scale)
    dot_lat, dot_lon = frame.to_latlon(qx + best["dx"], qy + best["dy"])
    climate = climate_at(float(dot_lat), float(dot_lon))
    if not climate_allowed(climate, cfg):
        return None
    corners = []
    for x, y in template.square_corners(theta, cand["flip"], scale):
        la, lo = frame.to_latlon(x + best["dx"], y + best["dy"])
        corners.append([float(lo), float(la)])
    corners.append(corners[0])
    return {
        "score": float(best["score"]),
        "mask_score": float(best["mask"]),
        "coast_score": float(best["coast"]),
        "coast_ncc": float(best["ncc"]),
        "continuity": float(best["continuity"]),
        "longest_km": round(best["longest"] / 2 * cfg.res_m / 1000.0, 1),
        "center_lat": clat,
        "center_lon": clon,
        "dot_lat": float(dot_lat),
        "dot_lon": float(dot_lon),
        "theta": round(theta, 2),
        "flip": cand["flip"],
        "mirror": mirror,
        "theta_display": round(theta_display, 2),
        "scale": scale,
        "side_km": round(template.side_m * scale / 1000.0, 2),
        "square": corners,
        "coarse": cand["coarse"],
        "tile": cand["tile"],
        "climate": climate,
        "climate_name": climate_name(climate),
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
        if cand is None:
            continue
        if cfg.climate and not climate_allowed(climate_at(cand["lat"], cand["lon"]), cfg):
            continue
        refined = refine(template, cfg, cand)
        if refined is not None:
            out.append(refined)
        if len(out) >= cfg.refine_per_tile:
            break
    return out


def merge(candidates, cfg, top=None):
    candidates = sorted(candidates, key=lambda c: c["score"], reverse=True)
    kept = []
    limit = top or cfg.top
    for cand in candidates:
        far = all(
            haversine_km(cand["center_lat"], cand["center_lon"], k["center_lat"], k["center_lon"]) >= cfg.min_sep_km
            for k in kept
        )
        if far:
            kept.append(cand)
        if len(kept) >= limit:
            break
    for rank, cand in enumerate(kept, start=1):
        cand["rank"] = rank
    return kept


def run_search(template, variants, cfg, progress=None, on_candidates=None):
    tiles = [t for t in make_tiles(cfg) if tile_may_contain(t, cfg)]
    candidates = []
    if cfg.workers <= 1:
        _init(template, variants, cfg)
        for tile in tiles:
            found = process_tile(tile)
            candidates.extend(found)
            if progress:
                progress(1)
            if on_candidates and found:
                on_candidates(candidates)
    else:
        ctx = multiprocessing.get_context("fork")
        with ProcessPoolExecutor(
            max_workers=cfg.workers, mp_context=ctx, initializer=_init, initargs=(template, variants, cfg)
        ) as pool:
            futures = [pool.submit(process_tile, t) for t in tiles]
            for fut in as_completed(futures):
                found = fut.result()
                candidates.extend(found)
                if progress:
                    progress(1)
                if on_candidates and found:
                    on_candidates(candidates)
    return merge(candidates, cfg, top=max(cfg.top, cfg.vector_top)), len(tiles), len(candidates)
