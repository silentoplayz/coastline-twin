# Maintenance

Coastline Twin is built to need as little care as possible. The search, the
drawing, the analysis, the share cards, and saved runs use only code and
data shipped in this repository. Everything that talks to another server is
listed here with what happens when that server is gone and what to change.

## What is shipped and never changes on its own

- The 1 km land mask (`docs/data/tiles`, 1.3 MB) and the climate map
  (`docs/data/koppen.png`).
- MapLibre GL JS 5.24.0 and its stylesheet, vendored under `docs/vendor/`.
- Copies of the five OpenFreeMap styles under `docs/vendor/styles/`, used
  when the live copies cannot be fetched.
- Basemap thumbnails under `docs/images/basemaps/`.
- Pinned Python packages in `requirements.txt` and a pinned base image in
  the Dockerfile, so a fresh install matches the one that was tested.

Refresh the vendored files with `tools/vendor.sh [maplibre-version]`. Stay on
MapLibre 5.x unless you are ready to convert the page to module scripts:
every 6.x release is ESM-only and 6.0 changed its event classes. The raster
abort workaround in `app.js` is guarded to 5.x and drops out on upgrade.

## External services

| Service | Used for | If it fails | What to do |
|---|---|---|---|
| OpenFreeMap styles (`tiles.openfreemap.org/styles/*`) | Light, Dark, Streets, Bright, Fiord; Details groups; labels over satellite | The app falls back to the vendored style copy, then to the built-in Coastline only basemap, and says so | Nothing. To retire a style, remove it from `BASEMAPS` in both `app.js` files and its card thumbnail |
| OpenFreeMap tiles (`tiles.openfreemap.org/planet`) | Vector basemap tiles; vector sharpening; the fine Compare and Why views | Vector basemaps show no detail; sharpening is skipped and matches keep their 1 km scores; Compare and Why fall back to 1 km | Switch to Coastline only or a raster basemap. For sharpening, point `TILEJSON`/tile URLs in `docs/engine.js` and `coastline_twin/vector.py` at any OpenMapTiles-schema server |
| Esri World Imagery | Satellite basemap | Blank tiles and a toast after a few failures | Pick another basemap, or change the URL in `BASEMAPS.satellite` |
| OpenTopoMap | Topographic basemap | Blank tiles and a toast | Same |
| Mapzen terrain tiles on AWS Open Data | Hillshade, 3D terrain, elevation in the readout | No relief; readout shows no elevation | Any terrarium-encoded DEM works: change `DEM.tiles` in both `app.js` files |
| Photon (komoot) | Address search; place names | Falls back to Nominatim; coordinates still work | Change the endpoint in `geocode`/`reverseGeocode` |
| Nominatim | Fallback geocoding | Places show as coordinates | Same |
| GitHub Pages | Hosting the site | The site is a static folder; `docs/` can be served from anywhere | Any static host; the local app also serves the same pages |

The local app makes the same requests, plus none of its own: the server only
reads the results folder and runs the Python engine.

## Tile caches and memory

The map keeps ten zoom levels of out-of-view tiles per source so zooming
back out never re-fetches, but the two elevation sources are capped at
four levels through the tile manager (an internal field, guarded, 5.x
only), and each is removed and re-added when its overlay is switched off
so its textures are freed. With every source at the same large cap, 3D
terrain plus hillshade held over a thousand textures within a few minutes
of panning and never released them; measured with WebGL object counts in
Chrome and Firefox, see the commit that added this section.

## Two engines that must stay in step

`docs/engine.js` (browser worker) and `coastline_twin/search.py` implement
the same matcher. Any change to scoring, refinement, histogram bins, or the
vector stage goes into both, and the About page describes the method as
implemented. `docs/app.js` and `coastline_twin/web/static/app.js` share
almost all of their code; the local copy differs only in how it talks to
the server.

## Changing the matcher

Run `python -m tools.bench --name before` on the current code and
`--name after` on the change, then compare the SUMMARY lines: planted
near-twins found at rank 1, the mean and minimum margin over the best false
twin, and the share of top-ten twins that survive a 5 km shift of the
square. Every scoring change goes into `docs/engine.js` and
`coastline_twin/search.py` alike, and the About page's method text
describes what ships.

## How to check the app is healthy

1. Open the site, drop a pin on any coast, run a 60 km search limited to
   the current view under Region. It should finish in under a minute with
   fifteen matches and a `placements scored` figure in the header.
2. Open Compare on the top match. Green and red coastline should draw on
   both panes and the caption should say `shoreline at N m`.
3. Under Layers, switch basemaps. Each should draw; Coastline only draws
   from shipped data alone.

If step 1 works and nothing else does, the outside services are down and
the app is fine.
