import glob
import json
import os
import zipfile

base = 'map-a-deposer/RecRoomDataExport/Rooms'
pairs = [
    ('Room_33834864_RPVILLEFRENCHBETA_20260517_123859', '33834864'),
    ('Room_43984180_copyville_20260517_124130', '43984180'),
    ('Room_844356228137817109_LBP3PS4s_RecCenterFrenchCopy_0326_20260517_130139',
     '844356228137817109'),
]

for folder, rid in pairs:
    d = os.path.join(base, folder)
    zips = [p for p in glob.glob(base + '/*.zip') if 'Room_' + rid + '_' in os.path.basename(p)]
    z = zipfile.ZipFile(zips[0]) if zips else None
    files_d = set()
    for root, _, fs in os.walk(d):
        for f in fs:
            rel = os.path.relpath(os.path.join(root, f), d)
            files_d.add(rel.replace(os.sep, '/'))
    files_z = {n for n in z.namelist() if not n.endswith('/')} if z else set()
    subs_d = {f.split('/')[0] for f in files_d if f.startswith('SubRoom_')}
    subs_z = {f.split('/')[0] for f in files_z if f.startswith('SubRoom_')}
    blobs_d = [f for f in files_d if f.endswith('persisted_room_data.binpb')]
    blobs_z = [f for f in files_z if f.endswith('persisted_room_data.binpb')]
    print(rid, folder[:45])
    print('   subrooms dossier=%d zip=%d | blobs dossier=%d zip=%d'
          % (len(subs_d), len(subs_z), len(blobs_d), len(blobs_z)))
    print('   fichiers seulement dans le dossier: %d | seulement dans le zip: %d'
          % (len(files_d - files_z), len(files_z - files_d)))
    extra = sorted(files_d - files_z)[:6]
    if extra:
        print('   ex:', extra)
    # compare blob sizes
    for b in blobs_d:
        zp = b
        if z and zp in z.namelist():
            same = z.getinfo(zp).file_size == os.path.getsize(os.path.join(d, b))
            print('   blob %s dossier=%d zip=%d identique=%s'
                  % (b.split('/')[0], os.path.getsize(os.path.join(d, b)),
                     z.getinfo(zp).file_size, same))
