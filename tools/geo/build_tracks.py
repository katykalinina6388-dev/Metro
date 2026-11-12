"""Stations, running tracks A/B and service tracks of Saint Petersburg Metro Line 3
-> out/stations.json, out/tracks.json, out/service_tracks.json
"""
import collections
import math

from shapely.geometry import LineString, MultiLineString, Point, Polygon
from shapely.ops import substring

from geolib import (STATION_NAMES, load, r6, to_m, to_ll, write_out)

REL_A = 2446060  # Беговая — Рыбацкое
REL_B = 252536   # Рыбацкое — Беговая

# Short track stubs that continue the relation ways past the terminal platforms
# (found by following connected railway=subway ways, see README in build.py).
# (way id, which end of the *output* track to attach to)
EXT_A_START = 1086503706  # track 1 north of Беговая platform (to the tail junction)
EXT_B_START = 1086503707  # track 2 north of Беговая platform
EXT_A_END = 1086503192    # Рыбацкое: A past the platform end
EXT_B_END = 1086503193    # Рыбацкое: B from the far end of platform
LINE3_EXT_WAYS = {EXT_A_START, EXT_B_START, EXT_A_END, EXT_B_END}

OTHER_LINES = ["Кировско", "Московско", "Правобереж", "Фрунзенско", "Красносель"]
SERVICE_RADIUS = 500.0


def _index(els):
    nodes = {e["id"]: e for e in els if e["type"] == "node"}
    ways = {e["id"]: e for e in els if e["type"] == "way"}
    rels = {e["id"]: e for e in els if e["type"] == "relation"}
    return nodes, ways, rels


def chain_relation(rid, nodes, ways, rels):
    """Concatenate the role-less ways of a route relation into one node-id list."""
    seq = [ways[m["ref"]] for m in rels[rid]["members"] if m["type"] == "way" and m["role"] == ""]
    ids = []
    for w in seq:
        n = list(w["nodes"])
        if ids:
            if ids[-1] == n[-1]:
                n.reverse()
            if ids[-1] != n[0]:
                raise RuntimeError(f"relation {rid} is not continuous at way {w['id']}")
            n = n[1:]
        ids += n
    return ids


def stop_nodes(rid, rels):
    return [m["ref"] for m in rels[rid]["members"] if m["type"] == "node"]


def dedupe(pts):
    out = [pts[0]]
    for p in pts[1:]:
        if p != out[-1]:
            out.append(p)
    return out


def way_pts(w):
    return [(p["lon"], p["lat"]) for p in w["geometry"]]


def attach(track, ext_pts, at_start):
    """Attach the far part of a stub way to the start/end of track (lon/lat lists)."""
    end = track[0] if at_start else track[-1]
    if ext_pts[0] == end:
        piece = ext_pts[1:]
    elif ext_pts[-1] == end:
        piece = ext_pts[::-1][1:]
    else:
        raise RuntimeError("stub does not touch track end")
    return piece[::-1] + track if at_start else track + piece


def poly_centroid(ring_ll):
    p = Polygon([to_m(*c) for c in ring_ll])
    c = p.centroid
    return c.x, c.y


def build():
    ro = load("routes")["elements"]
    nodes, ways, rels = _index(ro)
    sw = {w["id"]: w for w in load("subway_ways")["elements"]}

    ida = chain_relation(REL_A, nodes, ways, rels)
    idb = chain_relation(REL_B, nodes, ways, rels)
    A = [(nodes[i]["lon"], nodes[i]["lat"]) for i in ida]
    B = [(nodes[i]["lon"], nodes[i]["lat"]) for i in idb][::-1]  # Беговая -> Рыбацкое order

    # Terminal stubs (tracks continue a few metres past the platforms)
    A = attach(A, way_pts(sw[EXT_A_START]), True)
    A = attach(A, way_pts(sw[EXT_A_END]), False)
    B = attach(B, way_pts(sw[EXT_B_START]), True)
    B = attach(B, way_pts(sw[EXT_B_END]), False)
    A, B = dedupe(A), dedupe(B)

    Am = [to_m(*p) for p in A]
    Bm = [to_m(*p) for p in B]
    la, lb = LineString(Am), LineString(Bm)

    # ---- stations: midpoint between the A-stop and B-stop positions
    sa = stop_nodes(REL_A, rels)
    sb = stop_nodes(REL_B, rels)[::-1]
    assert len(sa) == len(sb) == 12
    centres_m = []
    for a, b in zip(sa, sb):
        pa = to_m(nodes[a]["lon"], nodes[a]["lat"])
        pb = to_m(nodes[b]["lon"], nodes[b]["lat"])
        centres_m.append(((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2))
    stations = []
    for name, (x, y) in zip(STATION_NAMES, centres_m):
        lon, lat = to_ll(x, y)
        stations.append({"name": name, "lon": r6(lon), "lat": r6(lat)})

    tracks = {"A": [[r6(lo), r6(la_)] for lo, la_ in A], "B": [[r6(lo), r6(la_)] for lo, la_ in B]}
    return dict(nodes=nodes, ways=ways, rels=rels, sw=sw, A=A, B=B, Am=Am, Bm=Bm, la=la, lb=lb,
                centres_m=centres_m, stations=stations, tracks=tracks)


def depot_cluster():
    """Ids of the railway=subway yard/siding/crossover ways of депо «Невское» (ТЧ-5):
    the connected (60 m) group of such ways around lon 30.5115 lat 59.8243."""
    from shapely.ops import unary_union
    els = [w for w in load("depot")["elements"]
           if w.get("type") == "way" and w.get("tags", {}).get("railway") == "subway" and len(w["geometry"]) > 1]
    lines = {w["id"]: LineString([to_m(p["lon"], p["lat"]) for p in w["geometry"]]) for w in els}
    kinds = ("yard", "crossover", "siding")
    cand = {w["id"] for w in els if w["tags"].get("service") in kinds}
    seed = Point(*to_m(30.5115, 59.8243))
    ids = {i for i in cand if lines[i].distance(seed) < 700}
    changed = True
    while changed:
        changed = False
        g = unary_union([lines[i] for i in ids]).buffer(60)
        for i in cand - ids:
            if lines[i].intersects(g):
                ids.add(i)
                changed = True
    return ids


def build_service(ctx):
    sw, rels = ctx["sw"], ctx["rels"]
    line3 = {m["ref"] for rid in (REL_A, REL_B) for m in rels[rid]["members"]
             if m["type"] == "way" and m["role"] == ""} | LINE3_EXT_WAYS
    other_rel = set()
    for rid, r in rels.items():
        if r["tags"].get("ref") != "3" and r["tags"].get("route") == "subway":
            other_rel |= {m["ref"] for m in r["members"] if m["type"] == "way"}
    both = MultiLineString([ctx["Am"], ctx["Bm"]])
    depot_ids = depot_cluster()
    out = []
    for wid, w in sw.items():
        if wid in line3:
            continue
        tags = w.get("tags", {})
        ls = LineString([to_m(p["lon"], p["lat"]) for p in w["geometry"]])
        near = both.distance(ls) <= SERVICE_RADIUS
        in_depot = wid in depot_ids
        if not (near or in_depot):
            continue
        if not in_depot and (wid in other_rel or any(o in tags.get("name", "") for o in OTHER_LINES)):
            continue
        out.append({"id": wid, "tags": tags,
                    "coords": [[r6(p["lon"]), r6(p["lat"])] for p in w["geometry"]]})
    # depot ways that the subway_ways cache may lack (none expected)
    have = {o["id"] for o in out}
    for w in load("depot")["elements"]:
        if w.get("id") in depot_ids and w["id"] not in have:
            out.append({"id": w["id"], "tags": w.get("tags", {}),
                        "coords": [[r6(p["lon"]), r6(p["lat"])] for p in w["geometry"]]})
    out.sort(key=lambda o: o["id"])
    ctx["depot_ids"] = depot_ids
    return out


def length(pts):
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def verify(ctx):
    la, lb, Am, Bm = ctx["la"], ctx["lb"], ctx["Am"], ctx["Bm"]
    cm = ctx["centres_m"]
    print("== tracks")
    for nm, T in (("A", Am), ("B", Bm)):
        gaps = [math.dist(T[i], T[i + 1]) for i in range(len(T) - 1)]
        big = [(i, round(g)) for i, g in enumerate(gaps) if g > 150]
        print(f"{nm}: {len(T)} pts, {length(T)/1000:.3f} km, max gap {max(gaps):.0f} m, gaps>150m: {len(big)}")
        print("   gaps>150:", big)
    # A on the right? B must lie on the left of A's direction of travel (towards Рыбацкое)
    left = tot = 0
    for i in range(len(Am) - 1):
        p = Point(Am[i])
        q = lb.interpolate(lb.project(p))
        dx, dy = Am[i + 1][0] - Am[i][0], Am[i + 1][1] - Am[i][1]
        if dx == dy == 0:
            continue
        cr = dx * (q.y - p.y) - dy * (q.x - p.x)
        tot += 1
        left += cr > 0
    print(f"B is to the left of A (=> A on right) at {left}/{tot} A-vertices")

    print("== stations: pos along A (m from start), distance between A and B")
    sa = [la.project(Point(c)) for c in cm]
    sb = [lb.project(Point(c)) for c in cm]
    rows = []
    for i, c in enumerate(cm):
        pa = la.interpolate(sa[i])
        pb = lb.interpolate(sb[i])
        dab = (pa.distance(lb) + pb.distance(la)) / 2
        rows.append((STATION_NAMES[i], sa[i], dab))
        print(f"{i:2d} {STATION_NAMES[i]:30s} s={sa[i]:8.0f}  A-B {dab:5.1f} m   centre->A {la.distance(Point(c)):4.1f} centre->B {lb.distance(Point(c)):4.1f}")
    print("== between stations: midpoint A-B distance, along-track distance between centres (A / B)")
    for i in range(11):
        mid = (sa[i] + sa[i + 1]) / 2
        pm = la.interpolate(mid)
        midb = (sb[i] + sb[i + 1]) / 2
        pmb = lb.interpolate(midb)
        dab = (pm.distance(lb) + pmb.distance(la)) / 2
        print(f"{i:2d}-{i+1:2d} {STATION_NAMES[i]} -> {STATION_NAMES[i+1]}: mid A-B {dab:5.1f} m, along A {sa[i+1]-sa[i]:7.0f} m, along B {sb[i+1]-sb[i]:7.0f} m")
    ctx["sa"], ctx["sb"] = sa, sb


def main():
    ctx = build()
    verify(ctx)
    print(write_out("stations.json", ctx["stations"]))
    print(write_out("tracks.json", ctx["tracks"]))
    svc = build_service(ctx)
    ctx["service"] = svc
    n_dep = sum(1 for s in svc if s["id"] in ctx["depot_ids"])
    print(f"service tracks: {len(svc)} ways ({n_dep} depot Nevskoe)")
    print(write_out("service_tracks.json", svc))
    return ctx


if __name__ == "__main__":
    main()
