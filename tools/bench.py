"""Matcher benchmark: planted-transform recovery and center-shift stability on a fixed set of coasts.

Usage: python -m tools.bench --name baseline [--rot-step 15] [--band-px 2] [--band-soft 0] [--scales 1,1.25] [--coasts 8]
Writes bench/results/<name>.json and prints a summary table.
"""
import argparse, json, math, sys, time
from pathlib import Path

import numpy as np

from coastline_twin.geo import LocalFrame, haversine_km, is_land
from coastline_twin.search import SearchConfig, run_search
from coastline_twin.template import Template, inverse, rotation_list

COASTS = [
    ("Monterey Bay", 36.80, -121.90), ("False Bay", -34.15, 18.60), ("Naples", 40.80, 14.25), ("Mont-Saint-Michel", 48.65, -1.55),
    ("Tokyo Bay", 35.45, 139.85), ("Lisbon", 38.70, -9.20), ("Sydney", -33.85, 151.25), ("Cape Cod", 41.75, -70.05),
    ("Halifax", 44.60, -63.55), ("Hong Kong", 22.30, 114.15), ("Dakar", 14.70, -17.40), ("Wellington", -41.30, 174.80),
]
PLANTS = [(7.0, False, 1.0), (22.0, True, 1.12), (-13.0, False, 0.9)]


def add_noise(grid, p, seed):
    from scipy.ndimage import binary_dilation
    if p <= 0:
        return grid
    edge = binary_dilation(grid) & ~grid | (binary_dilation(~grid) & grid)
    zone = binary_dilation(edge, iterations=2)
    rng = np.random.default_rng(seed)
    flip = zone & (rng.random(grid.shape) < p)
    return grid ^ flip


def planted_grid(lat, lon, side_m, res_m, theta, flip, scale, ss=2):
    n = int(round(side_m / res_m))
    c = (np.arange(n) + 0.5) * res_m - side_m / 2
    frame = LocalFrame(lat, lon)
    acc = np.zeros((n, n))
    sub = ((np.arange(ss) + 0.5) / ss - 0.5) * res_m
    for du in sub:
        for dv in sub:
            qx, qy = np.meshgrid(c + du, -c + dv)
            px, py = inverse(qx, qy, theta, flip, scale)
            la, lo = frame.to_latlon(px, py)
            acc += is_land(la, lo)
    return acc / (ss * ss) >= 0.5


def make_cfg(args, template, scales, bbox):
    max_ext = max(template.footprint_extent(45.0, s) for s in scales)
    return SearchConfig(
        res_m=args.res_m, tile_half_m=600_000.0 + max_ext, min_score=0.5, nms_px=max(3, template.n // 2), per_tile=40,
        home=None, exclude_km=0.0, min_sep_km=args.side_km, top=15, bbox=bbox, lat_band=None, same_hemisphere=False,
        workers=args.workers, supersample=2, band_width=args.band_px, band_soft=args.band_soft, taper=args.taper, detail_weight=0.5,
        rot_step=args.rot_step, rot_max=45.0, climate=None, home_climate=None, vector_top=0,
    )


def search(args, template, scales):
    thetas = rotation_list(45.0, args.rot_step)
    variants = template.variants(thetas, [False, True], scales)
    matches, n_tiles, _, _ = run_search(template, variants, template.__cfg, progress=None)
    return matches, n_tiles


def near(m, lat, lon, km):
    return haversine_km(m["dot_lat"], m["dot_lon"], lat, lon) <= km


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--side-km", type=float, default=60)
    ap.add_argument("--res-m", type=float, default=1000)
    ap.add_argument("--rot-step", type=float, default=15)
    ap.add_argument("--band-px", type=int, default=2)
    ap.add_argument("--band-soft", type=float, default=0.0)
    ap.add_argument("--taper", type=float, default=0.0)
    ap.add_argument("--scales", default="1,1.25")
    ap.add_argument("--coasts", type=int, default=8)
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--noise", type=float, default=0.0)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args(argv)
    scales = [float(s) for s in args.scales.split(",")]
    side_m = args.side_km * 1000
    out = {"name": args.name, "args": vars(args), "coasts": []}
    t0 = time.time()
    for name, lat, lon in COASTS[: args.coasts]:
        bbox = (lat - 10, lon - 12, lat + 10, lon + 12)
        row = {"coast": name, "plants": [], "stability": None}
        for theta, flip, scale in PLANTS:
            grid = add_noise(planted_grid(lat, lon, side_m, args.res_m, theta, flip, scale), args.noise, args.seed + abs(int(theta)) + int(flip))
            t = Template(None, None, side_m, args.res_m, 2, args.band_px, grid=grid, band_soft=args.band_soft, taper=args.taper)
            t.__cfg = make_cfg(args, t, scales, bbox)
            matches, n_tiles = search(args, t, scales)
            hit = next((m for m in matches if near(m, lat, lon, 8.0)), None)
            others = [m for m in matches if not near(m, lat, lon, 30.0)]
            row["plants"].append({
                "plant": [theta, flip, scale], "rank": hit["rank"] if hit else None, "score": hit["score"] if hit else None,
                "best_other": others[0]["score"] if others else None, "tiles": n_tiles,
                "found_theta": hit["theta"] if hit else None, "found_scale": hit["scale"] if hit else None,
            })
            print(f"{name:18s} plant θ={theta:+5.1f} flip={int(flip)} s={scale:.2f}  rank={hit['rank'] if hit else '-'}  score={hit['score'] if hit else 0:.3f}  best other={others[0]['score'] if others else 0:.3f}", flush=True)
        sets = []
        for dlat_km in (0.0, 5.0):
            clat = lat + dlat_km / 111.0
            t = Template((clat, lon), (clat, lon), side_m, args.res_m, 2, args.band_px, band_soft=args.band_soft, taper=args.taper)
            t.__cfg = make_cfg(args, t, scales, bbox)
            t.__cfg.exclude_km = 2 * args.side_km
            t.__cfg.home = (clat, lon)
            matches, _ = search(args, t, scales)
            sets.append([(m["dot_lat"], m["dot_lon"], m["score"]) for m in matches[:10]])
        a, b = sets
        overlap = sum(1 for (la, lo, _) in a if any(haversine_km(la, lo, lb, lob) <= 30 for (lb, lob, _) in b))
        row["stability"] = {"top10_overlap": overlap, "n": min(len(a), len(b)), "top_score": a[0][2] if a else None}
        print(f"{name:18s} stability: {overlap}/{min(len(a), len(b))} of top 10 survive a 5 km shift; top score {a[0][2] if a else 0:.3f}", flush=True)
        out["coasts"].append(row)
    out["seconds"] = round(time.time() - t0)
    ranks = [p["rank"] for r in out["coasts"] for p in r["plants"]]
    gaps = [p["score"] - p["best_other"] for r in out["coasts"] for p in r["plants"] if p["score"] is not None and p["best_other"] is not None]
    summary = {
        "found_at_1": sum(1 for k in ranks if k == 1), "found_top15": sum(1 for k in ranks if k), "plants": len(ranks),
        "mean_gap": float(np.mean(gaps)) if gaps else None, "min_gap": float(np.min(gaps)) if gaps else None,
        "stability": sum(r["stability"]["top10_overlap"] for r in out["coasts"]) / max(1, sum(r["stability"]["n"] for r in out["coasts"])),
        "seconds": out["seconds"],
    }
    out["summary"] = summary
    Path("bench/results").mkdir(parents=True, exist_ok=True)
    Path(f"bench/results/{args.name}.json").write_text(json.dumps(out, indent=1))
    print("SUMMARY", json.dumps(summary))


if __name__ == "__main__":
    sys.exit(main())
