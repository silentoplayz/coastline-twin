import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from global_land_mask import globe

TILE = 1200
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/data")


def main():
    mask = np.logical_not(globe._mask)
    lat = globe._lat
    lon = globe._lon
    rows, cols = mask.shape
    assert rows % TILE == 0 and cols % TILE == 0
    n_rows, n_cols = rows // TILE, cols // TILE
    tiles_dir = OUT / "tiles"
    tiles_dir.mkdir(parents=True, exist_ok=True)
    classes = []
    mixed = 0
    total_bytes = 0
    for i in range(n_rows):
        row = []
        for j in range(n_cols):
            block = mask[i * TILE : (i + 1) * TILE, j * TILE : (j + 1) * TILE]
            if not block.any():
                row.append(0)
                continue
            if block.all():
                row.append(1)
                continue
            row.append(2)
            mixed += 1
            img = Image.fromarray(block.astype(np.uint8) * 255).convert("1")
            path = tiles_dir / f"r{i}_c{j}.png"
            img.save(path, optimize=True)
            total_bytes += path.stat().st_size
        classes.append(row)
    index = {
        "tile": TILE,
        "rows": n_rows,
        "cols": n_cols,
        "lat0": float(lat[0]),
        "dlat": float(lat[1] - lat[0]),
        "lon0": float(lon[0]),
        "dlon": float(lon[1] - lon[0]),
        "lat_min": float(lat.min()),
        "lat_max": float(lat.max()),
        "lon_min": float(lon.min()),
        "lon_max": float(lon.max()),
        "classes": classes,
        "source": "global-land-mask (GLOBE 30 arc-second)",
    }
    (OUT / "index.json").write_text(json.dumps(index))
    print(f"{mixed} mixed tiles, {total_bytes / 1e6:.1f} MB of PNG, grid {n_rows}x{n_cols}")
    print(f"lat {lat[0]}..{lat[-1]} step {lat[1]-lat[0]}, lon {lon[0]}..{lon[-1]} step {lon[1]-lon[0]}")


if __name__ == "__main__":
    main()
