import argparse
import json
import os
import time
from pathlib import Path

import numpy as np

from tqdm import tqdm

from .search import SearchConfig, climate_at, climate_name, make_tiles, run_search, tile_may_contain
from .template import Template, rotation_list


def build_parser():
    p = argparse.ArgumentParser(
        prog="coastline-twin",
        description="Find coastlines elsewhere on Earth that look like the one around you.",
    )
    p.add_argument("--home", nargs=2, type=float, metavar=("LAT", "LON"), help="the dot: where you live")
    p.add_argument("--template", metavar="FILE", help="JSON drawn coastline {n, land, dot} instead of a place")
    p.add_argument("--center", nargs=2, type=float, metavar=("LAT", "LON"), help="square center, defaults to home")
    p.add_argument("--side-km", type=float, default=60.0, help="side of the square snapshot in km")
    p.add_argument("--res-m", type=float, help="meters per pixel, default max(1000, side/160)")
    p.add_argument("--rot-max", type=float, default=45.0, help="max rotation in degrees each way, 180 searches all")
    p.add_argument("--rot-step", type=float, default=15.0, help="rotation step in degrees")
    p.add_argument("--scales", default="1,1.25", help="comma separated size multipliers to try")
    p.add_argument("--no-flip", action="store_true", help="do not try mirror images")
    p.add_argument("--top", type=int, default=15, help="how many matches to keep")
    p.add_argument("--min-score", type=float, default=0.5, help="drop peaks below this score")
    p.add_argument("--detail-weight", type=float, default=0.5, help="0 scores land masks only, 1 scores coastline overlap only")
    p.add_argument("--band-px", type=int, default=2, help="how many pixels to widen the coastline band each side")
    p.add_argument("--supersample", type=int, default=2, help="sub-samples per pixel edge when rasterizing")
    p.add_argument("--exclude-km", type=float, help="ignore matches this close to home, default 2x side")
    p.add_argument("--min-sep-km", type=float, help="minimum distance between reported matches, default side")
    p.add_argument("--bbox", nargs=4, type=float, metavar=("LATMIN", "LONMIN", "LATMAX", "LONMAX"), help="only search inside this box")
    p.add_argument("--lat-band", type=float, help="only accept matches within this many degrees of your absolute latitude")
    p.add_argument("--same-hemisphere", action="store_true", help="only accept matches in your hemisphere")
    p.add_argument("--climate", default="", help="same, group, or Köppen group letters like C,D; empty for any")
    p.add_argument("--workers", type=int, help="processes, default min(cpu-2, 12)")
    p.add_argument("--out", default="results", help="output root")
    p.add_argument("--name", help="run name, default timestamp")
    p.add_argument("--dry-run", action="store_true", help="build the template and report tile count, no search")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    if not args.home and not args.template:
        print("Give --home LAT LON or --template FILE.")
        return 2
    home = (args.home[0], args.home[1]) if args.home else None
    center = tuple(args.center) if args.center else home
    side_m = args.side_km * 1000.0
    res_m = args.res_m or max(1000.0, side_m / 160.0)
    grid = dot_px = None
    if args.template:
        spec = json.loads(Path(args.template).read_text())
        g = int(spec["n"])
        grid = np.array([ch == "1" for ch in spec["land"]], dtype=bool).reshape(g, g)
        dot_px = spec.get("dot")
    scales = [float(s) for s in args.scales.split(",") if s.strip()]
    thetas = rotation_list(args.rot_max, args.rot_step)
    flips = [False] if args.no_flip else [False, True]
    workers = args.workers or max(1, min((os.cpu_count() or 2) - 2, 12))

    template = Template(home, center, side_m, res_m, args.supersample, args.band_px, grid=grid, dot_px=dot_px)
    stats = template.stats()
    if template.n < 24:
        print(f"warning: the square is only {template.n} px wide at {res_m:.0f} m/px, matches will be coarse")
    if stats["land_fraction"] in (0.0, 1.0):
        print("The home square has no coastline at this size. Move the center or enlarge --side-km.")
        return 2
    if stats["coast_ratio"] < 0.5:
        print(f"warning: very little coastline in the square (coast ratio {stats['coast_ratio']:.2f}), matches will be loose")

    max_ext = max(template.footprint_extent(45.0, s) for s in scales)
    cfg = SearchConfig(
        res_m=res_m,
        tile_half_m=600_000.0 + max_ext,
        min_score=args.min_score,
        nms_px=max(3, template.n // 2),
        per_tile=40,
        home=home,
        exclude_km=(args.exclude_km if args.exclude_km is not None else 2 * args.side_km) if home else 0.0,
        min_sep_km=args.min_sep_km if args.min_sep_km is not None else args.side_km,
        top=args.top,
        bbox=tuple(args.bbox) if args.bbox else None,
        lat_band=args.lat_band,
        same_hemisphere=args.same_hemisphere,
        workers=workers,
        supersample=args.supersample,
        band_width=args.band_px,
        detail_weight=args.detail_weight,
        rot_step=args.rot_step,
        rot_max=args.rot_max,
        climate=args.climate,
        home_climate=climate_at(home[0], home[1]) if home else None,
    )

    run_name = args.name or time.strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.out) / run_name
    out_dir.mkdir(parents=True, exist_ok=True)

    from . import report

    report.render_template(template, out_dir / "template.png")
    n_tiles = sum(1 for t in make_tiles(cfg) if tile_may_contain(t, cfg))
    n_variants = len(thetas) * len(flips) * len(scales)
    (out_dir / "template.json").write_text(
        json.dumps(
            {
                "home": home,
                "center": center,
                "side_km": args.side_km,
                "res_m": res_m,
                "stats": stats,
                "tiles": n_tiles,
                "variants": n_variants,
                "dot_xy_m": template.dot_xy,
                "n": template.n,
                "land": "".join("1" if v else "0" for v in template.land.ravel()),
                "climate": climate_at(home[0], home[1]) if home else None,
                "climate_name": climate_name(climate_at(home[0], home[1])) if home else None,
            }
        )
    )
    where = f"centered {center[0]:.4f}, {center[1]:.4f}" if center else "drawn by hand"
    print(
        f"Home square: {args.side_km:g} km {where} at {res_m:.0f} m/px "
        f"({template.n} px). Land {stats['land_fraction'] * 100:.0f}%, coast ratio {stats['coast_ratio']:.2f}."
    )
    print(
        f"Variants: {len(thetas)} rotations x {len(flips)} flips x {len(scales)} scales = {n_variants}. "
        f"Tiles: {n_tiles}. Workers: {workers}. Output: {out_dir}"
    )
    if args.dry_run:
        return 0

    t0 = time.time()
    variants = template.variants(thetas, flips, scales)
    bar = tqdm(total=n_tiles, unit="tile")
    progress_path = out_dir / "progress.json"
    state = {"done": 0, "written": 0.0}

    def advance(k):
        bar.update(k)
        state["done"] += k
        now = time.time()
        if now - state["written"] >= 0.5 or state["done"] >= n_tiles:
            state["written"] = now
            elapsed = now - t0
            rate = state["done"] / elapsed if elapsed > 0 else 0.0
            eta = (n_tiles - state["done"]) / rate if rate > 0 else None
            progress_path.write_text(
                json.dumps({"done": state["done"], "total": n_tiles, "elapsed": round(elapsed, 1), "eta": eta})
            )

    progress_path.write_text(json.dumps({"done": 0, "total": n_tiles, "elapsed": 0.0, "eta": None}))
    matches, n_tiles, n_candidates = run_search(template, variants, cfg, progress=advance)
    bar.close()
    elapsed = time.time() - t0

    matches = report.reverse_geocode(matches)
    meta = {
        "home": home,
        "center": center,
        "side_km": args.side_km,
        "res_m": res_m,
        "rotations": thetas,
        "flips": flips,
        "scales": scales,
        "variants": n_variants,
        "tiles": n_tiles,
        "candidates": n_candidates,
        "seconds": round(elapsed, 1),
        "stats": stats,
        "detail_weight": cfg.detail_weight,
        "band_px": cfg.band_width,
        "supersample": cfg.supersample,
        "filters": {
            "bbox": cfg.bbox,
            "lat_band": cfg.lat_band,
            "same_hemisphere": cfg.same_hemisphere,
            "exclude_km": cfg.exclude_km,
            "min_sep_km": cfg.min_sep_km,
            "min_score": cfg.min_score,
            "climate": cfg.climate,
        },
        "home_climate": cfg.home_climate,
    }
    report.write_json(template, matches, meta, out_dir / "matches.json")
    report.write_geojson(template, matches, out_dir / "matches.geojson")
    report.render_sheet(template, matches, out_dir / "matches.png")
    report.write_html(template, matches, meta, out_dir / "report.html", "matches.png", "template.png")
    print(f"Searched {n_tiles} tiles in {elapsed:.0f} s, {n_candidates} raw peaks.")
    report.print_table(matches)
    print(f"Report: {out_dir / 'report.html'}")
    return 0
