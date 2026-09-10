import json
import math
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ..geo import set_land_source
from ..search import SearchConfig, make_tiles, tile_may_contain
from ..template import Template

ROOT = Path(__file__).resolve().parents[2]
STATIC = Path(__file__).resolve().parent / "static"
RESULTS = Path(os.environ.get("COASTLINE_RESULTS", ROOT / "results")).resolve()
PREVIEWS = RESULTS / ".previews"
RESULTS.mkdir(parents=True, exist_ok=True)
PREVIEWS.mkdir(parents=True, exist_ok=True)

NOMINATIM = "https://nominatim.openstreetmap.org"
PHOTON = "https://photon.komoot.io"
USER_AGENT = "coastline-twin/0.1 (personal localhost tool)"
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$")

app = FastAPI(title="Coastline Twin")

_running: dict[str, subprocess.Popen] = {}
_lock = threading.Lock()
_geo_lock = threading.Lock()
_last_geo = 0.0
_nominatim_down_until = 0.0


class Location(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class PreviewRequest(BaseModel):
    home: Location
    center: Optional[Location] = None
    side_km: float = Field(default=60, ge=5, le=1000)
    res_m: Optional[float] = None


class JobRequest(PreviewRequest):
    rot_max: float = 45
    rot_step: float = 15
    scales: list[float] = [1.0, 1.25]
    flip: bool = True
    top: int = Field(default=15, ge=1, le=100)
    min_score: float = 0.5
    detail_weight: float = Field(default=0.5, ge=0, le=1)
    band_px: int = Field(default=2, ge=0, le=5)
    lat_band: Optional[float] = None
    same_hemisphere: bool = False
    bbox: Optional[list[float]] = None
    exclude_km: Optional[float] = None
    min_sep_km: Optional[float] = None
    workers: Optional[int] = None
    label: Optional[str] = None


def _throttled_get(url, params, timeout=10):
    global _last_geo, _nominatim_down_until
    primary = url.startswith(NOMINATIM)
    if primary and time.time() < _nominatim_down_until:
        raise httpx.HTTPError("nominatim skipped after a recent failure")
    with _geo_lock:
        wait = 1.0 - (time.time() - _last_geo)
        if wait > 0:
            time.sleep(wait)
        try:
            r = httpx.get(url, params=params, headers={"User-Agent": USER_AGENT}, timeout=timeout)
        except httpx.HTTPError:
            if primary:
                _nominatim_down_until = time.time() + 300
            raise
        finally:
            _last_geo = time.time()
    if r.status_code != 200:
        if primary:
            _nominatim_down_until = time.time() + 300
        raise httpx.HTTPError(f"{url} returned {r.status_code}")
    return r.json()


def _photon_name(props):
    street = " ".join(p for p in [props.get("housenumber"), props.get("street")] if p)
    parts = []
    for key in ["name", "street", "district", "city", "county", "state", "postcode", "country"]:
        value = street if key == "street" else props.get(key)
        if value and value not in parts:
            parts.append(value)
    return ", ".join(parts)


def _geocode(q):
    errors = []
    try:
        rows = _throttled_get(f"{NOMINATIM}/search", {"q": q, "format": "jsonv2", "limit": 6, "addressdetails": 1}, timeout=6)
        return [
            {"lat": float(r["lat"]), "lon": float(r["lon"]), "name": r.get("display_name", ""), "type": r.get("type", "")}
            for r in rows
        ]
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        errors.append(f"nominatim: {exc}")
    try:
        data = _throttled_get(f"{PHOTON}/api/", {"q": q, "limit": 6})
        out = []
        for f in data.get("features", []):
            lon, lat = f["geometry"]["coordinates"]
            props = f.get("properties", {})
            out.append({"lat": float(lat), "lon": float(lon), "name": _photon_name(props), "type": props.get("osm_value", props.get("type", ""))})
        return out
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        errors.append(f"photon: {exc}")
    raise HTTPException(502, "Geocoder unreachable (" + "; ".join(errors) + ")")


def _reverse(lat, lon):
    try:
        r = _throttled_get(f"{NOMINATIM}/reverse", {"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 14}, timeout=6)
        return {"name": r.get("display_name", ""), "address": r.get("address", {})}
    except (httpx.HTTPError, ValueError):
        pass
    try:
        data = _throttled_get(f"{PHOTON}/reverse", {"lat": lat, "lon": lon})
        feats = data.get("features", [])
        if not feats:
            return {"name": "", "address": {}}
        props = feats[0].get("properties", {})
        return {"name": _photon_name(props), "address": props}
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, f"Geocoder unreachable: {exc}") from exc


@app.get("/api/geocode")
def geocode(q: str):
    q = q.strip()
    if not q:
        return []
    return _geocode(q)


@app.get("/api/reverse")
def reverse(lat: float, lon: float):
    return _reverse(lat, lon)


def _cli_args(req: PreviewRequest, name: str, out: Path, dry_run: bool):
    args = [sys.executable, "-m", "coastline_twin", "--home", str(req.home.lat), str(req.home.lon)]
    if req.center is not None:
        args += ["--center", str(req.center.lat), str(req.center.lon)]
    args += ["--side-km", str(req.side_km), "--out", str(out), "--name", name]
    if req.res_m:
        args += ["--res-m", str(req.res_m)]
    if dry_run:
        args.append("--dry-run")
        return args
    job: JobRequest = req
    args += [
        "--rot-max", str(job.rot_max),
        "--rot-step", str(job.rot_step),
        "--scales", ",".join(str(s) for s in job.scales),
        "--top", str(job.top),
        "--min-score", str(job.min_score),
        "--detail-weight", str(job.detail_weight),
        "--band-px", str(job.band_px),
    ]
    if not job.flip:
        args.append("--no-flip")
    if job.lat_band is not None:
        args += ["--lat-band", str(job.lat_band)]
    if job.same_hemisphere:
        args.append("--same-hemisphere")
    if job.bbox:
        if len(job.bbox) != 4:
            raise HTTPException(422, "bbox needs four numbers")
        args += ["--bbox"] + [str(v) for v in job.bbox]
    if job.exclude_km is not None:
        args += ["--exclude-km", str(job.exclude_km)]
    if job.min_sep_km is not None:
        args += ["--min-sep-km", str(job.min_sep_km)]
    if job.workers:
        args += ["--workers", str(job.workers)]
    return args


def _read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def _mask():
    global _mask_tiles
    if _mask_tiles is None:
        _mask_tiles = MaskTiles(ROOT / "docs" / "data")
        set_land_source(_mask_tiles.land)
    return _mask_tiles


@app.post("/api/preview")
def preview(req: PreviewRequest):
    _mask()
    home = (req.home.lat, req.home.lon)
    center = (req.center.lat, req.center.lon) if req.center else home
    side_m = req.side_km * 1000.0
    res_m = req.res_m or max(1000.0, side_m / 160.0)
    template = Template(home, center, side_m, res_m)
    stats = template.stats()
    if stats["land_fraction"] in (0.0, 1.0):
        raise HTTPException(400, "The home square has no coastline at this size. Move the center or enlarge the square.")
    scales = [1.0, 1.25]
    max_ext = max(template.footprint_extent(45.0, sc) for sc in scales)
    cfg = SearchConfig(
        res_m=res_m, tile_half_m=600_000.0 + max_ext, min_score=0.5, nms_px=3, per_tile=1, home=home,
        exclude_km=0.0, min_sep_km=0.0, top=1, bbox=None, lat_band=None, same_hemisphere=False, workers=1,
    )
    tiles = sum(1 for t in make_tiles(cfg) if tile_may_contain(t, cfg))
    warnings = []
    if template.n < 24:
        warnings.append(f"Only {template.n} pixels across at this size, matches will be coarse.")
    if stats["coast_ratio"] < 0.5:
        warnings.append("Very little coastline in the square, matches will be loose.")
    return {
        "home": home, "center": center, "side_km": req.side_km, "res_m": res_m, "n": template.n,
        "stats": stats, "tiles": tiles, "variants": 7 * 2 * len(scales), "dot_xy_m": template.dot_xy,
        "land": "".join("1" if v else "0" for v in template.land.ravel()), "warnings": warnings,
    }


def _job_path(job_id: str):
    if not ID_RE.match(job_id):
        raise HTTPException(400, "bad job id")
    return RESULTS / job_id


def _write_job(path: Path, job: dict):
    (path / "job.json").write_text(json.dumps(job))


def _finalize(path: Path, job: dict, returncode):
    if (path / "matches.json").exists() and returncode == 0:
        job["status"] = "done"
    elif job.get("status") == "cancelling":
        job["status"] = "cancelled"
    else:
        job["status"] = "failed"
        log = (path / "log.txt").read_text(errors="replace") if (path / "log.txt").exists() else ""
        lines = [line for line in log.replace("\r", "\n").splitlines() if line.strip() and "tile/s" not in line]
        job["error"] = lines[-1] if lines else "process exited without output"
    job["finished"] = time.time()
    _write_job(path, job)


def _load_job(job_id: str):
    path = _job_path(job_id)
    if not path.is_dir():
        raise HTTPException(404, "no such run")
    job = _read_json(path / "job.json")
    meta = _read_json(path / "matches.json")
    if job is None:
        if meta is None:
            raise HTTPException(404, "no such run")
        job = {
            "id": job_id,
            "label": job_id,
            "status": "done",
            "started": path.stat().st_mtime,
            "finished": path.stat().st_mtime,
            "params": {
                "home": {"lat": meta["meta"]["home"][0], "lon": meta["meta"]["home"][1]},
                "side_km": meta["meta"]["side_km"],
            },
        }
    if job.get("status") in ("running", "cancelling"):
        with _lock:
            proc = _running.get(job_id)
        if proc is None:
            _finalize(path, job, 0 if meta else 1)
        elif proc.poll() is not None:
            _finalize(path, job, proc.returncode)
            with _lock:
                _running.pop(job_id, None)
    return path, job


def _summary(path: Path, job: dict):
    out = dict(job)
    out["progress"] = _read_json(path / "progress.json")
    out["template"] = _read_json(path / "template.json")
    meta = _read_json(path / "matches.json")
    if meta:
        out["top"] = meta["matches"][:1]
        out["count"] = len(meta["matches"])
        out["seconds"] = meta["meta"].get("seconds")
    return out


@app.post("/api/jobs")
def create_job(req: JobRequest):
    job_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
    path = RESULTS / job_id
    path.mkdir(parents=True)
    log = open(path / "log.txt", "w")
    proc = subprocess.Popen(
        _cli_args(req, job_id, RESULTS, False),
        cwd=ROOT,
        stdout=log,
        stderr=subprocess.STDOUT,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    job = {
        "id": job_id,
        "label": req.label or f"{req.side_km:g} km at {req.home.lat:.3f}, {req.home.lon:.3f}",
        "status": "running",
        "started": time.time(),
        "pid": proc.pid,
        "params": json.loads(req.model_dump_json()),
    }
    _write_job(path, job)
    with _lock:
        _running[job_id] = proc
    return _summary(path, job)


@app.get("/api/jobs")
def list_jobs():
    out = []
    for path in RESULTS.iterdir():
        if not path.is_dir() or path.name.startswith("."):
            continue
        if not (path / "job.json").exists() and not (path / "matches.json").exists():
            continue
        try:
            p, job = _load_job(path.name)
        except HTTPException:
            continue
        out.append(_summary(p, job))
    out.sort(key=lambda j: j.get("started", 0), reverse=True)
    return out


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    path, job = _load_job(job_id)
    out = _summary(path, job)
    meta = _read_json(path / "matches.json")
    if meta:
        out["matches"] = meta["matches"]
        out["meta"] = meta["meta"]
        out["files"] = {
            "json": f"/results/{job_id}/matches.json",
            "geojson": f"/results/{job_id}/matches.geojson",
            "sheet": f"/results/{job_id}/matches.png",
            "template": f"/results/{job_id}/template.png",
            "report": f"/results/{job_id}/report.html",
        }
    return out


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    path, job = _load_job(job_id)
    with _lock:
        proc = _running.get(job_id)
    if proc is None or proc.poll() is not None:
        return _summary(path, job)
    job["status"] = "cancelling"
    _write_job(path, job)
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    _finalize(path, job, proc.returncode)
    with _lock:
        _running.pop(job_id, None)
    return _summary(path, job)


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    path, job = _load_job(job_id)
    if job.get("status") in ("running", "cancelling"):
        cancel_job(job_id)
    shutil.rmtree(path, ignore_errors=True)
    return JSONResponse({"deleted": job_id})


class MaskTiles:
    def __init__(self, data_dir: Path):
        self.dir = data_dir
        self.index = json.loads((data_dir / "index.json").read_text())
        self.cache: dict[tuple, "np.ndarray"] = {}

    def tile(self, i, j):
        key = (i, j)
        if key not in self.cache:
            from PIL import Image
            import numpy as np

            if len(self.cache) > 64:
                self.cache.pop(next(iter(self.cache)))
            img = Image.open(self.dir / "tiles" / f"r{i}_c{j}.png").convert("L")
            self.cache[key] = np.asarray(img) > 127
        return self.cache[key]

    def land(self, lat, lon):
        import numpy as np

        ix = self.index
        T = ix["tile"]
        li = np.clip(np.trunc((lat - ix["lat0"]) / ix["dlat"]).astype(int), 0, ix["rows"] * T - 1)
        lon = (lon + 180.0) % 360.0 - 180.0
        lo = np.clip(np.trunc((lon - ix["lon0"]) / ix["dlon"]).astype(int), 0, ix["cols"] * T - 1)
        ti, tj = li // T, lo // T
        out = np.zeros(lat.shape, dtype=bool)
        for i in np.unique(ti):
            for j in np.unique(tj[ti == i]):
                sel = (ti == i) & (tj == j)
                cls = ix["classes"][i][j]
                if cls != 2:
                    out[sel] = bool(cls)
                else:
                    out[sel] = self.tile(i, j)[li[sel] - i * T, lo[sel] - j * T]
        return out


_mask_tiles: Optional[MaskTiles] = None


@app.get("/api/mask.png")
def mask_png(w: float, s: float, e: float, n: float, width: int = 768, height: int = 512):
    global _mask_tiles
    import io

    import numpy as np
    from PIL import Image

    if _mask_tiles is None:
        _mask_tiles = MaskTiles(ROOT / "docs" / "data")
    width = int(min(max(width, 16), 1536))
    height = int(min(max(height, 16), 1536))
    s, n = max(-85.0, s), min(85.0, n)
    if e <= w or n <= s:
        raise HTTPException(422, "empty bounds")
    merc = lambda lat: math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    top, bottom = merc(n), merc(s)
    ym = top + (bottom - top) * (np.arange(height) + 0.5) / height
    lat = np.degrees(np.arctan(np.sinh(ym)))
    lon = w + (e - w) * (np.arange(width) + 0.5) / width
    LON, LAT = np.meshgrid(lon, lat)
    land = _mask_tiles.land(LAT, LON)
    rgba = np.empty((height, width, 4), dtype=np.uint8)
    rgba[land] = (217, 201, 163, 255)
    rgba[~land] = (158, 202, 225, 255)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=False)
    return Response(buf.getvalue(), media_type="image/png", headers={"Cache-Control": "no-store"})


@app.get("/api/health")
def health():
    return {"ok": True, "results": str(RESULTS), "cpus": os.cpu_count()}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/static/geo.js")
def shared_geo():
    return FileResponse(ROOT / "docs" / "geo.js", media_type="application/javascript")


@app.get("/static/style.css")
def shared_style():
    return FileResponse(ROOT / "docs" / "style.css", media_type="text/css")


app.mount("/results", StaticFiles(directory=RESULTS), name="results")
app.mount("/static", StaticFiles(directory=STATIC), name="static")
