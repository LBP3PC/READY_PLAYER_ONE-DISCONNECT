# Repack des bundles avec leur compression d'origine :
# - lit dataflags de chaque bundle pour choisir le packer (lz4 / lzma / none)
# - patche les couleurs orange exactes, repack, verifie taille et relecture
# - n'installe que si la taille reste dans une tolerance et si le bundle se relit
import json
import os
import shutil
import struct

import UnityPy

BASE = r"C:\RecRoom2023\RecRoom_Data\StreamingAssets\aa\StandaloneWindows64"
PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKUP = os.path.join(PROJECT, ".backup-aa")
TMP = os.path.join(PROJECT, ".tmp", "repack-all")

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
# la recompression change legerement la taille ; on tolere 25 %
RATIO_MAX = 1.25


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

os.makedirs(TMP, exist_ok=True)
os.makedirs(BACKUP, exist_ok=True)

report = []
installed = 0
for name, expected in sorted(scan["results"].items()):
    src = os.path.join(BASE, name)
    if not os.path.isfile(src):
        report.append((name, "absent"))
        continue
    backup = os.path.join(BACKUP, name)
    if not os.path.isfile(backup):
        shutil.copy2(src, backup)
    original_size = os.path.getsize(backup)

    try:
        env = UnityPy.load(backup)
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
        if not changed:
            report.append((name, "sans changement"))
            continue
        env.save(pack=packer, out_path=TMP)
        out = os.path.join(TMP, name)
        if not os.path.isfile(out):
            report.append((name, "sortie absente"))
            continue

        new_size = os.path.getsize(out)
        ratio = new_size / float(original_size)
        if ratio > RATIO_MAX or ratio < 1.0 / RATIO_MAX:
            report.append((name, "taille refusee %.2fx" % ratio))
            continue

        check = UnityPy.load(out)
        ok = sum(1 for _ in check.objects)
        del check
        if ok <= 0:
            report.append((name, "relecture vide"))
            continue

        shutil.copy2(out, src)
        installed += 1
        report.append((name, "ok %s %.2fx" % (packer, ratio)))
        print("  %-40s %s  %d couleurs  %.2fx" % (name, packer, changed, ratio), flush=True)
    except Exception as error:
        report.append((name, "erreur %s" % str(error)[:80]))
        print("  %s erreur : %s" % (name, str(error)[:80]), flush=True)

with open(os.path.join(PROJECT, "tools", "bundle-repack.json"), "w", encoding="utf-8") as handle:
    json.dump(report, handle, indent=1)

print("installes :", installed, "/", len(scan["results"]))
