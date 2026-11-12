# Test sur UN seul bundle : detecte la compression d'origine (dataflags),
# patche les couleurs orange exactes, repack avec le meme packer et compare les tailles.
import json
import os
import struct
import sys

import UnityPy

BASE = r"C:\RecRoom2023\RecRoom_Data\StreamingAssets\aa\StandaloneWindows64"
PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(PROJECT, ".tmp", "repack-test")

ORANGE = [
    (0.945, 0.353, 0.145), (0.840, 0.254, 0.000), (0.878, 0.424, 0.129),
    (0.702, 0.212, 0.000), (0.820, 0.275, 0.039), (0.726, 0.169, 0.154),
    (0.992, 0.510, 0.302), (0.859, 0.224, 0.024), (0.830, 0.329, 0.153),
    (0.878, 0.616, 0.129),
]
BLUE = [
    (0.011, 0.306, 0.964), (0.000, 0.265, 0.856), (0.004, 0.281, 0.896),
    (0.000, 0.222, 0.716), (0.000, 0.259, 0.836), (0.054, 0.267, 0.741),
    (0.170, 0.427, 1.000), (0.000, 0.272, 0.876), (0.037, 0.288, 0.847),
    (0.004, 0.281, 0.896),
]
TOLERANCE = 0.0015


def packer_of(bundle):
    flags = getattr(bundle, "dataflags", 0) or 0
    code = flags & 0x3F
    if code == 2:
        return "lzma"
    if code == 3:
        return "lz4"
    return "none"


with open(os.path.join(PROJECT, "tools", "bundle-scan.json"), encoding="utf-8") as handle:
    scan = json.load(handle)

items = sorted(scan["results"].items(), key=lambda item: os.path.getsize(os.path.join(BASE, item[0])))
print("compressions d'origine (echantillon) :")
for name, _ in items[:5]:
    env = UnityPy.load(os.path.join(BASE, name))
    print("  %s -> dataflags=%s packer=%s" % (name, getattr(env.file, "dataflags", "?"), packer_of(env.file)))
    del env

name = items[0][0]
src = os.path.join(BASE, name)
env = UnityPy.load(src)
packer = packer_of(env.file)

changed = 0
for obj in env.objects:
    if obj.type.name not in ("MonoBehaviour", "Material"):
        continue
    try:
        raw = bytearray(obj.get_raw_data())
    except Exception:
        continue
    if len(raw) < 40 or len(raw) > 2000000:
        continue
    local = 0
    for offset in range(0, len(raw) - 12, 4):
        r, g, b = struct.unpack_from("<3f", raw, offset)
        for index, (orr, og, ob) in enumerate(ORANGE):
            if abs(r - orr) > TOLERANCE or abs(g - og) > TOLERANCE or abs(b - ob) > TOLERANCE:
                continue
            struct.pack_into("<3f", raw, offset, *BLUE[index])
            local += 1
            break
    if local:
        obj.set_raw_data(bytes(raw))
        changed += local

print("bundle test :", name)
print("packer :", packer, "| couleurs :", changed)

os.makedirs(TMP, exist_ok=True)
env.save(pack=packer, out_path=TMP)
out = os.path.join(TMP, name)
print("taille originale :", os.path.getsize(src))
print("taille repackee :", os.path.getsize(out) if os.path.exists(out) else "sortie absente")
print("sortie :", out)
