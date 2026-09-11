import math
from dataclasses import dataclass

import numpy as np

from .geo import LocalFrame, coast_band, is_land, sample_land


def _rot(theta_deg):
    t = math.radians(theta_deg)
    return math.cos(t), math.sin(t)


def forward(px, py, theta_deg, flip, scale):
    c, s = _rot(theta_deg)
    if flip:
        px = -px
    return scale * (c * px - s * py), scale * (s * px + c * py)


def inverse(qx, qy, theta_deg, flip, scale):
    c, s = _rot(theta_deg)
    px = (c * qx + s * qy) / scale
    py = (-s * qx + c * qy) / scale
    if flip:
        px = -px
    return px, py


@dataclass
class Variant:
    index: int
    theta: float
    flip: bool
    scale: float
    size: int
    footprint: np.ndarray
    values: np.ndarray
    norm: float
    band_values: np.ndarray
    band_norm: float
    count: int


class Template:
    def __init__(self, home, center, side_m, res_m, supersample=2, band_width=2, grid=None, dot_px=None):
        self.side_m = float(side_m)
        self.half_m = self.side_m / 2
        self.res_m = float(res_m)
        self.supersample = int(supersample)
        self.band_width = int(band_width)
        self.grid = None
        if grid is not None:
            self.home = None
            self.center = None
            self.frame = None
            self.grid = np.asarray(grid, dtype=bool)
            self.cell_m = self.side_m / self.grid.shape[0]
            self.fraction = self._sample_grid()
            col, row = dot_px if dot_px is not None else (self.grid.shape[0] / 2 - 0.5, self.grid.shape[0] / 2 - 0.5)
            self.dot_xy = (float((col + 0.5) * self.cell_m - self.half_m), float(self.half_m - (row + 0.5) * self.cell_m))
        else:
            self.home = (float(home[0]), float(home[1]))
            self.center = (float(center[0]), float(center[1]))
            self.frame = LocalFrame(*self.center)
            self.fraction = sample_land(self.frame, self.half_m, self.res_m, self.supersample)
            hx, hy = self.frame.to_xy(self.home[0], self.home[1])
            self.dot_xy = (float(hx), float(hy))
        self.land = self.fraction >= 0.5
        self.n = self.land.shape[0]

    def land_xy(self, x, y):
        if self.grid is None:
            lat, lon = self.frame.to_latlon(x, y)
            return is_land(lat, lon)
        g = self.grid.shape[0]
        c = np.clip(np.floor((np.asarray(x) + self.half_m) / self.cell_m).astype(int), 0, g - 1)
        r = np.clip(np.floor((self.half_m - np.asarray(y)) / self.cell_m).astype(int), 0, g - 1)
        return self.grid[r, c]

    def _sample_grid(self):
        n = int(round(2 * self.half_m / self.res_m))
        c = (np.arange(n) + 0.5) * self.res_m - n * self.res_m / 2
        ss = self.supersample
        sub = ((np.arange(ss) + 0.5) / ss - 0.5) * self.res_m
        acc = np.zeros((n, n), dtype=np.float32)
        for du in sub:
            for dv in sub:
                u, v = np.meshgrid(c + du, -c + dv)
                acc += self.land_xy(u, v)
        return acc / (ss * ss)

    def stats(self):
        land = self.land
        edges = np.count_nonzero(land[1:, :] != land[:-1, :]) + np.count_nonzero(
            land[:, 1:] != land[:, :-1]
        )
        return {
            "pixels": int(self.n),
            "land_fraction": float(land.mean()),
            "coast_edges": int(edges),
            "coast_ratio": float(edges / self.n),
        }

    def footprint_extent(self, theta, scale):
        c, s = _rot(theta)
        return self.half_m * scale * (abs(c) + abs(s))

    def variant(self, index, theta, flip, scale):
        ext = self.footprint_extent(theta, scale)
        m = int(math.ceil(2 * ext / self.res_m))
        c = (np.arange(m) + 0.5) * self.res_m - m * self.res_m / 2
        qx, qy = np.meshgrid(c, -c)
        px, py = inverse(qx, qy, theta, flip, scale)
        inside = (np.abs(px) <= self.half_m) & (np.abs(py) <= self.half_m)
        ss = self.supersample
        sub = (np.arange(ss) + 0.5) / ss - 0.5
        frac = np.zeros((m, m), dtype=np.float64)
        for du in sub:
            for dv in sub:
                sx, sy = inverse(qx + du * self.res_m, qy + dv * self.res_m, theta, flip, scale)
                frac[inside] += self.land_xy(sx[inside], sy[inside])
        frac /= ss * ss
        count = int(inside.sum())
        vals = 2.0 * frac - 1.0
        mean = vals[inside].mean()
        zero_mean = np.where(inside, vals - mean, 0.0).astype(np.float32)
        norm = float(np.sqrt(np.sum(zero_mean.astype(np.float64) ** 2)))
        band = coast_band(frac >= 0.5, inside, self.band_width).astype(np.float64)
        band_mean = band[inside].mean()
        band_zero = np.where(inside, band - band_mean, 0.0).astype(np.float32)
        band_norm = float(np.sqrt(np.sum(band_zero.astype(np.float64) ** 2)))
        return Variant(
            index, float(theta), bool(flip), float(scale), m, inside, zero_mean, norm, band_zero, band_norm, count
        )

    def variants(self, thetas, flips, scales):
        out = []
        for scale in scales:
            for theta in thetas:
                for flip in flips:
                    out.append(self.variant(len(out), theta, flip, scale))
        return out

    def dot_offset(self, theta, flip, scale):
        return forward(self.dot_xy[0], self.dot_xy[1], theta, flip, scale)

    def square_corners(self, theta, flip, scale):
        h = self.half_m
        corners = [(-h, -h), (h, -h), (h, h), (-h, h)]
        return [forward(x, y, theta, flip, scale) for x, y in corners]


def rotation_list(rot_max, rot_step):
    if rot_max >= 180:
        return [float(t) for t in np.arange(0.0, 360.0, rot_step)]
    return [float(t) for t in np.arange(-rot_max, rot_max + 1e-9, rot_step)]
