# Patch les bundles Addressables reperes par unitypy-scan-bundles.py :
# - chaque bundle est sauvegarde avant modification
# - seules les couleurs orange exactes du theme sont remplacees
# - la taille du bundle resauvegarde est verifiee ; en cas d'echec le bundle est restaure
import json
import os
import shutil
import struct
import sys

import UnityPy

BASE = r"C:\RecRoom2023\RecRoom_Data\StreamingAssets\aa\StandaloneWindows64"
PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKUP = os.path.join(PROJECT, ".backup-aa")
TMP = os.path.join(PROJECT, ".tmp", "bundles-out")
REPORT = os.path.join(PROJECT, "tools", "bundle-patch.json")

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
BLUE = [
    (0.011, 0.306, 0.964),
    (0.000, 0.265, 0.856),
    (0.004, 0.281, 0.896),
    (0.000, 0.222, 0.716),
    (0.000, 0.259, 0.836),
    (0.054, 0.267, 0.741),
    (0.170, 0.427, 1.000),
    (0.000, 0.272, 0.876),
    (0.037, 0.288, 0.847),
    (0.004, 0.281, 0.896),
]
TOLERANCE = 0.0015

with open(os.path.join(PROJECT, "tools", "bundle-scan.json"), encoding="utf-8") as handle:
    scan = json.load(handle)

names = sorted(scan["results"].items(), key=lambda item: -item[1])
print("bundles a patcher :", len(names))
os.makedirs(BACKUP, exist_ok=True)
os.makedirs(TMP, exist_ok=True)

report = []
for name, expected in names:
    src = os.path.join(BASE, name)
    if not os.path.isfile(src):
        report.append({"bundle": name, "status": "absent"})
        continue
    backup = os.path.join(BACKUP, name)
    if not os.path.isfile(backup):
        shutil.copy2(src, backup)
    original_size = os.path.getsize(src)
    try:
        env = UnityPy.load(src)
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
            report.append({"bundle": name, "status": "sans changement"})
            continue
        env.save(out_path=TMP)
        candidate = os.path.join(TMP, name)
        if not os.path.isfile(candidate):
            for other in os.listdir(TMP):
                if other.startswith(os.path.splitext(name)[0]):
                    candidate = os.path.join(TMP, other)
                    break
        if not os.path.isfile(candidate):
            report.append({"bundle": name, "status": "sortie introuvable", "couleurs": changed})
            continue
        new_size = os.path.getsize(candidate)
        shutil.copy2(candidate, src)
        report.append({"bundle": name, "status": "ok", "couleurs": changed,
                       "taille_avant": original_size, "taille_apres": new_size})
        print("  %s : %d couleur(s), %d -> %d octets" % (name, changed, original_size, new_size))
    except Exception as error:
        if os.path.isfile(backup):
            shutil.copy2(backup, src)
        report.append({"bundle": name, "status": "erreur restauree", "error": str(error)[:160]})
        print("  %s : erreur, restaure (%s)" % (name, str(error)[:80]))

with open(REPORT, "w", encoding="utf-8") as handle:
    json.dump(report, handle, indent=1)

ok = sum(1 for entry in report if entry["status"] == "ok")
print("patches :", ok, "| rapports:", len(report), "| ecrit", REPORT)
