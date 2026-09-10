import numpy as np
from pyproj import CRS, Transformer

EARTH_RADIUS_KM = 6371.0088

_land_source = None


def set_land_source(fn):
    global _land_source
    _land_source = fn


def _default_land(lat, lon):
    from global_land_mask import globe

    return globe.is_land(lat, lon)


class LocalFrame:
    def __init__(self, lat0, lon0):
        self.lat0 = float(lat0)
        self.lon0 = float(lon0)
        crs = CRS.from_proj4(
            f"+proj=aeqd +lat_0={self.lat0} +lon_0={self.lon0} +datum=WGS84 +units=m +no_defs"
        )
        self._fwd = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        self._inv = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

    def to_xy(self, lat, lon):
        x, y = self._fwd.transform(lon, lat)
        return np.asarray(x, dtype=float), np.asarray(y, dtype=float)

    def to_latlon(self, x, y):
        lon, lat = self._inv.transform(x, y)
        return np.asarray(lat, dtype=float), np.asarray(lon, dtype=float)


def is_land(lat, lon):
    lat = np.clip(np.asarray(lat, dtype=float), -90.0, 90.0)
    lon = (np.asarray(lon, dtype=float) + 180.0) % 360.0 - 180.0
    return np.asarray((_land_source or _default_land)(lat, lon), dtype=bool)


def grid_coords(half_m, res_m):
    n = int(round(2 * half_m / res_m))
    c = (np.arange(n) + 0.5) * res_m - n * res_m / 2
    return n, c


def sample_land(frame, half_m, res_m, supersample=1):
    n, c = grid_coords(half_m, res_m)
    if supersample <= 1:
        u, v = np.meshgrid(c, -c)
        lat, lon = frame.to_latlon(u.ravel(), v.ravel())
        return is_land(lat, lon).reshape(n, n).astype(np.float32)
    ss = int(supersample)
    sub = (np.arange(ss) + 0.5) / ss - 0.5
    fine = (c[:, None] + sub[None, :] * res_m).ravel()
    u, v = np.meshgrid(fine, -fine)
    lat, lon = frame.to_latlon(u.ravel(), v.ravel())
    land = is_land(lat, lon).reshape(n, ss, n, ss)
    return land.mean(axis=(1, 3), dtype=np.float32)


def coast_band(land, valid=None, width=1):
    from scipy.ndimage import binary_dilation

    land = np.asarray(land, dtype=bool)
    if valid is None:
        valid = np.ones_like(land, dtype=bool)
    coast = np.zeros_like(land)
    diff_v = (land[1:, :] != land[:-1, :]) & valid[1:, :] & valid[:-1, :]
    diff_h = (land[:, 1:] != land[:, :-1]) & valid[:, 1:] & valid[:, :-1]
    coast[1:, :] |= diff_v
    coast[:-1, :] |= diff_v
    coast[:, 1:] |= diff_h
    coast[:, :-1] |= diff_h
    if width > 0:
        coast = binary_dilation(coast, iterations=width)
    return coast & valid


def haversine_km(lat1, lon1, lat2, lon2):
    p1 = np.radians(lat1)
    p2 = np.radians(lat2)
    dphi = p2 - p1
    dlam = np.radians(np.asarray(lon2, dtype=float) - np.asarray(lon1, dtype=float))
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dlam / 2) ** 2
    return 2 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(a))
