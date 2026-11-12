# Scan lecture seule des bundles Addressables : quels bundles contiennent les couleurs
# orange exactes du theme RRUI ? Ecrit un JSON de resultats, sans rien modifier.
import json
import os
import struct
import sys
import time

import UnityPy

ROOT = r"C:\RecRoom2023\RecRoom_Data\StreamingAssets\aa\StandaloneWindows64"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bundle-scan.json")

ORANGE = [
    (0.945, 0.353, 0.145),
    (0.840, 0.254, 0.000),
    (0.878, 0.424, 0.129),
    (0.702, 0.212, 0.000),
    (0.820, 0.275, 0.039),
    (0.726, 0.169, 0.154),
    (0.992, 0.510, 0.302),
    (0.859, 0.224, 0.024),
    (0.830, 0.329, 0.153),
    (0.878, 0.616, 0.129),
]
TOLERANCE = 0.0015

def count_hits(raw):
    hits = 0
    for offset in range(0, len(raw) - 12, 4):
        r, g, b = struct.unpack_from("<3f", raw, offset)
        for orr, og, ob in ORANGE:
            if abs(r - orr) <= TOLERANCE and abs(g - og) <= TOLERANCE and abs(b - ob) <= TOLERANCE:
                hits += 1
                break
    return hits

names = sorted(n for n in os.listdir(ROOT) if n.endswith(".bundle"))
print("bundles a scanner :", len(names), flush=True)

results = {}
errors = []
started = time.time()

for index, name in enumerate(names, 1):
    path = os.path.join(ROOT, name)
    try:
        env = UnityPy.load(path)
    except Exception as error:
        errors.append({"bundle": name, "error": str(error)[:120]})
        continue

    total = 0
    for obj in env.objects:
        if obj.type.name not in ("MonoBehaviour", "Material"):
            continue
        try:
            raw = obj.get_raw_data()
        except Exception:
            continue
        if len(raw) < 40 or len(raw) > 2000000:
            continue
        total += count_hits(raw)

    if total:
        results[name] = total
    del env

    if index % 200 == 0:
        elapsed = time.time() - started
        print("  %d/%d bundles, %d porteurs, %.0fs" % (index, len(names), len(results), elapsed), flush=True)
        with open(OUT, "w", encoding="utf-8") as handle:
            json.dump({"results": results, "errors": errors, "done": False}, handle, indent=1)

with open(OUT, "w", encoding="utf-8") as handle:
    json.dump({"results": results, "errors": errors, "done": True}, handle, indent=1)

print("termine :", len(results), "bundles porteurs,", len(errors), "erreurs", flush=True)
