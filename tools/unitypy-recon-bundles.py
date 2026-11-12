# Reconnaissance : compression d'origine des bundles UnityPy + champs du catalogue
# Addressables (taille / hash / CRC) pour savoir ce qu'il faut recalculer.
import inspect
import json
import os

import UnityPy

BASE = r"C:\RecRoom2023\RecRoom_Data\StreamingAssets\aa\StandaloneWindows64"
CATALOG = r"C:\RecRoom2023\RecRoom_Data\StreamingAssets\aa\catalog.json"
SETTINGS = r"C:\RecRoom2023\RecRoom_Data\StreamingAssets\aa\settings.json"

name = "608653ace99f4faa9876c9ee6a9aba23.bundle"
path = os.path.join(BASE, name)
env = UnityPy.load(path)
bundle = env.file
print("type bundle :", type(bundle).__name__)
print("attributs :", [a for a in dir(bundle) if not a.startswith("_")][:25])
for attr in ("signature", "version", "dataFlags", "compression", "blockInfos"):
    print(" ", attr, "=", repr(getattr(bundle, attr, None))[:120])

print("save signature :", inspect.signature(UnityPy.Environment.save))
data = bundle.get_data() if hasattr(bundle, "get_data") else None
print("taille decompressee :", len(data) if data else "?")
print("taille fichier :", os.path.getsize(path))

with open(CATALOG, encoding="utf-8") as handle:
    text = handle.read()
for field in ("m_Crc", "m_Hash", "m_BundleSize", "m_BundleName", "m_InternalIds", "m_BucketDataString"):
    print("catalogue", field, ":", text.count(field))
print("settings.json :", open(SETTINGS, encoding="utf-8").read()[:400])
