(() => {
  'use strict';

  // Fichiers attendus : le jeu officiel d'abord, puis le pack REC BLUE.
  const SPEC = [
    { path: 'RecRoom.exe', min: 500 * 1024, kind: 'jeu', label: 'Exécutable du jeu' },
    { path: 'GameAssembly.dll', min: 100 * 1024 * 1024, kind: 'jeu', label: 'Code du jeu' },
    { path: 'UnityPlayer.dll', min: 20 * 1024 * 1024, kind: 'jeu', label: 'Moteur Unity' },
    { path: 'RecRoom_Data/globalgamemanagers', min: 1024 * 1024, kind: 'jeu', label: 'Données du jeu' },
    { path: 'RecRoom_Data/Plugins/x86_64/steam_api64.dll', min: 100 * 1024, kind: 'jeu', label: 'API Steam' },
    { path: 'steam_appid.txt', value: '471710', kind: 'jeu', label: 'AppID Steam' },
    { path: 'winhttp.dll', min: 10 * 1024, kind: 'pack', label: 'Chargeur BepInEx' },
    { path: 'doorstop_config.ini', min: 500, kind: 'pack', label: 'Configuration du chargeur' },
    { path: 'BepInEx/core/BepInEx.Core.dll', min: 10 * 1024, kind: 'pack', label: 'BepInEx' },
    { path: 'BepInEx/plugins/RecNetPlugin.dll', min: 20 * 1024, kind: 'pack', label: 'Plugin serveur' },
    { path: 'BepInEx/config/net.rec.plugin.cfg', min: 500, kind: 'pack', label: 'Configuration serveur' }
  ];

  const LABELS = {
    ok: ['Présent', 'st-ok'],
    small: ['Trop petit', 'st-bad'],
    missing: ['Absent', 'st-bad'],
    pack: ['À installer', 'st-warn'],
    wrong: ['Inattendu', 'st-bad'],
    error: ['Illisible', 'st-warn']
  };

  const rowsBody = document.getElementById('check-rows');
  const statusEl = document.getElementById('check-status');
  const summaryEl = document.getElementById('check-summary');
  const pickButton = document.getElementById('pick-folder');
  const fileInput = document.getElementById('pick-folder-input');

  const rows = SPEC.map((spec) => {
    const tr = document.createElement('tr');
    const fileCell = document.createElement('td');
    const name = document.createElement('code');
    name.textContent = spec.path;
    fileCell.append(name, document.createElement('br'), document.createTextNode(spec.label));

    const expectedCell = document.createElement('td');
    expectedCell.textContent = spec.value ? spec.value : '≥ ' + formatSize(spec.min);

    const foundCell = document.createElement('td');
    foundCell.textContent = '—';

    const stateCell = document.createElement('td');
    stateCell.textContent = '—';

    tr.append(fileCell, expectedCell, foundCell, stateCell);
    rowsBody.append(tr);
    return { tr, foundCell, stateCell };
  });

  function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' Go';
    if (bytes >= 1024 * 1024) return Math.round(bytes / (1024 * 1024)) + ' Mo';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' Ko';
    return bytes + ' o';
  }

  function resetRows() {
    rows.forEach((row) => {
      row.foundCell.textContent = '—';
      row.stateCell.textContent = '—';
      row.stateCell.className = '';
    });
  }

  async function fileAt(root, path) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    const handle = await dir.getFileHandle(parts[parts.length - 1]);
    return handle.getFile();
  }

  function isMissing(error) {
    return error && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError');
  }

  async function readDirectory(root) {
    const results = [];
    for (const spec of SPEC) {
      try {
        const file = await fileAt(root, spec.path);
        let status = file.size >= (spec.min || 0) ? 'ok' : 'small';
        if (spec.value) {
          status = (await file.text()).trim() === spec.value ? 'ok' : 'wrong';
        }
        results.push({ status, size: file.size });
      } catch (error) {
        results.push({ status: isMissing(error) ? (spec.kind === 'pack' ? 'pack' : 'missing') : 'error' });
      }
    }
    return results;
  }

  async function readFileMap(map) {
    const normalized = new Map();
    map.forEach((file, path) => normalized.set(path.toLowerCase(), file));
    const results = [];
    for (const spec of SPEC) {
      const file = normalized.get(spec.path.toLowerCase());
      if (!file) {
        results.push({ status: spec.kind === 'pack' ? 'pack' : 'missing' });
        continue;
      }
      let status = file.size >= (spec.min || 0) ? 'ok' : 'small';
      if (spec.value) {
        try {
          status = (await file.text()).trim() === spec.value ? 'ok' : 'wrong';
        } catch {
          status = 'error';
        }
      }
      results.push({ status, size: file.size });
    }
    return results;
  }

  function applyResults(results, folderName) {
    resetRows();
    let problems = 0;
    results.forEach((result, index) => {
      const [label, className] = LABELS[result.status] || LABELS.error;
      const row = rows[index];
      row.stateCell.textContent = label;
      row.stateCell.className = className;
      row.foundCell.textContent = result.size == null ? '—' : formatSize(result.size);
      if (result.status !== 'ok') problems++;
    });

    const coreMissing = SPEC.some((spec, index) => spec.kind === 'jeu' && results[index].status !== 'ok');
    const packMissing = SPEC.some((spec, index) => spec.kind === 'pack' && results[index].status !== 'ok');

    summaryEl.hidden = false;
    summaryEl.className = 'summary ' + (coreMissing ? 'bad' : packMissing ? 'warn' : 'ok');
    summaryEl.textContent = coreMissing
      ? 'Ce dossier ne ressemble pas à une installation complète de Rec Room. Vérifie que tu as choisi le dossier qui contient RecRoom.exe.'
      : packMissing
        ? 'Rec Room officiel détecté. Le pack REC BLUE est incomplet : place le launcher REC BLUE dans ce dossier, à côté de RecRoom.exe.'
        : 'Dossier complet : Rec Room officiel et pack REC BLUE sont en place.';

    statusEl.textContent = (folderName ? 'Dossier « ' + folderName + ' » · ' : '') +
      (problems ? problems + ' fichier(s) à vérifier.' : 'Tous les fichiers attendus sont présents.');
  }

  function selectedFolderName(files) {
    const relative = files[0] && files[0].webkitRelativePath ? files[0].webkitRelativePath : '';
    if (!relative) return '';
    return relative.split('/')[0] || '';
  }

  if (typeof window.showDirectoryPicker !== 'function') {
    pickButton.hidden = true;
    statusEl.textContent = 'Ton navigateur ne propose pas la sélection directe : utilise « Autre navigateur ».';
  }

  pickButton.addEventListener('click', async () => {
    if (typeof window.showDirectoryPicker !== 'function') return;
    let root;
    try {
      root = await window.showDirectoryPicker({ mode: 'read' });
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      statusEl.textContent = 'Sélection impossible : ' + ((error && error.message) || 'réessaie depuis un navigateur récent.');
      return;
    }
    statusEl.textContent = 'Vérification de « ' + root.name + ' »...';
    const results = await readDirectory(root);
    applyResults(results, root.name);
  });

  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    if (!files.length) return;
    const map = new Map();
    for (const file of files) {
      const relative = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
      const parts = relative.split('/');
      map.set(parts.length > 1 ? parts.slice(1).join('/') : relative, file);
    }
    const folderName = selectedFolderName(files);
    statusEl.textContent = 'Vérification...';
    const results = await readFileMap(map);
    applyResults(results, folderName);
    fileInput.value = '';
  });
})();
