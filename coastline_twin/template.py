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
    def __init__(self, home, center, side_m, res_m, supersample=2, band_width=2):
        self.home = (float(home[0]), float(home[1]))
        self.center = (float(center[0]), float(center[1]))
        self.side_m = float(side_m)
        self.half_m = self.side_m / 2
        self.res_m = float(res_m)
        self.supersample = int(supersample)
        self.band_width = int(band_width)
        self.frame = LocalFrame(*self.center)
        self.fraction = sample_land(self.frame, self.half_m, self.res_m, self.supersample)
        self.land = self.fraction >= 0.5
        self.n = self.land.shape[0]
        hx, hy = self.frame.to_xy(self.home[0], self.home[1])
        self.dot_xy = (float(hx), float(hy))

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
                lat, lon = self.frame.to_latlon(sx[inside], sy[inside])
                frac[inside] += is_land(lat, lon)
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
