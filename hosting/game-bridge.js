'use strict';

// Passerelle entre le site (comptes Supabase) et notre serveur de jeu auto-hébergé.
//
//  - /api/game/signup : crée le compte de JEU avec le pseudo + mot de passe du site,
//    puis lui donne ce pseudo comme nom en jeu. C'est ce qui fait qu'un compte créé
//    sur le site sert tout de suite à se connecter dans Rec Room.
//  - grant : après une attribution confirmée, crédite les jetons du JEU et laisse
//    une box à ouvrir (appelé depuis le Worker, jamais par le navigateur).
//
// Le pont vers econ est authentifié par SITE_BRIDGE_TOKEN, un secret partagé entre ce
// Worker et le serveur de jeu : il ne sort jamais vers le navigateur.

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });

/** Mêmes règles de pseudo que le site. */
const PSEUDO = /^[a-z0-9_][a-z0-9_-]{2,19}$/;

function keep(value, fallback) {
  const text = String(value || '').trim();
  return (text === '' ? fallback : text).replace(/\/+$/, '');
}

export function gameSettings(env) {
  return {
    supabaseUrl: keep(env.SUPABASE_URL, 'https://nnftdqrbagynbblthkfg.supabase.co'),
    supabaseKey:
      env.SUPABASE_PUBLISHABLE_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5uZnRkcXJiYWd5bmJibHRoa2ZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM3MDA5OTEsImV4cCI6MjEwOTI3Njk5MX0.JHTNOWkI9DY1xhU8PKco4KqxsIxp_-IsSZL211NGEE8',
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    authHost: keep(env.GAME_AUTH_HOST, 'https://auth.recblue.net'),
    accountsHost: keep(env.GAME_ACCOUNTS_HOST, 'https://accounts.recblue.net'),
    econHost: keep(env.GAME_ECON_HOST, 'https://econ.recblue.net'),
    // Le service d'images du jeu : c'est lui qui sert les photos de profil du client.
    imagesHost: keep(env.GAME_IMAGES_HOST, 'https://img.recblue.net'),
    roomsHost: keep(env.GAME_ROOMS_HOST, 'https://rooms.recblue.net'),
    bridgeToken: env.SITE_BRIDGE_TOKEN || ''
  };
}

/** Le joueur derrière le jeton de session Supabase, ou null. */
async function currentUser(request, cfg) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const response = await fetch(cfg.supabaseUrl + '/auth/v1/user', {
    headers: { apikey: cfg.supabaseKey, Authorization: 'Bearer ' + match[1] }
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  return data && data.id ? data : null;
}

/**
 * Crée le compte de jeu. Le mot de passe est celui du site : c'est le même identifiant
 * pour se connecter dans Rec Room (pseudo + mot de passe).
 */
export async function handleGameSignup(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });

  const cfg = gameSettings(env);
  const user = await currentUser(request, cfg);
  if (!user) return json(401, { error: 'Connectez-vous d’abord sur le site.' });

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const pseudo = String(body.pseudo || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!PSEUDO.test(pseudo)) {
    return json(400, { error: 'Pseudo invalide : 3 à 20 lettres, chiffres, tiret ou souligné.' });
  }
  if (password.length < 8) {
    return json(400, { error: 'Mot de passe trop court pour le jeu (8 caractères minimum).' });
  }

  // 1. Le compte de jeu (le serveur attribue un nom au hasard).
  let created;
  try {
    created = await fetch(cfg.authHost + '/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'create_account', password }).toString()
    });
  } catch (error) {
    return json(502, { error: 'Le serveur de jeu est injoignable pour le moment. Réessaie dans un instant.' });
  }
  const token = await created.json().catch(() => null);
  if (!created.ok || !token || !token.access_token) {
    const reason =
      token && (token.error_description || token.error)
        ? String(token.error_description || token.error)
        : 'statut ' + created.status;
    return json(502, { error: 'Le serveur de jeu a refusé la création du compte (' + reason + ').' });
  }

  // 2. Le pseudo du site devient le nom en jeu.
  let renamed = false;
  let warning = null;
  try {
    const rename = await fetch(cfg.accountsHost + '/account/me/username', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token.access_token,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ username: pseudo }).toString()
    });
    const result = await rename.json().catch(() => null);
    const error =
      result && result.error
        ? typeof result.error === 'string'
          ? result.error
          : JSON.stringify(result.error)
        : '';
    renamed = rename.ok && error === '';
    if (!renamed) {
      warning =
        error === ''
          ? 'Le pseudo en jeu est resté celui attribué automatiquement.'
          : 'Pseudo en jeu non appliqué : ' + error;
    }
  } catch {
    warning = 'Pseudo en jeu non appliqué (serveur des comptes injoignable).';
  }

  return json(200, {
    ok: true,
    username: pseudo,
    renamed,
    warning,
    gameUsername: token.game_username || token.username || null,
    gameAccountId: token.account_id || null
  });
}

/**
 * Crédite le compte de JEU d'un joueur et lui laisse une box du même montant.
 * `userId` est l'id du compte du SITE ; le pseudo est relu côté Supabase (avec la clé
 * de service) pour ne jamais faire confiance au navigateur sur le destinataire.
 */
/**
 * Les pseudos de JEU possibles pour un compte du site, dans l'ordre d'essai : le pseudo
 * affiché (un compte créé avec une adresse email garde par exemple `LBP3PC`), puis celui
 * de l'adresse de connexion `pseudo@players.recblue.invalid` (les deux sont identiques
 * pour un compte créé par pseudo). Le jeu tranche : celui qu'il connaît est le bon.
 */
async function gameUsernames(cfg, userId, loginPseudo) {
  const names = [];
  if (cfg.serviceKey) {
    try {
      const lookup = await fetch(
        cfg.supabaseUrl +
          '/rest/v1/recblue_accounts?select=display_name&id=eq.' +
          encodeURIComponent(String(userId)),
        { headers: { apikey: cfg.serviceKey, Authorization: 'Bearer ' + cfg.serviceKey } }
      );
      const rows = await lookup.json().catch(() => null);
      const name =
        Array.isArray(rows) && rows[0] ? String(rows[0].display_name || '').trim().toLowerCase() : '';
      if (name !== '') names.push(name);
    } catch {
      /* pas de fiche lisible : on garde l'autre piste */
    }
  }
  const login = String(loginPseudo || '').trim().toLowerCase();
  if (login !== '' && !names.includes(login)) names.push(login);
  return names.filter(name => PSEUDO.test(name));
}

export async function grantGameCredits(env, userId, tokens, orderId, pseudo, message) {
  const cfg = gameSettings(env);
  if (cfg.bridgeToken === '') return { ok: false, reason: 'bridge off' };

  const names = await gameUsernames(cfg, userId, pseudo);
  if (names.length === 0) return { ok: false, reason: 'no pseudo' };

  let lastStatus = 0;
  for (const username of names) {
    const response = await fetch(cfg.econHost + '/api/site/grant', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.bridgeToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username,
        tokens,
        message: message || 'Merci pour ton achat sur recblue.net ! (commande ' + orderId + ')'
      })
    }).catch(() => null);

    if (response === null) return { ok: false, reason: 'unreachable' };
    if (response.status === 404) {
      lastStatus = 404;
      continue;
    }
    if (!response.ok) return { ok: false, reason: 'status ' + response.status };
    const data = await response.json().catch(() => null);
    return { ok: true, username, giftId: data && data.giftId, balance: data && data.balance };
  }
  return { ok: false, reason: 'status ' + (lastStatus || 404) };
}

/** Le pseudo de connexion du site, dérivé de `pseudo@players.recblue.invalid`. */
/**
 * Le REC BLUE Plus d'un ACHAT payé : la date de fin est écrite dans Supabase (c'est la
 * colonne que le site affiche et que l'administration liste), puis poussée sur le compte de
 * JEU par le pont econ. Prolonge depuis la date de fin actuelle quand l'abonnement court
 * encore, sinon depuis maintenant, pour qu'un renouvellement ne perde pas les jours restants.
 *
 * Séparé de `handleGameSitePlus` (la route d'administration, ciblée par pseudo) : ici la
 * cible est l'acheteur lui-même, identifié par son id Supabase juste après le paiement.
 */
export async function syncGamePlus(env, userId, loginPseudo) {
  const cfg = gameSettings(env);
  if (cfg.serviceKey === '') return { ok: false, reason: 'service off' };
  const id = encodeURIComponent(String(userId));

  // La date de fin n'est PAS calculée ici : la fonction SQL `recblue_credit_purchase`
  // l'étend déjà d'un mois à chaque achat `pplus` (voir purchases.sql). On la RELIT pour
  // la recopier, sinon un même paiement donnerait deux mois.
  const current = await fetch(
    cfg.supabaseUrl + '/rest/v1/recblue_accounts?select=plus_until&id=eq.' + id,
    { headers: { apikey: cfg.serviceKey, Authorization: 'Bearer ' + cfg.serviceKey } }
  )
    .then(result => (result.ok ? result.json() : null))
    .catch(() => null);
  if (!Array.isArray(current)) return { ok: false, reason: 'accounts unreachable' };
  const row = current[0] ? current[0] : {};
  const until = row.plus_until ? String(row.plus_until) : null;
  if (until === null) return { ok: false, reason: 'no plus on the site' };

  // Le jeu : même pont que l'administration, mais l'achat reste valable si le serveur de
  // jeu ne répond pas — la date est déjà enregistrée, le jeu la relit à la connexion.
  let game = { ok: false, reason: 'no pseudo' };
  if (cfg.bridgeToken !== '') {
    const names = await gameUsernames(cfg, userId, loginPseudo);
    for (const username of names) {
      const sync = await fetch(cfg.econHost + '/api/site/plus', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + cfg.bridgeToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, until })
      }).catch(() => null);
      if (sync === null) {
        game = { ok: false, reason: 'unreachable' };
        break;
      }
      if (sync.status === 404) continue;
      if (!sync.ok) {
        game = { ok: false, reason: 'status ' + sync.status };
        break;
      }
      game = { ok: true, username };
      break;
    }
  }
  return { ok: true, until, game };
}

/** Le pseudo de connexion du site, dérivé de `pseudo@players.recblue.invalid`. */
export function pseudoFromEmail(email) {
  const text = String(email || '').trim().toLowerCase();
  const at = text.indexOf('@');
  return at > 0 ? text.slice(0, at) : '';
}

/**
 * Le solde de crédits du JEU pour le joueur connecté sur le site — le nombre que le jeu
 * affiche, pas une copie. Le site s'en sert pour montrer exactement le même total.
 * `credits: null` veut dire « pas de compte de jeu » (ou jeu injoignable) : la page
 * retombe alors sur la valeur enregistrée.
 */
export async function handleGameCredits(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });

  const cfg = gameSettings(env);
  const user = await currentUser(request, cfg);
  if (!user) return json(401, { error: 'Connectez-vous d’abord sur le site.' });

  if (cfg.bridgeToken === '') return json(200, { credits: null, username: null });

  const names = await gameUsernames(cfg, user.id, pseudoFromEmail(user.email));
  for (const username of names) {
    const response = await fetch(
      cfg.econHost + '/api/site/balance?username=' + encodeURIComponent(username),
      { headers: { Authorization: 'Bearer ' + cfg.bridgeToken }, cache: 'no-store' }
    ).catch(() => null);
    if (response === null) return json(200, { credits: null, username: null });
    if (!response.ok) continue;
    const data = await response.json().catch(() => null);
    const credits = data && typeof data.balance === 'number' ? data.balance : null;
    return json(200, {
      credits,
      username,
      accountId: data && data.accountId ? data.accountId : null
    });
  }
  return json(200, { credits: null, username: names[0] || null });
}

/**
 * Un don de crédits fait par un administrateur depuis le site doit arriver AUSSI dans le
 * jeu, sinon les deux soldes divergent. Même pont que les achats (crédit + box), réservé
 * aux administrateurs — le rôle est relu en base, jamais cru sur parole du navigateur.
 */
export async function handleGameGrant(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });

  const cfg = gameSettings(env);
  const user = await currentUser(request, cfg);
  if (!user) return json(401, { error: 'Connectez-vous d’abord sur le site.' });
  if (!cfg.serviceKey) return json(503, { error: 'Service de comptes incomplet.' });

  const lookup = await fetch(
    cfg.supabaseUrl +
      '/rest/v1/recblue_accounts?select=role&id=eq.' +
      encodeURIComponent(String(user.id)),
    { headers: { apikey: cfg.serviceKey, Authorization: 'Bearer ' + cfg.serviceKey } }
  )
    .then(response => response.json())
    .catch(() => null);
  const role = Array.isArray(lookup) && lookup[0] ? String(lookup[0].role || '') : '';
  if (role !== 'admin') return json(403, { error: 'Réservé aux administrateurs.' });

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const tokens = Number(body.tokens || 0);
  // Pas de plafond metier : seule la borne technique du nombre entier sur est gardee,
  // pour ne pas deborder la colonne de credits de la base.
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 1000000000) {
    return json(400, { error: 'Nombre de crédits invalide (1 à 1 000 000 000).' });
  }
  // La cible est un pseudo de jeu, ou une adresse (on essaie alors les deux formes).
  const raw = String(body.target || '').trim().toLowerCase();
  const candidates = raw.includes('@') ? [pseudoFromEmail(raw), raw] : [raw];
  const names = candidates.filter(name => PSEUDO.test(name));
  if (names.length === 0) return json(400, { error: 'Indiquez un pseudo de jeu valide.' });

  for (const username of names) {
    const response = await fetch(cfg.econHost + '/api/site/grant', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.bridgeToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username,
        tokens,
        message: 'Crédits offerts par l’administration REC BLUE (' + tokens + ' crédits).'
      })
    }).catch(() => null);

    if (response === null) return json(502, { error: 'Le serveur de jeu est injoignable.' });
    if (response.status === 404) continue;
    if (!response.ok) return json(502, { error: 'Le serveur de jeu a refusé (' + response.status + ').' });

    const data = await response.json().catch(() => null);
    return json(200, {
      ok: true,
      username,
      credits: data && typeof data.balance === 'number' ? data.balance : null,
      giftId: data && data.giftId ? data.giftId : null
    });
  }
  return json(404, { error: 'Aucun compte de jeu ne correspond à « ' + raw + ' ».' });
}

/**
 * Message général dans le jeu : un administrateur du site écrit un texte, le serveur de
 * jeu l'envoie depuis le compte système « Coach » à tous les joueurs CONNECTÉS. Le rôle
 * admin est relu en base ici, et le pont econ présente SITE_BRIDGE_TOKEN — jamais le
 * navigateur, qui ne voit que son propre jeton Supabase.
 */
export async function handleGameAnnounce(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });

  const cfg = gameSettings(env);
  const verdict = await adminVerdict(request, cfg);
  if (verdict.error) return verdict.error;
  if (!cfg.bridgeToken) return json(503, { error: 'Le pont vers le jeu n’est pas configuré.' });

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const text = String(body.message || '').trim();
  if (text === '' || text.length > 500) {
    return json(400, { error: 'Message vide ou trop long (500 caractères maximum).' });
  }

  const response = await fetch(cfg.econHost + '/api/site/coach-message', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.bridgeToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageContent: text })
  }).catch(() => null);
  if (response === null) return json(502, { error: 'Le serveur de jeu est injoignable.' });
  if (!response.ok) return json(502, { error: 'Le serveur de jeu a refusé (' + response.status + ').' });

  const data = await response.json().catch(() => null);
  return json(200, { ok: true, sent: Number(data && data.sent) || 0 });
}

/** Le rôle du compte de site connecté, ou '' — et 401 si personne n'est connecté. */
async function adminVerdict(request, cfg) {
  const user = await currentUser(request, cfg);
  if (!user) return { error: json(401, { error: 'Connectez-vous d’abord sur le site.' }) };
  if (!cfg.serviceKey) return { error: json(503, { error: 'Service de comptes incomplet.' }) };
  const lookup = await fetch(
    cfg.supabaseUrl +
      '/rest/v1/recblue_accounts?select=role&id=eq.' +
      encodeURIComponent(String(user.id)),
    { headers: { apikey: cfg.serviceKey, Authorization: 'Bearer ' + cfg.serviceKey } }
  )
    .then(response => response.json())
    .catch(() => null);
  const role = Array.isArray(lookup) && lookup[0] ? String(lookup[0].role || '') : '';
  if (role !== 'admin') return { error: json(403, { error: 'Réservé aux administrateurs.' }) };
  return { user };
}

/**
 * Les candidats de compte de JEU pour une cible d'administration : le pseudo, l'adresse du
 * site, et le NOM AFFICHÉ. Ce dernier est le cas qui cassait tout : les pages d'admin
 * envoient tantôt le pseudo, tantôt le nom affiché (« NimbleTiger221 » pour le compte
 * « nathanbot »), et le jeu ne connaît que le pseudo — d'où des 404 « Aucun compte de jeu
 * ne correspond » alors que le rôle du site avait bien changé. La liste des comptes vient
 * du jeu lui-même, exactement comme la page « Joueurs ».
 */
async function resolveGameTargets(cfg, value) {
  const text = String(value || '').trim().toLowerCase();
  const names = [];
  const push = candidate => {
    const name = String(candidate || '').trim().toLowerCase();
    if (name !== '' && PSEUDO.test(name) && !names.includes(name)) names.push(name);
  };
  if (text.includes('@')) push(pseudoFromEmail(text));
  push(text);
  if (cfg.bridgeToken !== '') {
    try {
      const response = await fetch(cfg.econHost + '/api/site/players', {
        headers: { Authorization: 'Bearer ' + cfg.bridgeToken }
      });
      const data = response.ok ? await response.json().catch(() => null) : null;
      for (const player of data && Array.isArray(data.players) ? data.players : []) {
        const username = String(player.username || '').trim().toLowerCase();
        const display = String(player.displayName || '').trim().toLowerCase();
        if (username !== '' && (username === text || display === text)) push(username);
      }
    } catch {
      /* le jeu tranchera : on garde les candidats déjà connus */
    }
  }
  return { raw: text, names };
}

/** Applique un rôle au compte de JEU (pseudo ou nom affiché) et dit ce qui s'est passé. */
async function pushGameRole(cfg, target, role) {
  const { raw, names } = await resolveGameTargets(cfg, target);
  for (const username of names) {
    const response = await fetch(cfg.econHost + '/api/site/role', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.bridgeToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, role })
    }).catch(() => null);
    if (response === null) return { ok: false, error: 'Le serveur de jeu est injoignable.' };
    if (response.status === 404) continue;
    if (!response.ok) return { ok: false, error: 'Le serveur de jeu a refusé (' + response.status + ').' };
    const data = await response.json().catch(() => null);
    return {
      ok: true,
      username,
      isModerator: Boolean(data && data.isModerator),
      isDeveloper: Boolean(data && data.isDeveloper)
    };
  }
  return { ok: false, error: 'Aucun compte de jeu ne correspond à « ' + raw + ' ».' };
}

/** Les pseudos candidats d'une cible (« pseudo » ou « adresse email »). */
function targetsOf(value) {
  const raw = String(value || '').trim().toLowerCase();
  const names = (raw.includes('@') ? [pseudoFromEmail(raw), raw] : [raw]).filter(name =>
    PSEUDO.test(name)
  );
  return { raw, names };
}

/**
 * REC BLUE Plus, posé sur le compte de JEU avec sa date de fin — c'est cette date que la
 * page d'abonnement du jeu affiche. `until` à null retire le Plus.
 */
export async function handleGamePlus(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const verdict = await adminVerdict(request, cfg);
  if (verdict.error) return verdict.error;

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const { raw, names } = await resolveGameTargets(cfg, body.target);
  if (names.length === 0) return json(400, { error: 'Indiquez un pseudo de jeu valide.' });
  const until = body.until === undefined || body.until === null ? null : String(body.until);
  if (until !== null && Number.isNaN(Date.parse(until))) {
    return json(400, { error: 'Date de fin du Plus invalide.' });
  }

  for (const username of names) {
    const response = await fetch(cfg.econHost + '/api/site/plus', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.bridgeToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, until })
    }).catch(() => null);

    if (response === null) return json(502, { error: 'Le serveur de jeu est injoignable.' });
    if (response.status === 404) continue;
    if (!response.ok) return json(502, { error: 'Le serveur de jeu a refusé (' + response.status + ').' });
    return json(200, { ok: true, username, hasPlus: until !== null, until });
  }
  return json(404, { error: 'Aucun compte de jeu ne correspond à « ' + raw + ' ».' });
}

/**
 * Les rôles d'équipe du site appliqués au compte de JEU : un modérateur du site devient
 * modérateur en jeu (outil de communication d'équipe), un administrateur devient staff.
 * Réservé aux administrateurs du site — le rôle est relu en base, jamais cru sur parole
 * du navigateur. `target` est un pseudo de jeu (ou l'adresse qui le donne).
 */
/**
 * La fiche du site qui correspond à un pseudo de jeu : elle est reliée par l'adresse de
 * connexion (`nathanbot@…`), pas par le nom affiché, qui diffère volontairement.
 */
async function siteAccountIdForPseudo(cfg, username) {
  if (!cfg.serviceKey) return null;
  const needle = String(username || '').trim().toLowerCase();
  if (needle === '') return null;
  const response = await fetch(cfg.supabaseUrl + '/auth/v1/admin/users?per_page=200', {
    headers: { apikey: cfg.serviceKey, Authorization: 'Bearer ' + cfg.serviceKey }
  }).catch(() => null);
  if (response === null || !response.ok) return null;
  const data = await response.json().catch(() => null);
  const users = data && Array.isArray(data.users) ? data.users : [];
  const match = users.find(user => pseudoFromEmail(user.email) === needle);
  return match ? String(match.id) : null;
}

/**
 * Réciproque de `handleGameSiteRole` : quand le rôle est changé depuis la liste des comptes de
 * JEU, la fiche du site suit. Sans ça, un rôle retiré côté jeu restait « Modérateur » sur Mon
 * compte — l'administrateur voyait deux endroits se contredire.
 */
async function syncSiteRoleFromGame(cfg, username, role) {
  if (!cfg.serviceKey) return { ok: false, error: 'Service de comptes incomplet.' };
  const id = await siteAccountIdForPseudo(cfg, username);
  if (id === null) return { ok: true, skipped: 'aucune fiche du site pour ce joueur' };
  const response = await fetch(
    cfg.supabaseUrl + '/rest/v1/recblue_accounts?id=eq.' + encodeURIComponent(id),
    {
      method: 'PATCH',
      headers: {
        apikey: cfg.serviceKey,
        Authorization: 'Bearer ' + cfg.serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ role })
    }
  ).catch(() => null);
  if (response === null) return { ok: false, error: 'Service de comptes injoignable.' };
  if (!response.ok) {
    return { ok: false, error: 'La fiche du site a refusé « ' + role + ' » (' + response.status + ').' };
  }
  return { ok: true, id };
}

export async function handleGameRole(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const verdict = await adminVerdict(request, cfg);
  if (verdict.error) return verdict.error;

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const role = String(body.role || '').trim();
  if (role !== 'member' && role !== 'moderator' && role !== 'admin') {
    return json(400, { error: 'Rôle invalide (member, moderator ou admin).' });
  }
  const { raw, names } = await resolveGameTargets(cfg, body.target);
  if (names.length === 0) return json(400, { error: 'Indiquez un pseudo de jeu valide.' });

  for (const username of names) {
    const response = await fetch(cfg.econHost + '/api/site/role', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.bridgeToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, role })
    }).catch(() => null);

    if (response === null) return json(502, { error: 'Le serveur de jeu est injoignable.' });
    if (response.status === 404) continue;
    if (!response.ok) return json(502, { error: 'Le serveur de jeu a refusé (' + response.status + ').' });

    const data = await response.json().catch(() => null);
    // Le rôle de jeu change : la fiche du site suit, sinon les deux écrans se contredisent.
    const site = await syncSiteRoleFromGame(cfg, username, role);
    return json(200, {
      ok: true,
      username,
      role,
      isModerator: Boolean(data && data.isModerator),
      isDeveloper: Boolean(data && data.isDeveloper),
      site
    });
  }
  return json(404, { error: 'Aucun compte de jeu ne correspond à « ' + raw + ' ».' });
}

/**
 * Le badge « Certifié REC BLUE », accordé ou retiré par un administrateur du site. Il est
 * rangé sur le compte de JEU (`isCertified`) : une seule vérité pour le site et le jeu.
 */
export async function handleGameCertify(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const verdict = await adminVerdict(request, cfg);
  if (verdict.error) return verdict.error;

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const certified = body.certified !== false;
  const { raw, names } = await resolveGameTargets(cfg, body.target);
  if (names.length === 0) return json(400, { error: 'Indiquez un pseudo de jeu valide.' });

  for (const username of names) {
    const response = await fetch(cfg.econHost + '/api/site/certify', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.bridgeToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, certified })
    }).catch(() => null);

    if (response === null) return json(502, { error: 'Le serveur de jeu est injoignable.' });
    if (response.status === 404) continue;
    if (!response.ok) return json(502, { error: 'Le serveur de jeu a refusé (' + response.status + ').' });
    return json(200, { ok: true, username, certified });
  }
  return json(404, { error: 'Aucun compte de jeu ne correspond à « ' + raw + ' ».' });
}

/**
 * La PHOTO DE PROFIL DU JEU du joueur connecté au site : le site affiche l'image du jeu
 * (clé servie par le service d'images) au lieu d'une copie qui divergent.
 */
export async function handleGameAvatar(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const user = await currentUser(request, cfg);
  if (!user) return json(401, { error: 'Connectez-vous d’abord sur le site.' });

  const names = await gameUsernames(cfg, user.id, pseudoFromEmail(user.email));
  for (const username of names) {
    const response = await fetch(
      cfg.econHost + '/api/site/profile-image?username=' + encodeURIComponent(username),
      { headers: { Authorization: 'Bearer ' + cfg.bridgeToken } }
    ).catch(() => null);
    if (response === null) return json(502, { error: 'Le serveur de jeu est injoignable.' });
    if (!response.ok) continue;
    const data = await response.json().catch(() => null);
    if (data === null) continue;
    const image = String(data.profileImage || '').trim();
    const banner = String(data.bannerImage || '').trim();
    // La vignette par défaut du jeu n'est PAS une photo du joueur : elle ne doit pas
    // remplacer la photo qu'il a mise sur le site. Seule une vraie image compte.
    const real = image !== '' && !/^DefaultProfileImage\./i.test(image);
    return json(200, {
      username,
      image: real ? cfg.imagesHost + '/' + image.replace(/^\/+/, '') : null,
      banner: banner === '' ? null : cfg.imagesHost + '/' + banner.replace(/^\/+/, '')
    });
  }
  return json(200, { image: null, banner: null });
}

/**
 * Les comptes du JEU (et qui est en ligne), pour la page d'administration « Joueurs » :
 * réservé aux administrateurs du site, comme les autres actions d'équipe.
 */
/**
 * Le rôle du SITE écrit directement dans Supabase, avec la clé de service, sur
 * l'identifiant du compte — c'est ce que le navigateur ne sait pas faire de façon fiable.
 * Les RPC SQL dépendaient d'une base à jour (valeur « moderator » acceptée par la
 * contrainte ET par la fonction) : une base en retard refusait chaque changement de rôle,
 * d'où des droits qui « ne marchaient pas » sur le site. Le rôle de jeu suit dans le même
 * appel, pour que le site et le jeu ne divergent jamais.
 */
export async function handleGameSiteRole(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const verdict = await adminVerdict(request, cfg);
  if (verdict.error) return verdict.error;
  if (!cfg.serviceKey) return json(503, { error: 'Service de comptes incomplet.' });

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const role = String(body.role || '').trim();
  if (role !== 'member' && role !== 'moderator' && role !== 'admin') {
    return json(400, { error: 'Rôle invalide (member, moderator ou admin).' });
  }
  const id = String(body.id || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return json(400, { error: 'Compte du site invalide.' });
  }

  const response = await fetch(
    cfg.supabaseUrl + '/rest/v1/recblue_accounts?id=eq.' + encodeURIComponent(id),
    {
      method: 'PATCH',
      headers: {
        apikey: cfg.serviceKey,
        Authorization: 'Bearer ' + cfg.serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify({ role })
    }
  ).catch(() => null);
  // Les DEUX écritures sont toujours tentées : une fiche du site qui refuse la valeur ne
  // doit plus empêcher le rôle du jeu de suivre. Avant, l'abandon silencieux laissait un
  // rôle « retiré » toujours actif en jeu, sans que rien ne le signale.
  let site;
  if (response === null) {
    site = { ok: false, error: 'Service de comptes injoignable.' };
  } else {
    const saved = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = saved && !Array.isArray(saved) ? saved.message || saved.details || saved.hint : '';
      site = {
        ok: false,
        error:
          'La fiche du site a refusé « ' +
          role +
          ' »' +
          (detail ? ' (' + detail + ')' : '') +
          '. Exécutez supabase-roles-fix.sql dans Supabase.'
      };
    } else if (Array.isArray(saved) && saved.length === 0) {
      site = { ok: false, error: 'Compte du site introuvable.' };
    } else {
      site = { ok: true, role };
    }
  }

  const target = String(body.target || body.username || '').trim();
  const game =
    target === ''
      ? { ok: false, error: 'Aucun pseudo de jeu à mettre à jour.' }
      : await pushGameRole(cfg, target, role);
  return json(site.ok ? 200 : 502, { ok: site.ok, role, site, game });
}

/**
 * REC BLUE Plus côté SITE : la date de fin est écrite dans Supabase avec la clé de service,
 * puis poussée sur le compte de JEU. La cible est un pseudo, un nom affiché ou une adresse.
 */
export async function handleGameSitePlus(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const verdict = await adminVerdict(request, cfg);
  if (verdict.error) return verdict.error;
  if (!cfg.serviceKey) return json(503, { error: 'Service de comptes incomplet.' });

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const raw = String(body.target || '').trim();
  if (raw === '') return json(400, { error: 'Indiquez un pseudo de jeu valide.' });
  const until = body.until === undefined || body.until === null ? null : String(body.until);
  if (until !== null && Number.isNaN(Date.parse(until))) {
    return json(400, { error: 'Date de fin du REC BLUE Plus invalide.' });
  }
  const needle = raw.replace(/^@/, '').toLowerCase();

  const lookup = await fetch(
    cfg.supabaseUrl +
      '/rest/v1/recblue_accounts?select=id,display_name&display_name=ilike.' +
      encodeURIComponent(needle),
    { headers: { apikey: cfg.serviceKey, Authorization: 'Bearer ' + cfg.serviceKey } }
  )
    .then(result => (result.ok ? result.json() : null))
    .catch(() => null);
  const rows = Array.isArray(lookup) ? lookup : [];
  if (rows.length === 0) {
    return json(404, { error: 'Aucun compte du site ne correspond à « ' + raw + ' ».' });
  }

  const target = String(rows[0].id);
  const response = await fetch(
    cfg.supabaseUrl + '/rest/v1/recblue_accounts?id=eq.' + encodeURIComponent(target),
    {
      method: 'PATCH',
      headers: {
        apikey: cfg.serviceKey,
        Authorization: 'Bearer ' + cfg.serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify({ plus_until: until })
    }
  ).catch(() => null);
  if (response === null) return json(502, { error: 'Service de comptes injoignable.' });
  const saved = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = saved && (saved.message || saved.details || saved.hint);
    return json(502, {
      error:
        'Le REC BLUE Plus n’a pas pu être enregistré' +
        (detail ? ' (' + detail + ')' : '') +
        '. Exécutez supabase-roles-fix.sql pour ajouter la colonne plus_until.'
    });
  }

  let game = null;
  const { names } = await resolveGameTargets(cfg, raw);
  for (const username of names) {
    const sync = await fetch(cfg.econHost + '/api/site/plus', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.bridgeToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, until })
    }).catch(() => null);
    if (sync === null) {
      game = { ok: false, error: 'Le serveur de jeu est injoignable.' };
      break;
    }
    if (sync.status === 404) continue;
    if (!sync.ok) {
      game = { ok: false, error: 'Le serveur de jeu a refusé (' + sync.status + ').' };
      break;
    }
    game = { ok: true, username };
    break;
  }
  return json(200, { ok: true, until, game: game || { ok: false, error: 'Aucun compte de jeu trouvé.' } });
}

export async function handleGamePlayers(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const verdict = await adminVerdict(request, cfg);
  if (verdict.error) return verdict.error;

  const response = await fetch(cfg.econHost + '/api/site/players', {
    headers: { Authorization: 'Bearer ' + cfg.bridgeToken }
  }).catch(() => null);
  if (response === null) return json(502, { error: 'Le serveur de jeu est injoignable.' });
  if (!response.ok) return json(502, { error: 'Le serveur de jeu a refusé (' + response.status + ').' });
  const data = await response.json().catch(() => null);
  const players = data && Array.isArray(data.players) ? data.players : [];
  return json(200, { players, count: players.length });
}

/**
 * L'ANNUAIRE PUBLIC de la communauté. Il ne reprend que les comptes qui existent à
 * la fois sur le site (une fiche `recblue_accounts`) et dans le jeu. Le jeu fournit
 * le profil réel — pseudo, nom affiché, avatar, niveau, XP, date de création et
 * likes ; la fiche du site fournit le rôle. Un compte de jeu sans fiche, une fiche
 * sans compte de jeu, ou un compte banni ne sont jamais publiés.
 *
 * Seules les informations publiques sortent : pseudo, nom affiché, rôle, avatar,
 * niveau/XP, date et likes. Les emails, identifiants de compte, crédits et
 * bannissements ne sortent jamais de ce Worker. Le jeton du pont reste côté serveur.
 */
export async function handleCommunityPlayers(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  if (!cfg.serviceKey || !cfg.bridgeToken) {
    return json(503, { error: 'L’annuaire est momentanément indisponible.' });
  }

  const result = await communityDirectory(cfg);
  if (result.error) return json(result.error, { error: result.message });
  const players = result.players.map(communityPublicPlayer);

  return new Response(JSON.stringify({ players, count: players.length }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Le rôle ou l'avatar peut changer : une minute de cache suffit largement.
      'Cache-Control': 'public, max-age=30, s-maxage=60'
    }
  });
}

/**
 * Les profils qui existent À LA FOIS sur le site et dans le jeu. C'est l'intersection,
 * jamais l'union : un compte de jeu sans fiche REC BLUE est un joueur de passage, et
 * une fiche du site sans compte de jeu n'a ni niveau ni date réels à montrer.
 *
 * Le jeu fournit le nom affiché, le pseudo, l'avatar, le niveau, l'XP, la date de
 * création et les likes reçus. La fiche du site fournit le rôle communautaire.
 */
async function communityDirectory(cfg) {
  const [siteProfiles, gameResponse] = await Promise.all([
    communitySiteProfiles(cfg),
    fetch(cfg.econHost + '/api/site/players', {
      headers: { Authorization: 'Bearer ' + cfg.bridgeToken }
    }).catch(() => null)
  ]);

  if (siteProfiles === null) {
    return { error: 503, message: 'L’annuaire est momentanément indisponible.' };
  }
  if (gameResponse === null) {
    return { error: 502, message: 'Le serveur de jeu est injoignable.' };
  }
  if (!gameResponse.ok) {
    return { error: 502, message: 'Le serveur de jeu a refusé (' + gameResponse.status + ').' };
  }

  const data = await gameResponse.json().catch(() => null);
  const rawPlayers = data && Array.isArray(data.players) ? data.players : [];
  const profilesByKey = new Map();
  for (const profile of siteProfiles) {
    const key = String(profile.display_name || '').trim().toLowerCase();
    if (key !== '' && !profilesByKey.has(key)) profilesByKey.set(key, profile);
  }

  const seenProfiles = new Set();
  const players = [];
  for (const game of rawPlayers) {
    if (!game || game.banned === true) continue;
    const username = String(game.username || '').trim();
    const gameDisplay = String(game.displayName || game.display_name || '').trim();
    const keys = [username, gameDisplay]
      .map(value => value.toLowerCase())
      .filter(value => value !== '');
    let profile = null;
    for (const key of keys) {
      if (profilesByKey.has(key)) {
        profile = profilesByKey.get(key);
        break;
      }
    }
    const profileId = String(profile?.id || '');
    if (profileId !== '') {
      if (seenProfiles.has(profileId)) continue;
      seenProfiles.add(profileId);
    }

    const profileName = profile ? String(profile.display_name || '').trim() : '';
    const displayName = gameDisplay || profileName || username;
    const finalUsername = username || displayName;
    if (finalUsername === '' || displayName === '') continue;

    const developer = game.isDeveloper === true || game.isDeveloper === 1;
    players.push({
      accountId: Number(game.accountId) || 0,
      username: finalUsername,
      displayName,
      role: developer ? 'owner' : communityRole(profile?.role) || communityRole(game.role) || 'member',
      level: Math.max(1, communityNumber(game.level ?? game.progression?.level)),
      xp: communityNumber(game.xp ?? game.progression?.xp),
      joinedAt:
        communityDate(game.createdAt ?? game.created_at) ||
        communityDate(profile?.created_at),
      avatarUrl:
        communityGameAvatar(cfg, game.profileImage) || communityAvatar(profile?.avatar_url),
      likes: communityNumber(game.likes ?? game.cheers ?? game.reputation?.likes),
      plus: game.plus === true || game.plus === 1,
      certified: game.certified === true || game.certified === 1
    });
  }

  players.sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr', { sensitivity: 'base' }));
  return { players };
}

/** Un avatar du jeu est une clé servie par le service d'images, pas une URL arbitraire. */
function communityGameAvatar(cfg, value) {
  const image = String(value || '').trim();
  if (image === '' || /^DefaultProfileImage\./i.test(image)) return null;
  if (/^https:\/\//i.test(image)) return image;
  if (/^http:\/\//i.test(image)) return null;
  const host = String(cfg.imagesHost || '').replace(/\/+$/, '');
  return host === '' ? null : host + '/' + image.replace(/^\/+/, '');
}

/** Le champ interne `accountId` ne sort jamais dans l'annuaire public. */
function communityPublicPlayer(player) {
  const { accountId, ...publicPlayer } = player;
  return publicPlayer;
}

/**
 * Like d'un profil depuis le site. Le like est écrit côté JEU comme un cheer général :
 * il rejoint donc les vrais compteurs de réputation du joueur. Un compte du site ne
 * peut aimer le même joueur qu'une fois.
 */
export async function handleCommunityLike(request, env) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json(405, { error: 'Méthode non autorisée.' });
  }
  const cfg = gameSettings(env);
  if (!cfg.serviceKey || !cfg.bridgeToken) {
    return json(503, { error: 'Les likes sont momentanément indisponibles.' });
  }

  const user = await currentUser(request, cfg);
  if (!user) return json(401, { error: 'Connectez-vous d’abord sur le site.' });

  let target = '';
  if (request.method === 'GET') {
    target = String(new URL(request.url).searchParams.get('target') || '').trim();
  } else {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    target = String(body.target || '').trim();
  }
  if (target === '') return json(400, { error: 'Profil manquant.' });

  const directory = await communityDirectory(cfg);
  if (directory.error) return json(directory.error, { error: directory.message });
  const needle = target.toLowerCase();
  const player =
    directory.players.find(item => item.username.toLowerCase() === needle) ||
    directory.players.find(item => item.displayName.toLowerCase() === needle);
  if (!player) {
    return json(404, { error: 'Ce profil ne fait pas partie de l’annuaire REC BLUE.' });
  }

  // Le likeur doit avoir un compte de jeu : un compte du site seul ne peut pas noter
  // les joueurs du serveur. C'est la même règle que pour l'annuaire.
  const own = await resolveGameAccount(cfg, user);
  if (!own) {
    return json(403, { error: 'Ton compte de jeu REC BLUE est requis pour aimer un profil.' });
  }
  const ownNames = [own.username, own.displayName]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(value => value !== '');
  if (request.method === 'POST' && ownNames.includes(player.username.toLowerCase())) {
    return json(400, { error: 'Tu ne peux pas aimer ton propre profil.' });
  }

  const headers = {
    Authorization: 'Bearer ' + cfg.bridgeToken,
    'Content-Type': 'application/json'
  };
  let response;
  if (request.method === 'GET') {
    response = await fetch(
      cfg.econHost +
        '/api/site/player-like?liker=' +
        encodeURIComponent(String(user.id)) +
        '&target=' +
        encodeURIComponent(player.username),
      { headers: { Authorization: headers.Authorization } }
    ).catch(() => null);
  } else {
    response = await fetch(cfg.econHost + '/api/site/player-like', {
      method: 'POST',
      headers,
      body: JSON.stringify({ liker: String(user.id), target: player.username })
    }).catch(() => null);
  }
  if (response === null) return json(502, { error: 'Le serveur de jeu est injoignable.' });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 404) {
      return json(404, { error: 'Ce profil n’existe plus dans le jeu.' });
    }
    return json(502, { error: 'Le serveur de jeu a refusé (' + response.status + ').' });
  }

  const likes = Number(data && data.likes);
  const payload = {
    liked: request.method === 'GET' ? data && data.liked === true : true,
    likes: Number.isFinite(likes) && likes >= 0 ? Math.floor(likes) : player.likes
  };
  if (request.method === 'POST') payload.isNew = !!(data && data.newLike === true);
  return json(200, payload);
}

/**
 * Les fiches du site servent à vérifier l'appartenance à REC BLUE et à porter le
 * rôle communautaire. Sans elles, aucun profil n'est publié (retour null -> 503).
 */
async function communitySiteProfiles(cfg) {
  if (!cfg.serviceKey) return null;
  try {
    const response = await fetch(
      cfg.supabaseUrl +
        '/rest/v1/recblue_accounts?select=id,display_name,role,avatar_url,created_at&limit=2000',
      { headers: { apikey: cfg.serviceKey, Authorization: 'Bearer ' + cfg.serviceKey } }
    );
    if (!response.ok) return null;
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) return null;
    return rows.filter(row => row && String(row.display_name || '').trim() !== '');
  } catch {
    return null;
  }
}

function communityRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'owner') return 'owner';
  if (role === 'admin' || role === 'developer') return 'admin';
  if (role === 'moderator' || role === 'mod') return 'moderator';
  if (role === 'staff') return 'staff';
  if (role === 'member') return 'member';
  return null;
}

function communityNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function communityDate(value) {
  if (!value) return null;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function communityAvatar(value) {
  const text = String(value || '').trim();
  if (text === '') return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Le compte de JEU du joueur connecté, retrouvé dans la liste que le jeu publie.
 *
 * Le nom affiché du site n'est pas le pseudo du jeu (« NimbleTiger221 » contre
 * « nathanbot »), et un compte peut avoir été créé en jeu avant le site. On compare donc
 * toutes les paires possibles — pseudo de connexion, nom affiché du site, et les deux
 * champs du compte de jeu — au lieu de s'en remettre à un seul d'entre eux, ce qui faisait
 * afficher « membre » et aucun badge à un joueur pourtant modérateur et Plus dans le jeu.
 */
async function resolveGameAccount(cfg, user) {
  const login = pseudoFromEmail(user.email);
  const wanted = [];
  const push = name => {
    const text = String(name || '').trim().toLowerCase();
    if (text !== '' && !wanted.includes(text)) wanted.push(text);
  };
  if (cfg.serviceKey) {
    try {
      const lookup = await fetch(
        cfg.supabaseUrl +
          '/rest/v1/recblue_accounts?select=display_name&id=eq.' +
          encodeURIComponent(String(user.id)),
        { headers: { apikey: cfg.serviceKey, Authorization: 'Bearer ' + cfg.serviceKey } }
      );
      const data = lookup.ok ? await lookup.json().catch(() => null) : null;
      if (Array.isArray(data) && data[0]) push(data[0].display_name);
    } catch {
      /* pas de fiche lisible : les autres pistes suffisent */
    }
  }
  push(login);

  let players = [];
  try {
    const response = await fetch(cfg.econHost + '/api/site/players', {
      headers: { Authorization: 'Bearer ' + cfg.bridgeToken }
    });
    const data = response.ok ? await response.json().catch(() => null) : null;
    players = data && Array.isArray(data.players) ? data.players : [];
  } catch {
    players = [];
  }
  const match = players.find(player => {
    const username = String(player.username || '').trim().toLowerCase();
    const display = String(player.displayName || '').trim().toLowerCase();
    return wanted.includes(username) || wanted.includes(display);
  });
  if (match) return match;

  // Repli : le jeu répond directement pour chaque pseudo candidat.
  for (const username of await gameUsernames(cfg, user.id, login)) {
    const response = await fetch(
      cfg.econHost + '/api/site/certified?username=' + encodeURIComponent(username),
      { headers: { Authorization: 'Bearer ' + cfg.bridgeToken } }
    ).catch(() => null);
    if (response === null || !response.ok) continue;
    const data = await response.json().catch(() => null);
    if (data && typeof data.certified === 'boolean') {
      return {
        username,
        certified: data.certified,
        plus: data.plus === true,
        plusUntil: data.plusUntil ?? null,
        role: null
      };
    }
  }
  return null;
}

/**
 * Inspection et nettoyage des fiches du site, réservés au serveur (jeton partagé).
 *
 * Deux fiches peuvent porter le même pseudo de connexion : celle créée à l'inscription et
 * celle créée avec le compte de jeu. Un administrateur qui modifie l'une ne voit rien
 * changer sur l'autre, d'où un rôle « retiré » qui semble revenir. GET liste les fiches,
 * POST en supprime une par son nom affiché — la ligne de profil seulement, jamais le
 * compte de jeu.
 */
export async function handleSiteAccountAdmin(request, env) {
  const cfg = gameSettings(env);
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!cfg.bridgeToken || given !== cfg.bridgeToken) return json(401, { error: 'unauthorized' });
  if (!cfg.serviceKey) return json(503, { error: 'Service de comptes incomplet.' });
  const headers = { apikey: cfg.serviceKey, Authorization: 'Bearer ' + cfg.serviceKey };

  if (request.method === 'GET') {
    const rows = await fetch(
      cfg.supabaseUrl +
        '/rest/v1/recblue_accounts?select=id,display_name,role,plus_until,created_at&order=created_at.asc',
      { headers }
    )
      .then(response => (response.ok ? response.json() : null))
      .catch(() => null);
    if (!Array.isArray(rows)) return json(502, { error: 'Service de comptes injoignable.' });
    // L'adresse de connexion ne vit que dans auth.users : on la joint ici, à l'abri du
    // navigateur, pour relier une fiche à son email réel quand l'inscription est douteuse.
    const users = await fetch(cfg.supabaseUrl + '/auth/v1/admin/users?page=1&per_page=200', {
      headers
    })
      .then(response => (response.ok ? response.json() : null))
      .catch(() => null);
    const byId = new Map();
    for (const user of users && Array.isArray(users.users) ? users.users : []) {
      byId.set(String(user.id), {
        email: String(user.email || ''),
        email_confirmed: !!user.email_confirmed_at
      });
    }
    return json(200, {
      accounts: rows.map(row => ({ ...row, ...(byId.get(String(row.id)) || {}) }))
    });
  }
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  // Réinitialisation de secours : mot de passe posé par l'administration pour un compte
  // dont l'adresse email ne peut recevoir aucun lien (adresse saisie de travers).
  const targetId = String(body.id || '').trim();
  const newPassword = String(body.password || '');
  const newEmail = String(body.email || '').trim().toLowerCase();
  if (targetId !== '' && (newPassword !== '' || newEmail !== '')) {
    if (newPassword !== '' && newPassword.length < 12) {
      return json(400, { error: 'Mot de passe trop court (12 caractères minimum).' });
    }
    if (newEmail !== '' && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(newEmail)) {
      return json(400, { error: 'Adresse email invalide.' });
    }
    const changes = { email_confirm: true };
    if (newPassword !== '') changes.password = newPassword;
    if (newEmail !== '') changes.email = newEmail;
    const patched = await fetch(
      cfg.supabaseUrl + '/auth/v1/admin/users/' + encodeURIComponent(targetId),
      {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(changes)
      }
    ).catch(() => null);
    if (patched === null) return json(502, { error: 'Service de comptes injoignable.' });
    if (!patched.ok) return json(502, { error: 'Mot de passe refusé par la base (' + patched.status + ').' });
    const updated = await patched.json().catch(() => null);
    return json(200, {
      ok: true,
      id: targetId,
      email: updated && updated.email ? String(updated.email) : null
    });
  }

  const displayName = String(body.displayName || '').trim();
  if (displayName === '') return json(400, { error: 'Nom affiché manquant.' });
  const wantedRole = String(body.role || '').trim();

  const found = await fetch(
    cfg.supabaseUrl +
      '/rest/v1/recblue_accounts?select=id,display_name,role&display_name=eq.' +
      encodeURIComponent(displayName),
    { headers }
  )
    .then(response => (response.ok ? response.json() : null))
    .catch(() => null);
  if (!Array.isArray(found)) return json(502, { error: 'Service de comptes injoignable.' });
  if (found.length === 0) return json(404, { error: 'Aucune fiche ne porte ce nom affiché.' });
  if (found.length > 1) return json(409, { error: 'Plusieurs fiches portent ce nom affiché.' });

  const row = found[0];
  if (wantedRole !== '') {
    if (wantedRole !== 'member' && wantedRole !== 'moderator' && wantedRole !== 'admin') {
      return json(400, { error: 'Rôle invalide (member, moderator ou admin).' });
    }
    const patched = await fetch(
      cfg.supabaseUrl + '/rest/v1/recblue_accounts?id=eq.' + encodeURIComponent(String(row.id)),
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ role: wantedRole })
      }
    ).catch(() => null);
    if (patched === null) return json(502, { error: 'Service de comptes injoignable.' });
    if (!patched.ok) return json(502, { error: 'Rôle refusé par la base (' + patched.status + ').' });
    return json(200, { ok: true, updated: { id: row.id, display_name: row.display_name, role: wantedRole } });
  }
  const removed = await fetch(
    cfg.supabaseUrl + '/rest/v1/recblue_accounts?id=eq.' + encodeURIComponent(String(row.id)),
    { method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' } }
  ).catch(() => null);
  if (removed === null) return json(502, { error: 'Service de comptes injoignable.' });
  if (!removed.ok) return json(502, { error: 'Suppression refusée (' + removed.status + ').' });
  return json(200, { ok: true, deleted: row });
}

/** Le badge du joueur CONNECTÉ au site, lu sur son compte de jeu. */
export async function handleGameCertified(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const user = await currentUser(request, cfg);
  if (!user) return json(401, { error: 'Connectez-vous d’abord sur le site.' });

  const compte = await resolveGameAccount(cfg, user);
  if (compte === null) return json(200, { certified: false, plus: false, role: '' });

  // `plus` et `certified` viennent du compte de JEU : le site s'en sert pour l'or, le cadre
  // et la marque de certification. `role` évite qu'un modérateur du jeu s'affiche « Membre ».
  const roleJeu = compte.role === 'admin' ? 'admin' : compte.role === 'moderator' ? 'moderator' : '';
  return json(200, {
    certified: compte.certified === true,
    plus: compte.plus === true,
    plusUntil: compte.plusUntil ?? null,
    role: roleJeu,
    username: compte.username || null,
    displayName: compte.displayName || null
  });
}

/**
 * Bannit (ou débannit) un compte de JEU. Un banni n'obtient plus de jeton : il ne peut
 * plus se connecter. `days` absent ou vide = bannissement définitif.
 */
export async function handleGameBan(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const verdict = await adminVerdict(request, cfg);
  if (verdict.error) return verdict.error;

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const { raw, names } = await resolveGameTargets(cfg, body.target);
  if (names.length === 0) return json(400, { error: 'Indiquez un pseudo de jeu valide.' });

  const ban = body.ban !== false;
  const reason = String(body.reason || '').trim().slice(0, 200);
  const days = Number(body.days || 0);
  if (ban && body.days !== '' && !Number.isNaN(days) && days < 0) {
    return json(400, { error: 'Durée de bannissement invalide.' });
  }
  const until =
    ban && Number.isFinite(days) && days > 0
      ? new Date(Date.now() + days * 86400000).toISOString()
      : null;

  for (const username of names) {
    const response = await fetch(cfg.econHost + '/api/site/ban', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.bridgeToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, ban, reason, until })
    }).catch(() => null);

    if (response === null) return json(502, { error: 'Le serveur de jeu est injoignable.' });
    if (response.status === 404) continue;
    if (!response.ok) return json(502, { error: 'Le serveur de jeu a refusé (' + response.status + ').' });
    return json(200, { ok: true, username, banned: ban, reason, until });
  }
  return json(404, { error: 'Aucun compte de jeu ne correspond à « ' + raw + ' ».' });
}

/**
 * Les CHAMBRES du jeu, lues au serveur de jeu (worker `rooms`) : le site ne copie rien,
 * il affiche ce que le jeu publie. Une room publiée en jeu apparaît donc ici sans
 * intervention, et une room retirée disparaît de même — c'est la synchronisation.
 *
 * Sans recherche : `/rooms/hot`. Avec : `/rooms/search`. Les deux sont publics.
 */
export async function handleGameRooms(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const url = new URL(request.url);
  const query = String(url.searchParams.get('q') || '').trim().slice(0, 60);
  const take = Math.min(50, Math.max(1, Number(url.searchParams.get('take') || 24) || 24));
  // Le jeu ne sert pas de « toutes les rooms » d'un coup : le fil « hot » s'arrête à 24.
  // On interroge donc les trois sources publiques et on fusionne par identifiant — à
  // défaut de recherche, c'est ce qui donne TOUTES les chambres, joueurs comprises.
  const urls = query
    ? [cfg.roomsHost + '/rooms/search?query=' + encodeURIComponent(query) + '&take=' + take]
    : [
        cfg.roomsHost + '/rooms/hot?take=' + take,
        cfg.roomsHost + '/rooms/recommendations?take=' + take,
        cfg.roomsHost + '/rooms/search?query=' + encodeURIComponent('#community') + '&take=' + take
      ];

  // Les statistiques et présences sont indépendantes du flux des chambres : les lancer
  // en même temps évite deux allers-retours séquentiels sur la route.
  const statsRequest = fetch(cfg.econHost + '/api/site/room-stats', {
    headers: { Authorization: 'Bearer ' + cfg.bridgeToken }
  }).catch(() => null);
  const onlineRequest = fetch(cfg.econHost + '/api/site/room-online', {
    headers: { Authorization: 'Bearer ' + cfg.bridgeToken }
  }).catch(() => null);
  const [bodies, statsResponse, onlineResponse] = await Promise.all([
    Promise.all(
      urls.map(url =>
        fetch(url, { headers: { Accept: 'application/json' } })
          .then(response => (response.ok ? response.json() : null))
          .catch(() => null)
      )
    ),
    statsRequest,
    onlineRequest
  ]);
  if (bodies.every(body => body === null)) {
    return json(502, { error: 'Le serveur de jeu est injoignable.' });
  }

  const rows = [];
  const seen = new Set();
  for (const body of bodies) {
    const list = body && Array.isArray(body.Results) ? body.Results : Array.isArray(body) ? body : [];
    for (const room of list) {
      const id = Number(room && room.RoomId) || 0;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push(room);
    }
  }
  const rooms = rows
    .filter(room => room && room.Name)
    .map(room => ({
      id: Number(room.RoomId) || 0,
      name: String(room.Name),
      // La vignette de la chambre, servie par le service d'images du jeu : c'est la même
      // image que le client affiche, donc le site montre exactement la chambre publiée.
      image: room.ImageName ? String(room.ImageName) : '',
      description: String(room.Description || ''),
      creatorAccountId: Number(room.CreatorAccountId) || 0,
      visitors: Number(room.Stats && room.Stats.VisitorCount) || 0,
      cheers: Number(room.Stats && room.Stats.CheerCount) || 0,
      maxPlayers: Number(room.MaxPlayers) || 0,
      isOfficial: room.IsRRO === true || room.IsRecRoomApproved === true,
      // Rempli plus bas par les présences du serveur de jeu : 0 par défaut, jamais « inventé ».
      online: 0,
      publishedAt: room.PublishedAt || room.CreatedAt || null
    }));

  // Les compteurs réels (visites, favoris) sont des colonnes du serveur de jeu, pas des
  // champs de la chambre : le site les fusionne ici. Si ce service ne répond pas, on garde
  // les valeurs du flux plutôt que d'afficher des zéros inventés.
  if (statsResponse && statsResponse.ok) {
    const statsBody = await statsResponse.json().catch(() => null);
    const list = statsBody && Array.isArray(statsBody.stats) ? statsBody.stats : [];
    const byId = new Map(list.map(row => [Number(row.id), row]));
    for (const room of rooms) {
      const stats = byId.get(room.id);
      if (!stats) continue;
      room.visitors = Number(stats.visits) || 0;
      room.cheers = Number(stats.cheers) || 0;
      room.favorites = Number(stats.favorites) || 0;
    }
  }

  // Combien de joueurs sont RÉELLEMENT dans chaque chambre en ce moment (présences du
  // serveur de jeu). Une chambre absente de la réponse est vide : on garde 0.
  if (onlineResponse && onlineResponse.ok) {
    const onlineBody = await onlineResponse.json().catch(() => null);
    const list = onlineBody && Array.isArray(onlineBody.rooms) ? onlineBody.rooms : [];
    const byId = new Map(list.map(row => [Number(row.id), Number(row.players) || 0]));
    for (const room of rooms) room.online = byId.get(room.id) || 0;
  }

  return json(200, { rooms, query, take });
}

/**
 * RETIRE des crédits au compte de jeu d'un joueur, décision d'administration. L'inverse
 * du don : pas de box, pas de message, et le solde ne descend jamais sous 0.
 */
/**
 * Combien de joueurs sont connectés au jeu, lu sur les présences du serveur de jeu.
 * Public : un compteur n'apprend rien de privé, seulement le total.
 */
export async function handleGameOnline(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const response = await fetch(cfg.econHost + '/api/site/online', {
    headers: { Authorization: 'Bearer ' + cfg.bridgeToken }
  }).catch(() => null);
  if (response === null) return json(502, { error: 'Le serveur de jeu est injoignable.' });
  if (!response.ok) {
    return json(502, { error: 'Le serveur de jeu a refusé (' + response.status + ').' });
  }
  const data = await response.json().catch(() => null);
  return json(200, { online: Number(data && data.online) || 0 });
}

/**
 * État RÉEL des services du jeu, pour le panneau « Statut » du site.
 * econ répond => comptes/économie en ligne ; rooms répond => les chambres aussi.
 */
const PLATFORM_NAMES = {
  0: 'Steam',
  1: 'Quest',
  2: 'PlayStation',
  3: 'Xbox',
  4: 'RecNet',
  5: 'iOS',
  6: 'Google Play',
  7: 'Standalone',
  8: 'Pico'
};

function platformName(value) {
  if (value === null || value === undefined) return 'Inconnu';
  const number = Number(value);
  return PLATFORM_NAMES[number] || 'Plateforme ' + number;
}

/** Regroupe les lignes (build, platform, count) en une entrée par build. */
function groupVersions(rows) {
  const byBuild = new Map();
  for (const row of rows) {
    const build = String(row.build || '') || 'inconnue';
    const entry = byBuild.get(build) || { build, count: 0, devices: [] };
    const count = Number(row.count) || 0;
    entry.count += count;
    entry.devices.push({ name: platformName(row.platform), count });
    byBuild.set(build, entry);
  }
  const versions = [...byBuild.values()];
  for (const version of versions) version.devices.sort((a, b) => b.count - a.count);
  // Le plus fréquent d'abord ; à égalité, le build le plus récent.
  return versions.sort((a, b) => b.count - a.count || b.build.localeCompare(a.build));
}

export async function handleGameStatus(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const [econ, rooms] = await Promise.all([
    fetch(cfg.econHost + '/api/site/status', {
      headers: { Authorization: 'Bearer ' + cfg.bridgeToken }
    }).catch(() => null),
    fetch(cfg.roomsHost + '/rooms/hot?take=1').catch(() => null)
  ]);

  const stats = econ && econ.ok ? await econ.json().catch(() => null) : null;
  const online = stats ? Number(stats.online) : NaN;
  const hasStats = Number.isFinite(online);

  return json(200, {
    game: Boolean(econ && econ.ok),
    rooms: Boolean(rooms && rooms.ok),
    presence: hasStats,
    online: hasStats ? online : 0,
    // Détail du panneau « Statut » : agrégats seulement, rien de privé.
    devices: stats && Array.isArray(stats.platforms)
      ? stats.platforms.map(row => ({ name: platformName(row.platform), count: Number(row.count) || 0 }))
      : [],
    versions: stats && Array.isArray(stats.versions) ? groupVersions(stats.versions) : [],
    activeRooms: stats && Array.isArray(stats.rooms)
      ? stats.rooms.map(row => ({ name: String(row.name || ''), count: Number(row.count) || 0 }))
      : []
  });
}

/**
 * Les photos prises EN JEU, prêtes pour la galerie du site.
 * Seules les photos publiques prises dans une chambre sont montrées, et l'image est
 * servie par le CDN du jeu — le site ne recopie aucun fichier.
 */
export async function handleGamePhotos(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const asked = new URL(request.url).searchParams.get('take');
  const query = asked ? '?take=' + encodeURIComponent(asked) : '';
  const response = await fetch(cfg.econHost + '/api/site/photos' + query, {
    headers: { Authorization: 'Bearer ' + cfg.bridgeToken }
  }).catch(() => null);
  if (response === null) return json(502, { error: 'Le serveur de jeu est injoignable.' });
  if (!response.ok) {
    return json(502, { error: 'Le serveur de jeu a refusé (' + response.status + ').' });
  }
  const data = await response.json().catch(() => null);
  const photos = Array.isArray(data && data.photos) ? data.photos : [];
  return json(200, {
    photos: photos.map((photo) => ({
      id: photo.id,
      url: 'https://img.recblue.net/' + photo.image,
      username: photo.username,
      room: photo.room,
      takenAt: photo.takenAt
    }))
  });
}

export async function handleGameDebit(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const verdict = await adminVerdict(request, cfg);
  if (verdict.error) return verdict.error;

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const { raw, names } = await resolveGameTargets(cfg, body.target);
  if (names.length === 0) return json(400, { error: 'Indiquez un pseudo de jeu valide.' });
  const tokens = Number(body.tokens || 0);
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 1000000000) {
    return json(400, { error: 'Nombre de crédits à retirer invalide (1 à 1 000 000 000).' });
  }

  for (const username of names) {
    const response = await fetch(cfg.econHost + '/api/site/debit', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.bridgeToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, tokens })
    }).catch(() => null);

    if (response === null) return json(502, { error: 'Le serveur de jeu est injoignable.' });
    if (response.status === 404) continue;
    if (!response.ok) return json(502, { error: 'Le serveur de jeu a refusé (' + response.status + ').' });

    const data = await response.json().catch(() => null);
    return json(200, {
      ok: true,
      username,
      credits: data && typeof data.balance === 'number' ? data.balance : null,
      removed: data && typeof data.removed === 'number' ? data.removed : null
    });
  }
  return json(404, { error: 'Aucun compte de jeu ne correspond à « ' + raw + ' ».' });
}
