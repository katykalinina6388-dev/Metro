#!/usr/bin/env python3
"""Rebuild every output in tools/geo/out/ from the Overpass cache.

    python fetch.py          # download raw OSM data into cache/ (needs network)
    python build.py          # tracks, stations, service tracks, water, city, previews
    python build.py water    # only some stages: tracks | water | city | preview

Requirements: python3 with shapely>=2, pyproj, requests, matplotlib.
Coordinates are [lon, lat] rounded to 6 decimals; all geometry work is done in UTM 36N metres.
"""
import sys

STAGES = ["tracks", "water", "city", "preview"]


def main(stages):
    if "tracks" in stages:
        import build_tracks
        build_tracks.main()
    if "water" in stages:
        import build_water
        build_water.main()
    if "city" in stages:
        import build_city
        build_city.main()
    if "preview" in stages:
        import preview
        preview.main()


if __name__ == "__main__":
    main(sys.argv[1:] or STAGES)
