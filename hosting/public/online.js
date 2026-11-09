// Compteur de joueurs connectés + état réel des services, affichés sur l'accueil.
// Tout vient du serveur de jeu (présences, rooms), jamais d'une copie locale.
(function () {
  const pill = document.getElementById('online-count');
  const note = document.getElementById('players-note');
  const gameDetail = document.getElementById('status-game-detail');
  const gameBadge = document.getElementById('status-game-badge');
  const presenceDetail = document.getElementById('status-presence-detail');
  const presenceBadge = document.getElementById('status-presence-badge');
  const statusNote = document.getElementById('status-note');
  const liveStats = document.getElementById('live-stats');
  const liveOnline = document.getElementById('live-online');
  const liveDevices = document.getElementById('live-devices');
  const liveVersions = document.getElementById('live-versions');
  const liveRooms = document.getElementById('live-rooms');
  const liveStatsNote = document.getElementById('live-stats-note');
  if (!pill && !note && !gameBadge) return;

  let etat = null;

  function badge(el, texte, ok) {
    if (!el) return;
    el.textContent = texte;
    el.classList.toggle('ok', ok === true);
  }

  function joueurs(n) {
    return n === 1 ? '1 joueur connecté au jeu' : n + ' joueurs connectés au jeu';
  }

  // Remplit une liste sans jamais interpréter le texte des joueurs comme du HTML :
  // les noms de salles viennent du jeu, donc de comptes utilisateurs.
  function fillList(el, rows, labelOf) {
    if (!el) return;
    el.replaceChildren();
    if (!rows || rows.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'live-empty';
      empty.textContent = 'Aucune donnée';
      el.appendChild(empty);
      return;
    }
    for (const row of rows) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = labelOf(row);
      const value = document.createElement('span');
      value.textContent = String(Number(row.count) || 0);
      li.append(name, value);
      el.appendChild(li);
    }
  }

  function renderLiveStats() {
    if (!etat || !liveStats) return;
    liveStats.hidden = false;

    if (liveOnline) liveOnline.textContent = String(etat.online);
    fillList(liveDevices, etat.devices, row => row.name);
    fillList(liveVersions, etat.versions, row => row.build);
    fillList(liveRooms, etat.activeRooms, row => row.name);

    if (liveStatsNote) {
      liveStatsNote.textContent = etat.hasStats
        ? 'Statistiques lues sur le serveur de jeu, actualisées toutes les 30 secondes.'
        : 'Statistiques momentanément indisponibles.';
    }
  }

  function render() {
    if (!etat) return;
    const n = etat.online;

    if (pill) pill.textContent = 'Joueurs en ligne : ' + n;
    if (note) {
      note.textContent = n === 0
        ? 'Personne n’est connecté au jeu pour le moment.'
        : joueurs(n) + ' en ce moment. Les chambres actuelles sont sur la page Chambres.';
    }

    if (gameDetail) {
      gameDetail.textContent = etat.game
        ? (etat.rooms ? 'Le serveur de jeu et les chambres répondent.' : 'Comptes et économie répondent, les chambres sont muettes.')
        : 'Le serveur de jeu ne répond pas.';
    }
    badge(gameBadge, etat.game ? (etat.rooms ? 'Opérationnel' : 'Partiel') : 'Injoignable', etat.game && etat.rooms);

    if (presenceDetail) {
      presenceDetail.textContent = etat.presence
        ? joueurs(n) + ' en ce moment.'
        : 'La présence est momentanément indisponible.';
    }
    badge(presenceBadge, etat.presence ? 'Connecté' : 'Indisponible', etat.presence);

    renderLiveStats();

    if (statusNote) {
      statusNote.textContent = 'Vérifié à ' + new Date().toLocaleTimeString() + ', actualisé toutes les 30 secondes.';
    }
  }

  function load() {
    fetch('/api/game/status', { cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) {
        if (!data) return;
        etat = {
          game: Boolean(data.game),
          rooms: Boolean(data.rooms),
          presence: Boolean(data.presence),
          online: Number(data.online) || 0,
          hasStats: Boolean(data.presence),
          devices: Array.isArray(data.devices) ? data.devices : [],
          versions: Array.isArray(data.versions) ? data.versions : [],
          activeRooms: Array.isArray(data.activeRooms) ? data.activeRooms : []
        };
        render();
      })
      .catch(function () {});
  }

  load();
  setInterval(load, 30000);
  // Le site retraduit ses textes au changement de langue : on réaffiche après.
  document.addEventListener('recblue:language', function () { setTimeout(render, 0); });
})();
