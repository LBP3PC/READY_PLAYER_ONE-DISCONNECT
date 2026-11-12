import os

import UnityPy
from PIL import Image, ImageDraw

GAME = r'C:\RecRoom2023\RecRoom_Data'
CIBLES = [
    (os.path.join(GAME, 'StreamingAssets', 'aa', 'StandaloneWindows64', '682ba40059cd6c037bace975e7aea07f.bundle'), 'bundle-titre'),
    (os.path.join(GAME, 'level0'), 'level0'),
]

for chemin, tag in CIBLES:
    if not os.path.exists(chemin):
        print('absent :', chemin)
        continue
    try:
        env = UnityPy.load(chemin)
    except Exception as erreur:
        print('echec chargement', tag, erreur)
        continue
    items = []
    for obj in env.objects:
        if obj.type.name != 'Texture2D':
            continue
        try:
            data = obj.read()
            img = data.image.convert('RGBA')
        except Exception:
            continue
        items.append((data.m_Name, img))
    if not items:
        print(tag, ': aucune texture')
        continue

    cols = 5
    cell = 190
    rows = (len(items) + cols - 1) // cols
    sheet = Image.new('RGBA', (cols * cell, rows * (cell + 14)), (25, 25, 25, 255))
    dessin = ImageDraw.Draw(sheet)
    for index, (nom, img) in enumerate(items):
        pouce = img.copy()
        pouce.thumbnail((cell - 12, cell - 12))
        x = (index % cols) * cell
        y = (index // cols) * (cell + 14)
        sheet.paste(pouce, (x + 6, y + 6), pouce)
        dessin.text((x + 6, y + cell), f'{index}:{nom[:26]}', fill=(255, 255, 255, 255))
    sortie = os.path.join('.tmp', f'sheet-{tag}.png')
    sheet.convert('RGB').save(sortie)
    print(tag, ':', len(items), 'textures ->', sortie)
    for index, (nom, img) in enumerate(items):
        print('  ', index, nom, img.size)
