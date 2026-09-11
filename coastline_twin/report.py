import html
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import ListedColormap

from .geo import LocalFrame, grid_coords, is_land
from .template import forward

LAND_WATER = ListedColormap(["#9ecae1", "#d9c9a3"])


def reverse_geocode(matches):
    try:
        import reverse_geocoder as rg
    except Exception:
        return matches
    if not matches:
        return matches
    try:
        found = rg.search([(m["dot_lat"], m["dot_lon"]) for m in matches], mode=1)
    except Exception:
        return matches
    for m, f in zip(matches, found):
        parts = [f.get("name", ""), f.get("admin1", ""), f.get("cc", "")]
        m["place"] = ", ".join(p for p in parts if p)
    return matches


def sample_match(template, match):
    local = LocalFrame(match["center_lat"], match["center_lon"])
    n, c = grid_coords(template.half_m, template.res_m)
    px, py = np.meshgrid(c, -c)
    qx, qy = forward(px, py, match["theta"], match["flip"], match["scale"])
    lat, lon = local.to_latlon(qx.ravel(), qy.ravel())
    return is_land(lat, lon).reshape(n, n)


def _panel(ax, land, extent_km, dot_km, title):
    ax.imshow(land, cmap=LAND_WATER, vmin=0, vmax=1, extent=extent_km, interpolation="nearest")
    ax.plot(dot_km[0], dot_km[1], "o", color="#d62728", markersize=7, markeredgecolor="white")
    ax.set_title(title, fontsize=9)
    ax.set_xticks([])
    ax.set_yticks([])


def render_template(template, path):
    h = template.half_m / 1000.0
    extent = [-h, h, -h, h]
    dot = (template.dot_xy[0] / 1000.0, template.dot_xy[1] / 1000.0)
    fig, ax = plt.subplots(figsize=(5, 5))
    _panel(ax, template.land, extent, dot, f"Home square, {template.side_m / 1000:.0f} km")
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def render_sheet(template, matches, path, max_rows=12):
    rows = matches[:max_rows]
    if not rows:
        return
    h = template.half_m / 1000.0
    extent = [-h, h, -h, h]
    dot = (template.dot_xy[0] / 1000.0, template.dot_xy[1] / 1000.0)
    n, c = grid_coords(template.half_m, template.res_m)
    xs, ys = np.meshgrid(c / 1000.0, -c / 1000.0)
    fig, axes = plt.subplots(len(rows), 3, figsize=(10.5, 3.5 * len(rows)))
    axes = np.atleast_2d(axes)
    for r, m in enumerate(rows):
        match_land = sample_match(template, m)
        label = m.get("place", f"{m['dot_lat']:.3f}, {m['dot_lon']:.3f}")
        flip = ", mirrored" if m["flip"] else ""
        _panel(axes[r, 0], template.land, extent, dot, "Home square" if r == 0 else "")
        _panel(
            axes[r, 1],
            match_land,
            extent,
            dot,
            f"#{m['rank']}  score {m['score']:.3f}\n{label}",
        )
        _panel(
            axes[r, 2],
            match_land,
            extent,
            dot,
            f"rot {m['theta']:+.0f}°{flip}, {m['side_km']:.0f} km square",
        )
        axes[r, 2].contour(xs, ys, template.land.astype(float), levels=[0.5], colors="#d62728", linewidths=1.2)
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)


def write_json(template, matches, meta, path):
    for m in matches:
        m["window"] = "".join("1" if v else "0" for v in sample_match(template, m).ravel())
    Path(path).write_text(json.dumps({"meta": meta, "matches": matches}, indent=2))


def write_geojson(template, matches, path):
    features = []
    if template.home is not None:
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [template.home[1], template.home[0]]},
            "properties": {"kind": "home"},
        })
    for m in matches:
        props = {k: v for k, v in m.items() if k != "square"}
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [m["dot_lon"], m["dot_lat"]]},
                "properties": {"kind": "dot", **props},
            }
        )
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [m["square"]]},
                "properties": {"kind": "square", "rank": m["rank"], "score": m["score"]},
            }
        )
    Path(path).write_text(json.dumps({"type": "FeatureCollection", "features": features}))


def write_html(template, matches, meta, path, sheet_name, template_name):
    rows = []
    for m in matches:
        osm = f"https://www.openstreetmap.org/?mlat={m['dot_lat']:.5f}&mlon={m['dot_lon']:.5f}#map=11/{m['dot_lat']:.5f}/{m['dot_lon']:.5f}"
        gmaps = f"https://www.google.com/maps/search/?api=1&query={m['dot_lat']:.5f},{m['dot_lon']:.5f}"
        place = html.escape(m.get("place", ""))
        rows.append(
            f"<tr><td>{m['rank']}</td><td>{m['score']:.3f}</td><td>{m['mask_score']:.2f}</td><td>{m['coast_score']:.2f}</td><td>{place}</td>"
            f"<td>{m['dot_lat']:.4f}, {m['dot_lon']:.4f}</td><td>{m['theta']:+.0f}°</td>"
            f"<td>{'yes' if m['flip'] else 'no'}</td><td>{m['side_km']:.0f} km</td>"
            f"<td><a href=\"{osm}\">OSM</a> · <a href=\"{gmaps}\">Google</a></td></tr>"
        )
    body = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Coastline Twin results</title>
<style>
body{{font-family:system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#222}}
table{{border-collapse:collapse;width:100%;font-size:14px}}
td,th{{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}}
img{{max-width:100%}}
code{{background:#f3f3f3;padding:1px 4px}}
</style></head><body>
<h1>Coastline Twin</h1>
<p>{"Home dot at <code>" + f"{template.home[0]:.4f}, {template.home[1]:.4f}" + "</code>" if template.home is not None else "A drawn coastline"}, square of {template.side_m / 1000:.0f} km at {template.res_m:.0f} m per pixel.
Searched {meta['tiles']} tiles, {meta['variants']} template variants, {meta['candidates']} raw peaks, in {meta['seconds']:.0f} s.</p>
<p>Score blends two normalized cross-correlations: the land and water masks (weight {1 - meta['detail_weight']:.2f}) and the coastline band (weight {meta['detail_weight']:.2f}). 1.0 is identical. Rotation is counterclockwise, mirrored means flipped east to west.</p>
<table><thead><tr><th>#</th><th>Score</th><th>Mask</th><th>Coast</th><th>Near</th><th>Dot lands at</th><th>Rotation</th><th>Mirrored</th><th>Square</th><th>Map</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table>
<h2>Home square</h2><img src="{template_name}" alt="home square">
<h2>Matches</h2><p>Left: home. Middle: the match, re-projected into the home frame so the dot sits at the same spot. Right: the match with the home coastline drawn in red.</p>
<img src="{sheet_name}" alt="match sheet">
</body></html>
"""
    Path(path).write_text(body)


def print_table(matches):
    if not matches:
        print("No matches above the score threshold.")
        return
    print(f"{'#':>3} {'score':>6} {'mask':>5} {'coast':>5} {'rot':>6} {'flip':>4} {'scale':>5}  {'dot lands at':<22} near")
    for m in matches:
        flip = "yes" if m["flip"] else "no"
        coords = f"{m['dot_lat']:.4f}, {m['dot_lon']:.4f}"
        print(
            f"{m['rank']:>3} {m['score']:>6.3f} {m['mask_score']:>5.2f} {m['coast_score']:>5.2f} {m['theta']:>+6.0f} {flip:>4} {m['scale']:>5.2f}  {coords:<22} {m.get('place', '')}"
        )
