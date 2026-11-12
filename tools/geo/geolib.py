"""Shared helpers for the geo build scripts."""
import json
import math
import os

from pyproj import Transformer
from shapely.geometry import box
from shapely.ops import transform as shp_transform

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
OUT = os.path.join(HERE, "out")

BBOX_LONLAT = (30.02, 59.76, 30.66, 60.06)  # W, S, E, N

STATION_NAMES = [
    "Беговая", "Зенит", "Приморская", "Василеостровская", "Гостиный двор",
    "Маяковская", "Площадь Александра Невского 1", "Елизаровская",
    "Ломоносовская", "Пролетарская", "Обухово", "Рыбацкое",
]

_to_m = Transformer.from_crs(4326, 32636, always_xy=True)
_to_ll = Transformer.from_crs(32636, 4326, always_xy=True)


def to_m(lon, lat):
    return _to_m.transform(lon, lat)


def to_ll(x, y):
    return _to_ll.transform(x, y)


def geom_to_m(g):
    return shp_transform(_to_m.transform, g)


def geom_to_ll(g):
    return shp_transform(_to_ll.transform, g)


def bbox_ll():
    w, s, e, n = BBOX_LONLAT
    return box(w, s, e, n)


def bbox_m():
    """Projected bbox with densified edges (a lon/lat rectangle is slightly curved in UTM)."""
    from shapely.geometry import Polygon
    w, s, e, n = BBOX_LONLAT
    k = 64
    ring = ([(w + (e - w) * i / k, s) for i in range(k)] + [(e, s + (n - s) * i / k) for i in range(k)]
            + [(e - (e - w) * i / k, n) for i in range(k)] + [(w, n - (n - s) * i / k) for i in range(k)])
    return Polygon([to_m(*p) for p in ring])


def orient_rings(poly):
    """Polygon -> [outer, hole, ...] closed rings (outer CCW, holes CW), lon/lat rounded."""
    from shapely.geometry.polygon import orient
    poly = orient(poly, 1.0)
    rings = [list(poly.exterior.coords)] + [list(i.coords) for i in poly.interiors]
    return [[[r6(x), r6(y)] for x, y in ring] for ring in rings]


def load(name):
    with open(os.path.join(CACHE, name + ".json"), encoding="utf-8") as f:
        return json.load(f)


def write_out(name, obj):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    return path, os.path.getsize(path)


def r6(v):
    return round(float(v), 6)


def ll_coords_m(coords_m):
    """list of (x, y) metres -> [[lon, lat], ...] rounded to 6 decimals."""
    out = []
    for x, y in coords_m:
        lon, lat = to_ll(x, y)
        out.append([r6(lon), r6(lat)])
    return out


def way_coords(w):
    """Overpass way (out geom) -> [[lon, lat], ...]"""
    return [[p["lon"], p["lat"]] for p in w["geometry"]]


def hav(a, b):
    """distance in metres between two [lon, lat] points"""
    x1, y1 = to_m(*a)
    x2, y2 = to_m(*b)
    return math.hypot(x2 - x1, y2 - y1)
