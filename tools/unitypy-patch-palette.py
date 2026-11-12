# Remplace les couleurs orange du theme RRUI par le bleu REC BLUE, uniquement dans
# les objets de palette de resources.assets (MonoBehaviour 242201 / 242202).
# - lecture seule par defaut, --apply pour ecrire
# - refuse d'ecrire si la taille du fichier change ou si la sauvegarde manque
import struct
import sys
import os
import UnityPy

PATH = r"C:\RecRoom2023\RecRoom_Data\resources.assets"
BACKUP = PATH + ".recblue-backup"
APPLY = "--apply" in sys.argv

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

TARGETS = {242201, 242202}
ALL_MONO = "--all-mono" in sys.argv
TOLERANCE = 0.0015
MAX_WRITES = 3000

if not os.path.exists(BACKUP):
    print("sauvegarde absente :", BACKUP)
    sys.exit(3)

original_size = os.path.getsize(PATH)
env = UnityPy.load(PATH)

total = 0
touched = []

for obj in env.objects:
    if obj.type.name != "MonoBehaviour":
        continue
    if not ALL_MONO and obj.path_id not in TARGETS:
        continue

    raw = bytearray(obj.get_raw_data())
    if ALL_MONO and (len(raw) < 200 or len(raw) > 2000000):
        continue
    hits = 0
    for offset in range(0, len(raw) - 12, 4):
        r, g, b = struct.unpack_from("<3f", raw, offset)
        for index, (orr, og, ob) in enumerate(ORANGE):
            if abs(r - orr) > TOLERANCE or abs(g - og) > TOLERANCE or abs(b - ob) > TOLERANCE:
                continue
            nr, ng, nb = BLUE[index]
            if hits < 6:
                print("  obj %d offset %d : orange #%d (%.3f, %.3f, %.3f) -> (%.3f, %.3f, %.3f)"
                      % (obj.path_id, offset, index, r, g, b, nr, ng, nb))
            struct.pack_into("<3f", raw, offset, nr, ng, nb)
            hits += 1
            break
    total += hits
    if hits:
        touched.append(obj.path_id)
    print("objet %d : %d couleur(s) orange, taille brute %d" % (obj.path_id, hits, len(raw)))
    if APPLY and hits:
        obj.set_raw_data(bytes(raw))

print("total orange converties :", total)
if total > MAX_WRITES:
    print("trop de remplacements (%d > %d) : abandon par securite" % (total, MAX_WRITES))
    sys.exit(6)

if not APPLY:
    print("lecture seule : rien n'a ete ecrit (ajouter --apply)")
    sys.exit(0)

if total == 0:
    print("aucune modification")
    sys.exit(0)

out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".tmp", "assets-out")
os.makedirs(out_dir, exist_ok=True)
env.save(out_path=out_dir)
written = os.path.join(out_dir, os.path.basename(PATH))
if not os.path.exists(written):
    print("sortie introuvable :", written)
    sys.exit(5)
with open(written, "rb") as handle:
    data = handle.read()
print("fichier reserialise :", written, len(data), "octets")

if len(data) != original_size:
    print("taille differente de l'original (%d) : ecriture annulee" % original_size)
    sys.exit(4)

with open(PATH, "wb") as handle:
    handle.write(data)
print("ecrit :", PATH)
