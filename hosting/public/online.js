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

  function render() {
    if (!etat) return;
    const n = etat.online;

    if (pill) pill.textContent = 'Joueurs en ligne : ' + n;
    if (note) {
      note.textContent = n === 0
        ? 'Personne n’est connecté au jeu pour le moment.'
        : joueurs(n) + (n === 1 ? ' en ce moment.' : ' en ce moment.') + ' Les chambres actuelles sont sur la page Chambres.';
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
          online: Number(data.online) || 0
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
