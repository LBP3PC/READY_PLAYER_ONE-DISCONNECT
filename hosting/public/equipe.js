// Page « Joueurs & équipe » : la liste des comptes du JEU (et qui est en ligne),
// avec un rôle et une certification réglables d'un clic. Tout part sur le compte de
// jeu via le Worker du site ; le navigateur n'a jamais le jeton partagé.
(() => {
  const byId = id => document.getElementById(id);
  const config = window.RECBLUE_ACCOUNTS;
  const labels = { member: 'Membre', moderator: 'Modérateur', admin: 'Administrateur' };
  let client = null;
  let players = [];
  const say = text => { byId('msg').textContent = text; };

  if (config && window.supabase) {
    client = window.supabase.createClient(config.supabaseUrl, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  }

  async function sessionToken() {
    if (!client) return '';
    const { data } = await client.auth.getSession();
    return data && data.session ? data.session.access_token : '';
  }

  async function call(path, payload) {
    const token = await sessionToken();
    if (!token) {
      throw new Error('Connectez-vous sur le site avec un compte administrateur, puis rechargez cette page.');
    }
    const response = await fetch(path, {
      method: payload ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
      cache: 'no-store'
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error((body && body.error) || ('statut ' + response.status));
    return body || {};
  }

  function initials(name) {
    return String(name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  }

  function badges(player) {
    const wrap = document.createElement('div');
    wrap.className = 'badges';
    const add = (text, kind) => {
      const badge = document.createElement('span');
      badge.className = 'badge' + (kind ? ' ' + kind : '');
      badge.textContent = text;
      wrap.append(badge);
    };
    if (player.online) add('En ligne', 'live');
    add(labels[player.role] || 'Membre', player.role === 'admin' ? 'admin' : player.role === 'moderator' ? 'mod' : '');
    if (player.plus) add('Plus');
    if (player.banned) add('Banni', 'banned');
    return wrap;
  }

  async function act(button, action) {
    const previous = button.textContent;
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      say(error.message || 'Action refusée.');
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  }

  function row(player) {
    const el = document.createElement('div');
    el.className = 'row' + (player.online ? ' online' : '');

    const who = document.createElement('div');
    who.className = 'who';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = initials(player.username);
    const names = document.createElement('span');
    names.className = 'names';
    const strong = document.createElement('strong');
    strong.textContent = player.username;
    strong.setAttribute('data-no-translate', '');
    // La coche bleue de certification, collée au pseudo comme sur le reste du site.
    if (player.certified) {
      const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      mark.setAttribute('class', 'verified-mark');
      mark.setAttribute('role', 'img');
      mark.setAttribute('aria-label', 'Certifié');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#recblue-verified');
      mark.append(use);
      strong.append(mark);
    }
    names.append(strong);
    if (player.displayName && player.displayName !== player.username) {
      const small = document.createElement('small');
      small.textContent = 'Nom affiché : ' + player.displayName;
      small.setAttribute('data-no-translate', '');
      names.append(small);
    }
    who.append(avatar, names);

    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Rôle de ' + player.username);
    Object.entries(labels).forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    });
    select.value = player.role;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'btn';
    apply.textContent = 'Appliquer';
    apply.disabled = select.value === player.role;
    select.addEventListener('change', () => { apply.disabled = select.value === player.role; });
    apply.addEventListener('click', () => act(apply, async () => {
      await call('/api/game/role', { target: player.username, role: select.value });
      say('Rôle de ' + player.username + ' : ' + (labels[select.value] || select.value) + ' (effectif à sa prochaine connexion en jeu).');
      await load();
    }));

    const certify = document.createElement('button');
    certify.type = 'button';
    certify.className = 'btn ghost';
    certify.textContent = player.certified ? 'Retirer la certification' : 'Certifier';
    certify.addEventListener('click', () => act(certify, async () => {
      await call('/api/game/certify', { target: player.username, certified: !player.certified });
      say((player.certified ? 'Certification retirée à ' : 'Compte certifié : ') + player.username + ' (badge influenceur en jeu à sa prochaine connexion).');
      await load();
    }));

    // Plus : un an d'un clic, ou retrait s'il l'a déjà.
    const plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'btn ghost';
    plusBtn.textContent = player.plus ? 'Retirer le Plus' : 'Plus 1 an';
    plusBtn.addEventListener('click', () => act(plusBtn, async () => {
      const until = player.plus ? null : new Date(Date.now() + 365 * 86400000).toISOString();
      await call('/api/game/plus', { target: player.username, until });
      say((until ? 'Plus accordé à ' : 'Plus retiré à ') + player.username + ' — actif dans le jeu sans reconnexion.');
      await load();
    }));

    // Crédits : le montant est demandé, puis offert sur le compte de jeu.
    const creditsBtn = document.createElement('button');
    creditsBtn.type = 'button';
    creditsBtn.className = 'btn ghost';
    creditsBtn.textContent = 'Crédits';
    creditsBtn.addEventListener('click', () => act(creditsBtn, async () => {
      const answer = window.prompt('Crédits à offrir à ' + player.username, '500');
      if (answer === null) return;
      const tokens = Math.round(Number(String(answer).replace(',', '.')));
      if (!Number.isFinite(tokens) || tokens <= 0) throw new Error('Montant invalide.');
      const result = await call('/api/game/grant', { target: player.username, tokens });
      say(tokens + ' crédits offerts à ' + player.username +
        (result && typeof result.credits === 'number' ? ' — nouveau solde : ' + result.credits : '') + '.');
      await load();
    }));

    // Bannissement : motif et durée demandés, un clic pour lever.
    const banBtn = document.createElement('button');
    banBtn.type = 'button';
    banBtn.className = 'btn ghost';
    banBtn.textContent = player.banned ? 'Débannir' : 'Bannir';
    banBtn.addEventListener('click', () => act(banBtn, async () => {
      if (player.banned) {
        await call('/api/game/ban', { target: player.username, ban: false });
        say(player.username + ' n’est plus banni.');
      } else {
        const reason = window.prompt('Motif du bannissement de ' + player.username, 'Non-respect des règles');
        if (reason === null) return;
        const days = window.prompt('Durée en jours (vide = définitif)', '7');
        if (days === null) return;
        await call('/api/game/ban', { target: player.username, ban: true, reason, days: days.trim() });
        say(player.username + ' est banni ' +
          (days.trim() ? 'pour ' + days.trim() + ' jour(s).' : 'définitivement.'));
      }
      await load();
    }));

    actions.append(select, apply, certify, plusBtn, creditsBtn, banBtn);
    el.append(who, badges(player), actions);
    return el;
  }

  function render() {
    const query = byId('query').value.trim().toLowerCase();
    const onlyOnline = byId('only-online').checked;
    const list = byId('list');
    const shown = players.filter(player => {
      if (onlyOnline && !player.online) return false;
      if (query === '') return true;
      return player.username.toLowerCase().includes(query)
        || String(player.displayName || '').toLowerCase().includes(query)
        || String(player.accountId) === query;
    });
    const rows = shown.map(row);
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = players.length === 0 ? 'Aucun compte pour le moment.' : 'Personne ne correspond à cette recherche.';
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...rows);
  }

  async function load() {
    byId('refresh').disabled = true;
    try {
      const result = await call('/api/game/players');
      players = Array.isArray(result.players) ? result.players : [];
      const online = players.filter(player => player.online).length;
      byId('count').textContent = players.length + ' comptes · ' + online + ' en ligne';
      render();
      say('');
    } catch (error) {
      say(error.message || 'Liste indisponible.');
    } finally {
      byId('refresh').disabled = false;
    }
  }

  byId('refresh').addEventListener('click', load);
  byId('query').addEventListener('input', render);
  byId('only-online').addEventListener('change', render);
  load();
})();
