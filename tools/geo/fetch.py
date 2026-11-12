#!/usr/bin/env python3
"""Download raw OpenStreetMap data for the Saint Petersburg Metro Line 3 map
from Overpass (with mirror fallback) into tools/geo/cache/.

Usage: python fetch.py [query_name ...]   (default: all queries)
Existing cache files are reused; delete them to refetch.
"""
import json
import os
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")

MIRRORS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
UA = "hoplite-metro-map-extract/1.0 (one-off game map data extraction)"

# lon 30.02..30.66, lat 59.76..60.06 ; Overpass order is S,W,N,E
BBOX = "59.76,30.02,60.06,30.66"
# Narrower area around the line, used for station / track queries
LINE_BBOX = "59.80,30.15,60.03,30.56"
DEPOT_BBOX = "59.80,30.42,59.87,30.62"

HDR = "[out:json][timeout:180];"

QUERIES = {
    # all subway route relations with their member ways/nodes (filtered locally)
    "routes": HDR + f'''
(relation["route"="subway"]({BBOX});relation["route_master"="subway"]({BBOX}););
out body;>;out skel qt;''',
    # every railway=subway way with full geometry
    "subway_ways": HDR + f'''way["railway"="subway"]({BBOX});out geom tags;''',
    # subway stations (+ the Mayakovskaya platform multipolygon)
    "stations": HDR + f'''
(nwr["station"="subway"]({LINE_BBOX});relation(8362462););out body geom;''',
    # depot area: every railway way / landuse=railway around Rybatskoe
    "depot": HDR + f'''
(way["railway"]({DEPOT_BBOX});way["landuse"="railway"]({DEPOT_BBOX}););out geom tags;''',
    "coast": HDR + f'''way["natural"="coastline"]({BBOX});out geom;''',
    "riverbank": HDR + f'''
(way["waterway"="riverbank"]({BBOX});relation["waterway"="riverbank"]({BBOX}););out body geom;''',
    "waterways": HDR + f'''
way["waterway"~"^(river|canal|stream)$"]["name"]({BBOX});out geom tags;''',
    "city_boundary": HDR + '''
relation["boundary"="administrative"]["admin_level"="4"]["name"="Санкт-Петербург"];
out body geom;''',
}

# The 18 district relations are the "subarea" members of the city relation 337422.
# (A bbox + admin_level search is too slow on the public servers, so fetch them by id.)
DISTRICT_IDS = [1115367, 338636, 1115366, 1114902, 338635, 369514, 1114252, 337424, 1114905,
                1115082, 363103, 1114809, 367375, 1114193, 368287, 1114806, 1114895, 1114354]
for _g in range(6):
    _ids = ",".join(str(i) for i in DISTRICT_IDS[_g * 3:(_g + 1) * 3])
    QUERIES[f"districts_g{_g}"] = HDR + f"relation(id:{_ids});out body geom;"


def _tiles(nx=3, ny=3):
    s, w, n, e = (float(v) for v in BBOX.split(","))
    out = []
    for i in range(ny):
        for j in range(nx):
            out.append(f"{s + (n - s) * i / ny:.4f},{w + (e - w) * j / nx:.4f},"
                       f"{s + (n - s) * (i + 1) / ny:.4f},{w + (e - w) * (j + 1) / nx:.4f}")
    return out


# natural=water is large, so it is fetched per ninth of the bbox
for _k, _tb in enumerate(_tiles()):
    QUERIES[f"water_ways_t{_k}"] = HDR + f'way["natural"="water"]({_tb});out geom tags;'
    QUERIES[f"water_rels_t{_k}"] = HDR + f'relation["natural"="water"]({_tb});out body geom;'

_good = [int(os.environ.get("OVERPASS_FIRST", "0"))]


def run_query(q, tries_per_mirror=12, timeout=150):
    order = MIRRORS[_good[0]:] + MIRRORS[:_good[0]]
    last = None
    for rnd in range(tries_per_mirror):
        for m in order:
            t0 = time.time()
            try:
                r = requests.post(m, data={"data": q}, headers={"User-Agent": UA}, timeout=timeout)
                if r.status_code == 200 and r.text.lstrip().startswith("{"):
                    d = r.json()
                    if "remark" in d and "error" in d.get("remark", "").lower() and not d.get("elements"):
                        raise RuntimeError(d["remark"])
                    _good[0] = MIRRORS.index(m)
                    print(f"  ok {m} {time.time()-t0:.0f}s {len(r.content)/1e6:.1f} MB", flush=True)
                    return r.text
                last = f"{m} -> HTTP {r.status_code} {r.text[:100]!r}"
            except Exception as e:  # noqa: BLE001
                last = f"{m} -> {type(e).__name__}: {str(e)[:100]}"
            print("  fail", last, flush=True)
        time.sleep(min(10 * (rnd + 1), 40))
    raise SystemExit(f"all mirrors failed: {last}")


def main():
    os.makedirs(CACHE, exist_ok=True)
    names = sys.argv[1:] or list(QUERIES)
    for n in names:
        path = os.path.join(CACHE, n + ".json")
        if os.path.exists(path) and os.path.getsize(path) > 0:
            print(f"{n}: cached")
            continue
        print(f"{n}: fetching", flush=True)
        text = run_query(QUERIES[n])
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)


if __name__ == "__main__":
    main()
