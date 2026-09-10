# Coastline Twin

Take a square snapshot of the coastline around where you live, then search the
whole planet for the places whose coastline lines up with it. Wherever your
home dot lands on the best overlay is where you "move" to.

**Try it in your browser: https://silentoplayz.github.io/coastline-twin/**

The website needs no server. The land mask ships as 1.3 MB of 1-bit PNG tiles,
the matcher runs in Web Workers, and a full-planet search takes about two
minutes on a laptop. Results land on a MapLibre globe, and every match has a
Compare view: your home and the match side by side on real map imagery, with
the match rotated, mirrored, and scaled so the coastlines sit the same way,
and your home coastline drawn over it in red. The Python app below is the
same idea at full resolution everywhere and is the reference the site was
checked against.

## How it works

1. **Home square.** A square of `--side-km` kilometers centered on your home
   (or on `--center`) is rasterized from a 30 arc-second global land mask,
   about 1 km per pixel, in a local azimuthal equidistant projection so the
   shape is not distorted.
2. **Variants.** The square is rotated, mirrored, and rescaled into every
   combination you allow. Default is 7 rotations within plus or minus 45
   degrees, both mirror states, and three sizes (0.8x, 1x, 1.25x).
3. **World search.** Earth is cut into overlapping tiles about 1,200 km wide,
   each rasterized in its own local projection. Every variant is slid across
   every tile with FFT normalized cross-correlation. Tiles with no coastline
   are skipped.
4. **Score.** Two normalized correlations are blended: the land and water
   masks, and a narrow coastline band. The band term is what stops a straight
   beach from matching every other straight beach. `--detail-weight` sets the
   blend, 1.0 is identical.
5. **Results.** Peaks are deduplicated, the home neighborhood is excluded, and
   the top matches are written as JSON, GeoJSON, a contact sheet PNG, and an
   HTML report with map links. The dot is carried through the same rotation,
   mirror, and scale, so its landing point is reported per match.

## The app

```bash
./start.sh
```

Then open http://localhost:8790. The script creates the virtualenv on first
run. Pass `--port 9000` or `--host 0.0.0.0` to change where it listens.

What the page does:

- **Where you live.** Type an address, a place name, or `lat, lon` and press
  Find. Pick from the suggestions, click the map, or drag the red pin. The
  address under the coordinates comes from a reverse lookup.
- **The square.** Slide the side length, and optionally drag a separate blue
  pin to center the square somewhere other than your home. The preview on the
  left is the exact land mask the search will use, with the pixel count, land
  fraction, coastline ratio, and the number of world tiles it will scan.
- **Matching and filters.** Rotation range, mirror images, sizes, detail
  weight, hemisphere, latitude band, and a region limit taken from the current
  map view.
- **Search the planet.** Progress shows tiles done and the time left. Cancel at
  any point. When it finishes the matches appear as cards and as numbered pins
  on the map, each with the matched square drawn on it. Click a card to fly
  there. The other tabs hold the contact sheet and the downloadable files.
- **Runs.** Every run is kept under `results/` and listed in the Runs dialog,
  where you can reopen or delete it. A run that is still going when you reload
  the page reattaches automatically.

Geocoding goes to Nominatim first and falls back to Photon, both OpenStreetMap
based, both free for light personal use. Map tiles come from OpenStreetMap.
Everything else runs locally.

## Command line

```bash
.venv/bin/python -m coastline_twin --home 32.0 -80.85 --side-km 60
```

Output lands in `results/<timestamp>/`. Open `report.html` for the table and
the contact sheet, or drop `matches.geojson` on https://geojson.io to see the
matched squares on a map. Runs made from the command line show up in the app's
Runs dialog too.

Useful flags:

| Flag | What it does |
| --- | --- |
| `--center LAT LON` | Put the square somewhere other than on the dot |
| `--side-km 100` | Bigger square, more context, coarser pixels |
| `--rot-max 180` | Try every orientation instead of plus or minus 45 degrees |
| `--no-flip` | Do not accept mirror images |
| `--scales 1` | Only match at the same size |
| `--lat-band 8` | Only accept matches within 8 degrees of your absolute latitude |
| `--same-hemisphere` | Keep the seasons the same |
| `--bbox LATMIN LONMIN LATMAX LONMAX` | Restrict the search to one region |
| `--detail-weight 0.7` | Lean harder on coastline detail than on the land mask |
| `--exclude-km 500` | Ignore everything within 500 km of home |
| `--top 30` | Keep more matches |
| `--dry-run` | Print the template stats and tile count, search nothing |

A full-world run with the defaults takes a few minutes on a 12-core box.
Narrow it with `--bbox` or `--lat-band` while you tune.

## Docker

```bash
docker compose up -d --build
```

The app is then at http://localhost:8790 and results persist in `./results`.
For a one-off command line run inside the container:

```bash
docker compose run --rm coastline-twin python -m coastline_twin --home 32.0 -80.85 --side-km 60
```

## Reading the scores

The self-match, home against itself, scores about 0.9 rather than 1.0 because
the search grid is offset from the home grid by a fraction of a pixel. Anything
above 0.8 is a close twin. Between 0.7 and 0.8 the broad shape agrees and some
detail lines up. Below 0.7 you are looking at the same general kind of coast.

Smaller scales win more often than they should, because a 0.8x window has
fewer pixels and is easier to correlate by chance. Pass `--scales 1` when you
want same-size matches only.

Three limits to keep in mind:

- **Resolution.** The land mask is about 1 km. Squares under 25 km give only a
  handful of pixels and the tool warns you. Small islands, rivers, and harbors
  under a kilometer are not in the data.
- **Rotation changes meaning.** A south-facing bay rotated 180 degrees is a
  north-facing bay. Keep `--rot-max` small if aspect matters to you.
- **Shape knows nothing about climate.** Use `--lat-band`, `--same-hemisphere`,
  or `--bbox` to filter first, then let the coastline rank what survives.

## The website

`docs/` is the GitHub Pages site. `tools/export_tiles.py` writes the land mask
as 18 by 36 tiles of 1200 by 1200 one-bit PNGs (all-water and all-land tiles
are recorded in `index.json` instead of stored). `engine.js` runs in a Web
Worker: it samples the tiles into local azimuthal equidistant grids, builds the
template variants, does a coarse full-planet pass with a 512-point FFT per
tile, then refines every candidate at 1 km resolution with a local shift and
rotation search. `app.js` coordinates the workers, draws the map and the
thumbnails on canvases, and keeps past runs in localStorage. The map is
MapLibre GL JS on OpenFreeMap vector tiles, which need no API key. Browsers
without WebGL still get the search, the cards, and the downloads, just no map.

To rebuild the tiles after changing the export:

```bash
.venv/bin/python tools/export_tiles.py docs/data
```

To try the site locally:

```bash
cd docs && python3 -m http.server 8792
```

## Layout

```
coastline_twin/
  geo.py          projections, land mask sampling, coastline band, haversine
  template.py     the home square and its rotated, mirrored, scaled variants
  search.py       world tiling, FFT correlation, peak picking, deduplication
  report.py       reverse geocoding, contact sheet, JSON, GeoJSON, HTML
  cli.py          argument parsing and the run
  web/server.py   FastAPI: geocoding proxy, previews, runs as subprocesses
  web/static/     the local app (Leaflet map, vanilla JS, no build step)
docs/
  index.html      the GitHub Pages app
  app.js          coordinator: map, form, workers, results, saved runs
  engine.js       the matcher, runs in Web Workers
  fft.js          radix-2 2D FFT with two-real packing
  data/           land mask tiles and index
tools/
  export_tiles.py writes docs/data from the global-land-mask package
```
