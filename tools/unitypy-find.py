# Retrouve l'objet qui contient le nom de la palette et affiche sa taille brute,
# pour savoir si resources.assets porte la vraie palette ou seulement une reference.
import UnityPy

PATH = r"C:\RecRoom2023\RecRoom_Data\resources.assets"
env = UnityPy.load(PATH)

hits = 0
scanned = 0
for obj in env.objects:
    if obj.type.name != "MonoBehaviour":
        continue
    scanned += 1
    try:
        raw = obj.get_raw_data()
    except Exception:
        continue
    if b"Palette_LightTheme" in raw or b"Palette_ProUXCreatorMenu" in raw:
        hits += 1
        print("pathId", obj.path_id, "taille brute", len(raw))
        index = raw.find(b"Palette_")
        start = max(0, index - 48)
        print("  contexte :", raw[start:index + 40].hex())
        if hits >= 5:
            break

print("MonoBehaviours inspectes :", scanned)
print("objets contenant un nom de palette :", hits)
