"""Matplotlib previews of out/*.json -> out/preview*.png"""
import json
import math
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import PathPatch
from matplotlib.path import Path

from geolib import OUT, to_m

BG = "#0b0f14"
WATER = "#16466e"
SVC_COLORS = {"yard": "#c77d1a", "siding": "#ff9f43", "crossover": "#ff5e8a", None: "#e6d34f"}


def jl(name):
    with open(os.path.join(OUT, name), encoding="utf-8") as f:
        return json.load(f)


def proj(coords):
    return [to_m(lon, lat) for lon, lat in coords]


def poly_patch(rings, **kw):
    verts, codes = [], []
    for r in rings:
        pts = proj(r)
        verts += pts
        codes += [Path.MOVETO] + [Path.LINETO] * (len(pts) - 2) + [Path.CLOSEPOLY]
    return PathPatch(Path(verts, codes), **kw)


def draw(ax, data, view=None, detail=False):
    ax.set_facecolor(BG)
    for p in data["water"]["polygons"]:
        ax.add_patch(poly_patch(p["rings"], fc=WATER, ec="#2b6ca3", lw=0.3, zorder=1))
    for ring in data["city"]["boundary"]:
        xy = proj(ring)
        ax.plot([p[0] for p in xy], [p[1] for p in xy], color="#d9d9d9", lw=0.9, ls="--", zorder=2)
    for d in data["city"]["districts"]:
        for ring in d["rings"]:
            xy = proj(ring)
            ax.plot([p[0] for p in xy], [p[1] for p in xy], color="#6b7a8c", lw=0.5, zorder=2)
    for s in data["service"]:
        xy = proj(s["coords"])
        col = SVC_COLORS.get(s["tags"].get("service"), SVC_COLORS[None])
        ax.plot([p[0] for p in xy], [p[1] for p in xy], color=col, lw=0.9 if detail else 0.5, zorder=3)
    for key, col in (("B", "#35e0ff"), ("A", "#38e06b")):
        xy = proj(data["tracks"][key])
        ax.plot([p[0] for p in xy], [p[1] for p in xy], color=col, lw=1.6 if detail else 1.2, zorder=4,
                marker="o" if detail else None, ms=2.5)
    for st in data["stations"]:
        x, y = to_m(st["lon"], st["lat"])
        ax.plot(x, y, "o", color="white", ms=6 if detail else 3.5, mec="black", zorder=6)
        ax.annotate(st["name"], (x, y), xytext=(6, 5), textcoords="offset points", color="white",
                    fontsize=11 if detail else 6.5, zorder=7)
    ax.set_aspect("equal")
    if view:
        ax.set_xlim(view[0], view[2])
        ax.set_ylim(view[1], view[3])
    ax.tick_params(colors="#888", labelsize=7)
    for sp in ax.spines.values():
        sp.set_color("#444")


def window(lon, lat, half_m, ratio=1.0):
    x, y = to_m(lon, lat)
    return (x - half_m * ratio, y - half_m, x + half_m * ratio, y + half_m)


def save(data, fn, view=None, size=(16, 12), detail=False, title=""):
    fig, ax = plt.subplots(figsize=size)
    fig.patch.set_facecolor(BG)
    draw(ax, data, view, detail)
    ax.set_title(title, color="white", fontsize=11)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, fn), dpi=110, facecolor=BG)
    plt.close(fig)


def main():
    data = {"water": jl("water.json"), "city": jl("city.json"), "tracks": jl("tracks.json"),
            "service": jl("service_tracks.json"), "stations": jl("stations.json")}
    save(data, "preview.png", None, (16, 12), False,
         "Line 3: green=A (Беговая→Рыбацкое, right-hand), cyan=B, orange/pink=service tracks")
    save(data, "preview_rybatskoe.png", window(30.505, 59.826, 1400), (12, 12), True, "Рыбацкое + депо Невское")
    save(data, "preview_begovaya.png", window(30.2025, 59.9880, 600), (12, 12), True, "Беговая")


if __name__ == "__main__":
    main()
