// Annuaire public de REC BLUE : liste des joueurs et fiche profil.
// Les données viennent du Worker du site, jamais directement du serveur de jeu.
(() => {
  'use strict';

  const API = '/api/community/players';
  const API_LIKE = '/api/community/like';
  const byId = id => document.getElementById(id);
  const requested = new URLSearchParams(location.search).get('joueur')?.trim() || '';
  const DEFAULT_AVATAR = `
    <svg class="avatar-art" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="14" fill="#ffffff"/>
      <path d="M19 18h26c4.8 0 8.1 3.5 9 8.4l2 10.1c.9 4.8-3.8 8.1-7.8 5.4l-6.6-4.4H22.4l-6.6 4.4c-4 2.7-8.7-.6-7.8-5.4l2-10.1C11 21.5 14.2 18 19 18Z" fill="#101114"/>
      <circle cx="24" cy="31" r="3" fill="#ffffff"/>
      <path d="M38 27v8M34 31h8" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
      <circle cx="44" cy="31" r="3" fill="#ffffff"/>
    </svg>`;

  const listView = byId('list-view');
  const profileView = byId('profile-view');
  const profileCard = byId('profile-card');
  const profileEmpty = byId('profile-empty');
  const grid = byId('player-grid');
  const playerCount = byId('player-count');
  const status = byId('status');
  const retry = byId('retry');
  const likeButton = byId('like-profile');
  const likeLabel = byId('like-label');

  let players = [];
  let currentPlayer = null;
  let profileToken = 0;
  let likeBusy = false;
  let accountClient = null;

  const roleLabels = {
    owner: 'Propriétaire',
    admin: 'Administrateur',
    moderator: 'Modérateur',
    staff: 'Personnel',
    member: 'Membre'
  };

  const roleGroups = [
    { key: 'owner', title: 'Propriétaire', roles: ['owner'] },
    { key: 'admin', title: 'Administrateurs', roles: ['admin'] },
    { key: 'staff', title: 'Personnel', roles: ['moderator', 'staff'] },
    { key: 'member', title: 'Joueurs', roles: ['member'] }
  ];

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const gameBadgeLabels = {
    plus: 'REC Room Plus',
    certified: 'Profil certifié'
  };

  function playerName(player) {
    return String(player.displayName || player.username || 'Joueur').trim() || 'Joueur';
  }

  function playerHandle(player) {
    const username = String(player.username || '').trim();
    return username === '' ? '' : '@' + username;
  }

  function safeAvatarUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(String(value), location.href);
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function fillAvatar(box, player) {
    box.replaceChildren();
    const source = safeAvatarUrl(player.avatarUrl);
    if (source === '') {
      box.innerHTML = DEFAULT_AVATAR;
      return;
    }
    const image = document.createElement('img');
    image.src = source;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => {
      image.remove();
      box.innerHTML = DEFAULT_AVATAR;
    }, { once: true });
    box.append(image);
  }

  function cardAvatar(player) {
    const box = document.createElement('span');
    box.className = 'avatar';
    box.setAttribute('aria-hidden', 'true');
    fillAvatar(box, player);
    return box;
  }

  function createCard(player) {
    const name = playerName(player);
    const handle = playerHandle(player);
    const card = document.createElement('a');
    card.className = 'player-card';
    card.href = 'communaute.html?joueur=' + encodeURIComponent(String(player.username || name));
    card.setAttribute('aria-label', 'Voir le profil de ' + name + (handle ? ' (' + handle + ')' : ''));

    const copy = document.createElement('span');
    copy.className = 'player-copy';

    const strong = document.createElement('strong');
    strong.className = 'player-name';
    strong.textContent = name;

    const handleLine = document.createElement('span');
    handleLine.className = 'player-handle';
    handleLine.textContent = handle;

    const level = document.createElement('span');
    level.className = 'player-level';
    level.textContent = 'Niveau ' + formatNumber(player.level) + ' · ❤ ' + formatNumber(player.likes);

    copy.append(strong, handleLine, playerBadges(player), level);
    card.append(cardAvatar(player), copy);
    return card;
  }

  function formatNumber(value) {
    const number = Number(value);
    return String(Number.isFinite(number) && number > 0 ? Math.floor(number) : 0)
      .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }).format(date);
  }

  function roleLabel(role) {
    return roleLabels[role] || roleLabels.member;
  }

  function roleClassName(value) {
    const role = String(value || '').toLowerCase();
    return ['owner', 'admin', 'moderator', 'staff'].includes(role) ? role : 'member';
  }

  function gameBadge(kind) {
    const label = gameBadgeLabels[kind];
    if (!label) return null;
    const badge = document.createElement('span');
    badge.className = 'game-badge ' + kind;
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', label);
    badge.title = label;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'game-badge-icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', kind === 'plus' ? '#recblue-plus' : '#recblue-verified');
    svg.append(use);
    badge.append(svg);
    return badge;
  }

  function playerBadges(player) {
    const row = document.createElement('span');
    row.className = 'player-badges';
    const roleName = String(player.role || '').toLowerCase();
    const role = document.createElement('span');
    role.className = 'player-role ' + roleClassName(roleName);
    role.textContent = roleLabel(roleName);
    row.append(role);
    if (player.plus) row.append(gameBadge('plus'));
    if (player.certified) row.append(gameBadge('certified'));
    return row;
  }

  function profileBio(player) {
    if (player.role === 'owner') return 'Propriétaire de REC BLUE.';
    if (player.role === 'admin') return 'Fait partie de l’équipe d’administration REC BLUE.';
    if (player.role === 'moderator' || player.role === 'staff') return 'Membre du personnel REC BLUE.';
    return 'Membre de la communauté REC BLUE.';
  }

  // Le site réutilise la session Supabase de « Mon compte » ; le jeton ne sert qu’à
  // prouver au Worker qui donne le like, jamais à appeler le jeu directement.
  function getAccountClient() {
    if (accountClient) return accountClient;
    const config = window.RECBLUE_ACCOUNTS;
    if (!window.supabase?.createClient || !config?.supabaseUrl || !config?.publishableKey) {
      return null;
    }
    try {
      const projectRef = new URL(config.supabaseUrl).hostname.split('.')[0];
      accountClient = window.supabase.createClient(config.supabaseUrl, config.publishableKey, {
        auth: {
          storageKey: 'sb-' + projectRef + '-auth-token',
          autoRefreshToken: true,
          detectSessionInUrl: false
        }
      });
      return accountClient;
    } catch {
      return null;
    }
  }

  async function sessionToken() {
    const client = getAccountClient();
    if (!client) return '';
    try {
      const { data } = await client.auth.getSession();
      return data && data.session ? data.session.access_token : '';
    } catch {
      return '';
    }
  }

  function setLikes(value, fallback) {
    const number = Number(value);
    const fallbackNumber = Number(fallback);
    const likes = Number.isFinite(number) && number >= 0
      ? Math.floor(number)
      : Number.isFinite(fallbackNumber) && fallbackNumber >= 0
        ? Math.floor(fallbackNumber)
        : 0;
    byId('profile-likes').textContent = formatNumber(likes);
    if (currentPlayer) currentPlayer.likes = likes;
  }

  function markLiked() {
    likeButton.setAttribute('aria-pressed', 'true');
    likeButton.disabled = true;
    likeLabel.textContent = 'Aimé';
  }

  function resetLike(player) {
    likeButton.disabled = false;
    likeButton.setAttribute('aria-pressed', 'false');
    likeLabel.textContent = 'J’aime';
    setLikes(player.likes, 0);
  }

  async function loadLikeState(player, generation) {
    const accessToken = await sessionToken();
    if (!accessToken || generation !== profileToken) return;
    try {
      const response = await fetch(
        API_LIKE + '?target=' + encodeURIComponent(String(player.username || player.displayName)),
        {
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + accessToken },
          cache: 'no-store'
        }
      );
      if (generation !== profileToken || !response.ok) return;
      const data = await response.json().catch(() => null);
      if (!data || generation !== profileToken) return;
      setLikes(data.likes, player.likes);
      if (data.liked === true) markLiked();
    } catch {
      /* L’état du like ne doit pas empêcher la fiche de s’afficher. */
    }
  }

  async function likeProfile() {
    if (likeBusy || !currentPlayer) return;
    likeBusy = true;
    likeButton.disabled = true;
    const player = currentPlayer;
    const generation = profileToken;
    const accessToken = await sessionToken();
    if (generation !== profileToken) {
      likeBusy = false;
      return;
    }
    if (!accessToken) {
      likeBusy = false;
      likeButton.disabled = false;
      byId('profile-status').textContent = 'Connectez-vous depuis Mon compte pour aimer ce profil.';
      return;
    }

    try {
      const response = await fetch(API_LIKE, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ target: String(player.username || player.displayName) }),
        cache: 'no-store'
      });
      const data = await response.json().catch(() => null);
      if (generation !== profileToken) return;
      if (!response.ok) {
        byId('profile-status').textContent =
          (data && data.error) || 'Impossible d’enregistrer ce like pour le moment.';
        likeButton.disabled = false;
        return;
      }
      setLikes(data && data.likes, player.likes);
      markLiked();
      byId('profile-status').textContent =
        data && data.isNew === false
          ? 'Tu as déjà aimé ce profil.'
          : 'Merci ! Ton like est enregistré dans le jeu.';
    } catch {
      if (generation === profileToken) {
        byId('profile-status').textContent = 'Le serveur de jeu est momentanément indisponible.';
        likeButton.disabled = false;
      }
    } finally {
      likeBusy = false;
    }
  }

  function roleGroupKey(value) {
    const role = String(value || '').toLowerCase();
    const group = roleGroups.find(item => item.roles.includes(role));
    return group ? group.key : 'member';
  }

  function renderList() {
    currentPlayer = null;
    profileToken += 1;
    if (players.length === 0) {
      grid.replaceChildren();
      status.textContent = 'Aucun membre REC BLUE pour le moment.';
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const group of roleGroups) {
      const members = players
        .filter(player => roleGroupKey(player.role) === group.key)
        .sort((a, b) => playerName(a).localeCompare(playerName(b), 'fr', { sensitivity: 'base' }));
      if (members.length === 0) continue;

      const section = document.createElement('section');
      section.className = 'role-group';
      section.dataset.role = group.key;

      const heading = document.createElement('div');
      heading.className = 'role-heading';
      const title = document.createElement('h2');
      title.id = 'role-' + group.key;
      title.textContent = group.title;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(members.length);
      heading.append(title, count);
      section.setAttribute('aria-labelledby', title.id);

      const groupGrid = document.createElement('div');
      groupGrid.className = 'player-grid';
      groupGrid.append(...members.map(createCard));
      section.append(heading, groupGrid);
      fragment.append(section);
    }
    grid.replaceChildren(fragment);
    status.textContent = '';
  }

  function showProfile(player) {
    const name = playerName(player);
    currentPlayer = player;
    profileToken += 1;
    const generation = profileToken;
    listView.hidden = true;
    profileView.hidden = false;
    profileCard.hidden = false;
    profileEmpty.hidden = true;

    document.title = name + ' · REC BLUE';
    byId('profile-name').textContent = name;
    byId('profile-handle').textContent = playerHandle(player);
    const role = byId('profile-role');
    const roleName = String(player.role || '').toLowerCase();
    role.textContent = roleLabel(roleName);
    role.className = 'profile-role ' + roleClassName(roleName);
    const badges = byId('profile-badges');
    badges.replaceChildren();
    if (player.plus) badges.append(gameBadge('plus'));
    if (player.certified) badges.append(gameBadge('certified'));
    badges.hidden = badges.childElementCount === 0;
    byId('profile-bio').textContent = profileBio(player);
    byId('profile-level').textContent = formatNumber(player.level);
    byId('profile-xp').textContent = formatNumber(player.xp);
    byId('profile-joined').textContent = formatDate(player.joinedAt);
    byId('profile-status').textContent = '';
    resetLike(player);
    fillAvatar(byId('profile-avatar'), player);

    const report = byId('report-profile');
    const subject = 'Signalement du profil @' + String(player.username || name);
    const body = 'Bonjour,\n\nJe souhaite signaler le profil @' + String(player.username || name) +
      ' sur REC BLUE.\n\nRaison : \n\nLien du profil : ' + location.href;
    report.href = 'mailto:support@recblue.net?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body);

    loadLikeState(player, generation);
    window.scrollTo(0, 0);
  }

  function showMissing() {
    currentPlayer = null;
    profileToken += 1;
    listView.hidden = true;
    profileView.hidden = false;
    profileCard.hidden = true;
    profileEmpty.hidden = false;
    profileEmpty.textContent = 'Ce joueur n’est pas présent dans l’annuaire.';
    playerCount.textContent = String(players.length);
    document.title = 'Joueur introuvable · REC BLUE';
    window.scrollTo(0, 0);
  }

  function showProfileError(message) {
    currentPlayer = null;
    profileToken += 1;
    listView.hidden = true;
    profileView.hidden = false;
    profileCard.hidden = true;
    profileEmpty.hidden = false;
    profileEmpty.textContent = message;
    playerCount.textContent = '—';
    document.title = 'Joueur · REC BLUE';
  }

  function requestedPlayer() {
    const needle = requested.toLowerCase();
    return players.find(player => {
      const username = String(player.username || '').trim().toLowerCase();
      const display = String(player.displayName || '').trim().toLowerCase();
      return username === needle || display === needle;
    });
  }

  async function load() {
    retry.hidden = true;
    if (requested !== '') {
      listView.hidden = true;
      profileView.hidden = false;
      profileCard.hidden = true;
      profileEmpty.hidden = false;
      profileEmpty.textContent = 'Chargement du profil…';
    } else {
      status.textContent = 'Chargement des joueurs…';
    }

    try {
      const response = await fetch(API, {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error((data && data.error) || 'La liste des joueurs est indisponible.');
      }

      players = Array.isArray(data && data.players) ? data.players : [];
      playerCount.textContent = String(
        data && Number.isFinite(Number(data.count)) ? Number(data.count) : players.length
      );

      if (requested !== '') {
        const player = requestedPlayer();
        if (player) showProfile(player);
        else showMissing();
      } else {
        renderList();
      }
    } catch (error) {
      const message = error && error.message
        ? error.message
        : 'La liste des joueurs est momentanément indisponible.';
      if (requested !== '') {
        showProfileError(message);
      } else {
        status.textContent = message;
        playerCount.textContent = '—';
        retry.hidden = false;
      }
    }
  }

  async function writeClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        /* Le navigateur peut refuser le presse-papiers : on tente le repli. */
      }
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    } finally {
      area.remove();
    }
    return copied;
  }

  async function copyProfileLink() {
    const copied = await writeClipboard(location.href);
    const line = byId('profile-status');
    if (!copied) {
      line.textContent =
        'Impossible de copier le lien. Copiez l’adresse depuis la barre du navigateur.';
      return;
    }
    line.textContent = 'Lien du profil copié.';
    window.setTimeout(() => {
      if (line.textContent === 'Lien du profil copié.') line.textContent = '';
    }, 3000);
  }

  byId('copy-profile').addEventListener('click', copyProfileLink);
  likeButton.addEventListener('click', likeProfile);
  retry.addEventListener('click', load);
  load();
})();
