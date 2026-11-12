"""City boundary and administrative districts -> out/city.json"""
from shapely import make_valid
from shapely.geometry import box

from build_water import load_many, polys_of, relation_geom
from geolib import bbox_ll, geom_to_ll, geom_to_m, load, orient_rings, write_out

SIMPLIFY_M = 40.0


def clip_simplify(g_m):
    """metres geometry -> list of lon/lat polygons clipped to the bbox, simplified"""
    if g_m is None or g_m.is_empty:
        return []
    g = geom_to_ll(make_valid(g_m) if not g_m.is_valid else g_m).intersection(bbox_ll())
    out = []
    for p in polys_of(g):
        p = geom_to_m(p).simplify(SIMPLIFY_M, preserve_topology=True)
        if p.is_empty:
            continue
        for q in polys_of(make_valid(p) if not p.is_valid else p):
            q = geom_to_ll(q).intersection(bbox_ll())
            out += polys_of(q)
    return out


def rings_of(polys):
    rings = []
    for p in polys:
        rings += orient_rings(p)
    return rings


def main():
    city = [e for e in load("city_boundary")["elements"] if e["type"] == "relation"]
    boundary = []
    for rel in city:
        boundary += rings_of(clip_simplify(relation_geom(rel)))
    districts = []
    for rel in load_many("districts_g"):
        if rel["type"] != "relation" or rel.get("tags", {}).get("admin_level") != "5":
            continue
        polys = clip_simplify(relation_geom(rel))
        if polys:
            districts.append({"name": rel.get("tags", {}).get("name", ""), "rings": rings_of(polys)})
    districts.sort(key=lambda d: d["name"])
    obj = {"boundary": boundary, "districts": districts}
    path, size = write_out("city.json", obj)
    print(path, size, "bytes; boundary rings", len(boundary),
          "pts", sum(len(r) for r in boundary), "; districts:", [d["name"] for d in districts])
    return obj


if __name__ == "__main__":
    main()
