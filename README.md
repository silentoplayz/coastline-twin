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
   degrees, both mirror states, and two sizes (1x and 1.25x).
3. **World search.** Earth is cut into overlapping tiles about 1,200 km wide,
   each rasterized in its own local projection. Every variant is slid across
   every tile with FFT normalized cross-correlation. Tiles with no coastline
   are skipped.
4. **Score.** Two normalized correlations are blended: the land and water
   masks, and a coastline band two pixels wide on each side of the shoreline.
   The band term is what stops a straight beach from matching every other
   straight beach. `--detail-weight` sets the blend and `--band-px` the band
   width, 1.0 is identical.
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
  on a MapLibre globe, each with the matched square drawn on it. Click a card
  to fly there, or press Compare to see home and match side by side on real
  map imagery with the match rotated, mirrored, and scaled to line up. The
  other tabs hold the contact sheet and the downloadable files.
- **Runs.** Every run is kept under `results/` and listed in the Runs dialog,
  where you can reopen or delete it. A run that is still going when you reload
  the page reattaches automatically.

Geocoding goes to Nominatim first and falls back to Photon, both OpenStreetMap
based, both free for light personal use. The map is MapLibre GL JS on
OpenFreeMap vector tiles. Everything else runs locally. The local app and the
website share `docs/geo.js` and `docs/style.css`, which the server serves
under `/static`.

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
| `--scales 0.8,1,1.25` | Add the smaller window back |
| `--lat-band 8` | Only accept matches within 8 degrees of your absolute latitude |
| `--same-hemisphere` | Keep the seasons the same |
| `--bbox LATMIN LONMIN LATMAX LONMAX` | Restrict the search to one region |
| `--detail-weight 0.7` | Lean harder on coastline detail than on the land mask |
| `--band-px 1` | Count only pixels within 1 km of the shoreline as coast, stricter than the default 2 |
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

## Getting better matches

The matcher compares shapes, so the square you feed it decides everything.
Work through these in order.

1. **Give it a distinctive coastline.** A straight beach matches every other
   straight beach. Inlets, capes, estuaries, barrier islands, and a bay with
   an odd outline are what make a match mean something. The coast ratio in
   the preview is a rough measure of this: below 1 is featureless, 2 to 4 is
   good, above 5 is a maze of islands that only matches another maze.
2. **Aim for a square that is roughly half land.** At 90 percent land the
   score is dominated by the big land mass and any coast in the right place
   scores well. Use Custom center and drag the blue pin so the square sits on
   the coast even when your home is inland. The dot still lands where you
   live.
3. **Pick a size between 40 and 120 km.** The land mask is 1 km, so a 20 km
   square is 20 pixels across and every coast looks alike. Above about 150 km
   the square starts to describe a whole region rather than a place, and the
   matches become continents that happen to bend the same way.
4. **Turn the detail weight up when the results look generic.** At 0.5 the
   score is half land mask and half coastline overlap. Raise it toward 0.8 to
   demand that the actual coastline traces line up. Lower it toward 0.2 if
   your coast is simple and you only care about the broad shape.
5. **Decide what rotation and mirroring mean to you.** A south-facing bay
   rotated 180 degrees faces north, with different light, wind, and weather.
   Keep rotation within 45 degrees and mirroring off if that matters. Use any
   orientation and mirroring when you want pure shape.
6. **Leave the sizes at 1x and 1.25x.** Smaller windows have fewer pixels and
   win by chance more often. Add 0.65x or 0.8x only when you are looking for
   a smaller twin on purpose, and read those scores with suspicion.
7. **Filter for the life you want, then rank by shape.** Same hemisphere keeps
   the seasons. A latitude band of 5 to 10 degrees roughly keeps the climate.
   A region limit finds the best twin inside a country you would actually
   move to. Shape knows nothing about any of this.
8. **Read the two score bars, not just the total.** A high mask bar with a
   low coast bar means the land is in the right place but the shoreline
   differs. A high coast bar is the one that makes the Compare view line up.
9. **Use Compare before you believe a match.** Turn the labels off, drag the
   zoom slider, and look at whether the red home coastline sits on the
   match's actual shoreline or just near it. Then walk through the next few
   matches with the arrows.
10. **Rerun with a shifted square.** Moving the center by 10 km or changing
    the side by 20 percent can change the top match. If the same places keep
    coming back, that is a real twin.

## Reading the scores

The self-match, home against itself, scores about 0.9 rather than 1.0 because
the search grid is offset from the home grid by a fraction of a pixel. Anything
above 0.8 is a close twin. Between 0.7 and 0.8 the broad shape agrees and some
detail lines up. Below 0.7 you are looking at the same general kind of coast.

Smaller scales win more often than they should, because a 0.8x window has
fewer pixels and is easier to correlate by chance. The apps and the command
line therefore leave 0.8x out by default. Pass `--scales 0.8,1,1.25` to add
it back.

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
  web/static/     the local app (MapLibre map, vanilla JS, no build step)
docs/
  index.html      the GitHub Pages app
  app.js          coordinator: map, form, workers, results, saved runs
  engine.js       the matcher, runs in Web Workers
  fft.js          radix-2 2D FFT with two-real packing
  data/           land mask tiles and index
tools/
  export_tiles.py writes docs/data from the global-land-mask package
```
