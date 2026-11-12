# Sonde lecture seule : UnityPy arrive-t-il a lire le type tree des MonoBehaviours
# de resources.assets, et y trouve-t-on les palettes RRUI ?
import sys
import UnityPy

PATH = r"C:\RecRoom2023\RecRoom_Data\resources.assets"

env = UnityPy.load(PATH)
total = 0
readable = 0
palettes = []
first = []

for obj in env.objects:
    if obj.type.name != "MonoBehaviour":
        continue
    total += 1
    try:
        tree = obj.read_typetree()
    except Exception as error:
        if len(first) < 3:
            first.append(("KO", obj.path_id, str(error)[:120]))
        continue
    readable += 1
    name = ""
    try:
        name = tree.get("m_Name", "")
    except Exception:
        pass
    if "Palette" in name or "Theme" in name:
        palettes.append((obj.path_id, name, len(tree)))
    if len(first) < 3:
        first.append(("OK", obj.path_id, str(list(tree.keys())[:6])))

print("MonoBehaviours :", total)
print("type tree lisible :", readable)
for item in first:
    print("  exemple", item)
print("palettes/themes trouves :", len(palettes))
for entry in palettes[:20]:
    print("  pathId", entry[0], "|", entry[1], "| champs", entry[2])
