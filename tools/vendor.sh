#!/usr/bin/env bash
# Refresh the vendored copies of MapLibre GL JS and the OpenFreeMap styles.
# Usage: tools/vendor.sh [maplibre-version]
set -euo pipefail
cd "$(dirname "$0")/.."
V="${1:-$(cat docs/vendor/VERSION 2>/dev/null || echo 5.24.0)}"
mkdir -p docs/vendor/styles
curl -fsSL "https://unpkg.com/maplibre-gl@$V/dist/maplibre-gl.js" -o docs/vendor/maplibre-gl.js
curl -fsSL "https://unpkg.com/maplibre-gl@$V/dist/maplibre-gl.css" -o docs/vendor/maplibre-gl.css
for s in positron dark liberty bright fiord; do
  curl -fsSL "https://tiles.openfreemap.org/styles/$s" -o "docs/vendor/styles/$s.json"
done
echo "$V" > docs/vendor/VERSION
ls -la docs/vendor docs/vendor/styles | awk '{print $5, $9}'
