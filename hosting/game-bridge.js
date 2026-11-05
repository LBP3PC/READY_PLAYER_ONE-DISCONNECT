'use strict';

// Passerelle entre le site (comptes Supabase) et le serveur de jeu (RecFlare).
//
//  - /api/game/signup : crée le compte de JEU avec le pseudo + mot de passe du site,
//    puis lui donne ce pseudo comme nom en jeu. C'est ce qui fait qu'un compte créé
//    sur le site sert tout de suite à se connecter dans Rec Room.
//  - grant : après un paiement PayPal confirmé, crédite les jetons du JEU et laisse
//    une box à ouvrir (appelé depuis paypal.js, jamais par le navigateur).
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
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 1000000) {
    return json(400, { error: 'Nombre de crédits invalide (1 à 1 000 000).' });
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
  const { raw, names } = targetsOf(body.target);
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
  const raw = String(body.target || '').trim().toLowerCase();
  const candidates = raw.includes('@') ? [pseudoFromEmail(raw), raw] : [raw];
  const names = candidates.filter(name => PSEUDO.test(name));
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
    return json(200, {
      ok: true,
      username,
      role,
      isModerator: Boolean(data && data.isModerator),
      isDeveloper: Boolean(data && data.isDeveloper)
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
  const raw = String(body.target || '').trim().toLowerCase();
  const candidates = raw.includes('@') ? [pseudoFromEmail(raw), raw] : [raw];
  const names = candidates.filter(name => PSEUDO.test(name));
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

/** Le badge du joueur CONNECTÉ au site, lu sur son compte de jeu. */
export async function handleGameCertified(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const user = await currentUser(request, cfg);
  if (!user) return json(401, { error: 'Connectez-vous d’abord sur le site.' });

  const names = await gameUsernames(cfg, user.id, pseudoFromEmail(user.email));
  for (const username of names) {
    const response = await fetch(
      cfg.econHost + '/api/site/certified?username=' + encodeURIComponent(username),
      { headers: { Authorization: 'Bearer ' + cfg.bridgeToken } }
    ).catch(() => null);
    if (response === null) return json(502, { error: 'Le serveur de jeu est injoignable.' });
    if (!response.ok) continue;
    const data = await response.json().catch(() => null);
    if (data && typeof data.certified === 'boolean') {
      // `plus` vient du compte de JEU : le site s'en sert pour l'or des crédits.
      return json(200, {
        certified: data.certified,
        plus: data.plus === true,
        plusUntil: data.plusUntil ?? null,
        username
      });
    }
  }
  return json(200, { certified: false });
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
  const { raw, names } = targetsOf(body.target);
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

  const bodies = await Promise.all(
    urls.map(url =>
      fetch(url, { headers: { Accept: 'application/json' } })
        .then(response => (response.ok ? response.json() : null))
        .catch(() => null)
    )
  );
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
      publishedAt: room.PublishedAt || room.CreatedAt || null
    }));

  // Les compteurs réels (visites, favoris) sont des colonnes du serveur de jeu, pas des
  // champs de la chambre : le site les fusionne ici. Si ce service ne répond pas, on garde
  // les valeurs du flux plutôt que d'afficher des zéros inventés.
  const statsResponse = await fetch(cfg.econHost + '/api/site/room-stats', {
    headers: { Authorization: 'Bearer ' + cfg.bridgeToken }
  }).catch(() => null);
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
export async function handleGameStatus(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });
  const cfg = gameSettings(env);
  const [econ, rooms] = await Promise.all([
    fetch(cfg.econHost + '/api/site/online', {
      headers: { Authorization: 'Bearer ' + cfg.bridgeToken }
    }).catch(() => null),
    fetch(cfg.roomsHost + '/rooms/hot?take=1').catch(() => null)
  ]);

  let online = null;
  if (econ && econ.ok) {
    const data = await econ.json().catch(() => null);
    const count = Number(data && data.online);
    if (Number.isFinite(count)) online = count;
  }

  return json(200, {
    game: Boolean(econ && econ.ok),
    rooms: Boolean(rooms && rooms.ok),
    presence: online !== null,
    online: online === null ? 0 : online
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
  const { raw, names } = targetsOf(body.target);
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
