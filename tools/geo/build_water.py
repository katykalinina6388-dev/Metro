"""Water polygons -> out/water.json

sea: built from natural=coastline ways (land on the LEFT of the way direction)
     clipped to the bbox; plus natural=water / waterway=riverbank polygons and
     buffered named waterways that have no polygon.
"""
import collections
import glob
import math
import os

from shapely import make_valid
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import polygonize, unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree

from geolib import (CACHE, bbox_m, geom_to_ll, load, orient_rings, to_m, write_out)

SIMPLIFY_M = 8.0
MIN_AREA_M2 = 8000.0
SEA_NAME = "Финский залив"

SEA_PROBE = (30.10, 59.95)   # known sea
LAND_PROBE = (30.36, 59.93)  # known land

# widths (m) for important named waterways that have no polygon in OSM
# (other lines are only drawn when OSM gives a width tag >= 8 m)
NAME_WIDTH = {"Фонтанка": 50.0, "Мойка": 30.0, "Обводный канал": 45.0, "Охта": 40.0,
              "Смоленка": 30.0, "Карповка": 25.0, "Ждановка": 45.0, "Пряжка": 30.0}


def polys_of(g):
    if g is None or g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if hasattr(g, "geoms"):
        out = []
        for x in g.geoms:
            out += polys_of(x)
        return out
    return []


def load_many(prefix):
    """merge elements of every cache/<prefix>*.json file (dedupe by type+id)"""
    els = {}
    names = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(CACHE, prefix + "*.json")))
    for n in names:
        for e in load(n)["elements"]:
            els[(e["type"], e["id"])] = e
    return list(els.values())


def member_lines(rel, roles):
    out = []
    for m in rel.get("members", []):
        if m["type"] == "way" and m.get("role", "") in roles and m.get("geometry") and len(m["geometry"]) > 1:
            out.append(LineString([to_m(p["lon"], p["lat"]) for p in m["geometry"] if p]))
    return out


def relation_geom(rel):
    """multipolygon relation (metres) from its member ways"""
    outers = member_lines(rel, ("outer", ""))
    inners = member_lines(rel, ("inner",))
    if not outers:
        return None
    g = unary_union(list(polygonize(unary_union(outers))))
    if inners:
        holes = unary_union(list(polygonize(unary_union(inners))))
        g = g.difference(holes)
    return g


def way_geom(w):
    pts = [to_m(p["lon"], p["lat"]) for p in w.get("geometry", [])]
    if len(pts) >= 4 and pts[0] == pts[-1]:
        return Polygon(pts)
    return None


def build_sea():
    bm = bbox_m()
    pieces = []
    for w in load("coast")["elements"]:
        pts = [to_m(p["lon"], p["lat"]) for p in w["geometry"]]
        if len(pts) < 2:
            continue
        inter = LineString(pts).intersection(bm)
        geoms = [inter] if isinstance(inter, LineString) else list(getattr(inter, "geoms", []))
        pieces += [g for g in geoms if isinstance(g, LineString) and g.length > 0]
    faces = list(polygonize(unary_union([bm.exterior] + pieces)))
    tree = STRtree(faces)
    prepared = [prep(f) for f in faces]
    votes = collections.defaultdict(lambda: [0.0, 0.0])  # face -> [sea, land] weight
    for g in pieces:
        c = list(g.coords)
        for i in range(len(c) - 1):
            (x1, y1), (x2, y2) = c[i], c[i + 1]
            dx, dy = x2 - x1, y2 - y1
            L = math.hypot(dx, dy)
            if L < 1e-6:
                continue
            mx, my = (x1 + x2) / 2, (y1 + y2) / 2
            nx, ny = dy / L, -dx / L  # right-hand normal = sea side
            for sign, k in ((1, 0), (-1, 1)):
                p = Point(mx + sign * nx * 1.5, my + sign * ny * 1.5)
                for j in tree.query(p):
                    if prepared[j].contains(p):
                        votes[j][k] += min(L, 50)
                        break
    sea = [faces[j] for j, (s, l) in votes.items() if s > l]
    return unary_union(sea) if sea else Polygon()


def check_sea(sea_m):
    return (sea_m.contains(Point(*to_m(*SEA_PROBE))), sea_m.contains(Point(*to_m(*LAND_PROBE))))


def collect_polygons(bm):
    """[(name, shapely polygon in metres)] before simplification"""
    out = []
    for e in load_many("water_ways") + load_many("riverbank"):
        if e["type"] == "way":
            g = way_geom(e)
            if g is not None:
                out.append((e.get("tags", {}).get("name", ""), g))
        elif e["type"] == "relation":
            g = relation_geom(e)
            if g is not None:
                out.append((e.get("tags", {}).get("name", ""), g))
    for e in load_many("water_rels"):
        g = relation_geom(e)
        if g is not None:
            out.append((e.get("tags", {}).get("name", ""), g))
    return out


def waterway_polygons(cover, bm):
    """buffer named waterway lines (or their uncovered parts) that no polygon represents"""
    by_name = collections.defaultdict(list)
    prepared = prep(cover) if not cover.is_empty else None
    for w in load("waterways")["elements"]:
        t = w.get("tags", {})
        pts = [to_m(p["lon"], p["lat"]) for p in w.get("geometry", [])]
        if len(pts) < 2 or t.get("tunnel") in ("yes", "culvert") or t.get("waterway") == "stream":
            continue
        ln = LineString(pts).intersection(bm)
        if ln.is_empty:
            continue
        rest = ln.difference(cover.buffer(5)) if prepared else ln
        if rest.is_empty or rest.length < 100:
            continue
        try:
            width = float(str(t.get("width", "")).replace(",", ".").split()[0])
        except (ValueError, IndexError):
            width = NAME_WIDTH.get(t.get("name", ""), 0.0)
        if width < 8.0:  # small streams are not worth drawing
            continue
        by_name[t.get("name", "")].append(rest.buffer(width / 2, cap_style="flat"))
    return [(n, unary_union(g)) for n, g in by_name.items()]


def finalize(name, g, bm):
    """clip, simplify, drop small -> list of (name, polygon metres)"""
    if g is None or g.is_empty:
        return []
    g = make_valid(g) if not g.is_valid else g
    g = g.intersection(bm)
    res = []
    for p in polys_of(g):
        p = p.simplify(SIMPLIFY_M, preserve_topology=True)
        for q in polys_of(make_valid(p) if not p.is_valid else p):
            if q.area >= MIN_AREA_M2:
                res.append((name, q))
    return res


def build():
    bm = bbox_m()
    sea = build_sea()
    print("sea km2 %.1f; probes (sea, land) = %s" % (sea.area / 1e6, check_sea(sea)))
    raw = collect_polygons(bm)
    print("water polygon sources:", len(raw))
    cover = unary_union([sea] + [make_valid(g) if not g.is_valid else g for _, g in raw])
    raw += waterway_polygons(cover, bm)
    items = finalize(SEA_NAME, sea, bm)
    for n, g in raw:
        items += finalize(n, g, bm)
    items.sort(key=lambda it: -it[1].area)
    polys = []
    for n, p in items:
        ll = geom_to_ll(p)
        polys.append({"name": n, "rings": orient_rings(ll)})
    return polys, items


def main():
    polys, items = build()
    path, size = write_out("water.json", {"polygons": polys})
    npts = sum(len(r) for p in polys for r in p["rings"])
    print(path, size, "bytes;", len(polys), "polygons;", npts, "points")
    names = collections.Counter(p["name"] for p in polys if p["name"])
    print("named:", dict(names))
    return polys, items


if __name__ == "__main__":
    main()
