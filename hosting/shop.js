'use strict';

// Boutique REC BLUE — 100 % gratuite.
//
// Aucun paiement, aucun prix et aucune clé de paiement. Le pack est choisi dans cette
// liste (jamais par le client). Les packs de crédits sont réutilisables ; le Plus
// et le pack de démarrage restent limités à une fois par compte. La trace est
// gardée dans user_metadata ; le jeu reçoit les crédits par le pont econ.
//
// Le jeu et les fichiers Rec Room ne sont ni vendus ni distribués ici : le launcher
// utilise l'installation Steam existante.

const PACKS = Object.freeze({
  p500: { credits: 500, name: '500 crédits' },
  p1000: { credits: 1000, name: '1 000 crédits' },
  p3500: { credits: 3500, name: '3 500 crédits' },
  p12000: { credits: 12000, name: '12 000 crédits' },
  p35000: { credits: 35000, name: '35 000 crédits' },
  p100000: { credits: 100000, name: '100 000 crédits' },
  pplus: { credits: 5000, name: 'REC BLUE Abonnement Plus — 1 mois' },
  pstarter: { credits: 5000, name: 'Pack de démarrage' }
});

// Le Plus et le pack de démarrage restent uniques par compte ; les autres packs
// de crédits peuvent être réclamés autant de fois que voulu.
const ONE_TIME = new Set(['pplus', 'pstarter']);
const HISTORY_LIMIT = 6;

const PSEUDO = /^[a-z0-9_][a-z0-9_-]{2,19}$/;

function keep(value, fallback) {
  const text = String(value || '').trim();
  return (text === '' ? fallback : text).replace(/\/+$/, '');
}

function settings(env) {
  return {
    supabaseUrl: keep(env.SUPABASE_URL, 'https://nnftdqrbagynbblthkfg.supabase.co'),
    supabaseKey:
      env.SUPABASE_PUBLISHABLE_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5uZnRkcXJiYWd5bmJibHRoa2ZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM3MDA5OTEsImV4cCI6MjEwOTI3Njk5MX0.JHTNOWkI9DY1xhU8PKco4KqxsIxp_-IsSZL211NGEE8',
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    econHost: keep(env.GAME_ECON_HOST, 'https://econ.recblue.net'),
    bridgeToken: env.SITE_BRIDGE_TOKEN || ''
  };
}

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });

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

function claimsOf(user) {
  const metadata = user && user.user_metadata;
  const claims = metadata && metadata.recblue_free_claims;
  return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : {};
}

async function markClaim(cfg, user, packId, credits, plusUntil) {
  const metadata = { ...(user.user_metadata || {}) };
  const now = new Date().toISOString();
  metadata.recblue_free_claims = {
    ...claimsOf(user),
    [packId]: now
  };
  const previous = Array.isArray(metadata.recblue_claim_history) ? metadata.recblue_claim_history : [];
  const entry = { pack: packId, credits: Number(credits) || 0, at: now };
  if (plusUntil) entry.plusUntil = plusUntil;
  metadata.recblue_claim_history = [entry, ...previous].slice(0, HISTORY_LIMIT);
  const response = await fetch(
    cfg.supabaseUrl + '/auth/v1/admin/users/' + encodeURIComponent(String(user.id)),
    {
      method: 'PUT',
      headers: {
        apikey: cfg.serviceKey,
        Authorization: 'Bearer ' + cfg.serviceKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ user_metadata: metadata })
    }
  ).catch(() => null);
  return !!response && response.ok;
}

function historyOf(user) {
  const metadata = user && user.user_metadata;
  const raw = metadata && metadata.recblue_claim_history;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, HISTORY_LIMIT).map(entry => {
    if (!entry || typeof entry !== 'object') return null;
    const packId = String(entry.pack || '').trim();
    const pack = PACKS[packId];
    if (!pack) return null;
    const credits = Number(entry.credits);
    return {
      pack: packId,
      name: pack.name,
      credits: Number.isFinite(credits) && credits >= 0 ? credits : pack.credits,
      at: String(entry.at || ''),
      plusUntil: entry.plusUntil ? String(entry.plusUntil) : null
    };
  }).filter(Boolean);
}

async function gameUsernames(cfg, userId, loginPseudo) {
  const names = [];
  const push = name => {
    const text = String(name || '').trim().toLowerCase();
    if (text !== '' && PSEUDO.test(text) && !names.includes(text)) names.push(text);
  };
  if (cfg.serviceKey) {
    try {
      const lookup = await fetch(
        cfg.supabaseUrl +
          '/rest/v1/recblue_accounts?select=display_name&id=eq.' +
          encodeURIComponent(String(userId)),
        { headers: { apikey: cfg.serviceKey, Authorization: 'Bearer ' + cfg.serviceKey } }
      );
      const rows = lookup.ok ? await lookup.json().catch(() => null) : null;
      if (Array.isArray(rows) && rows[0]) push(rows[0].display_name);
    } catch {
      /* le pseudo de connexion reste une piste */
    }
  }
  push(loginPseudo);
  return names;
}

async function grantGameCredits(env, userId, tokens, packId, pseudo, message) {
  const cfg = settings(env);
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
      body: JSON.stringify({ username, tokens, message })
    }).catch(() => null);

    if (response === null) return { ok: false, reason: 'unreachable' };
    if (response.status === 404) {
      lastStatus = 404;
      continue;
    }
    if (!response.ok) return { ok: false, reason: 'status ' + response.status };
    const data = await response.json().catch(() => null);
    return {
      ok: true,
      username,
      balance: data && typeof data.balance === 'number' ? data.balance : null,
      giftId: data && data.giftId ? data.giftId : null
    };
  }
  return { ok: false, reason: 'status ' + (lastStatus || 404) };
}

async function grantSitePlus(cfg, user) {
  const id = encodeURIComponent(String(user.id));
  const lookup = await fetch(
    cfg.supabaseUrl + '/rest/v1/recblue_accounts?select=plus_until&id=eq.' + id,
    { headers: { apikey: cfg.serviceKey, Authorization: 'Bearer ' + cfg.serviceKey } }
  ).catch(() => null);
  if (lookup === null) return { ok: false, reason: 'accounts unreachable' };
  if (!lookup.ok) return { ok: false, reason: 'accounts ' + lookup.status };

  const rows = await lookup.json().catch(() => null);
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, reason: 'account missing' };
  }
  const current = rows[0].plus_until ? Date.parse(rows[0].plus_until) : 0;
  const base = new Date(Math.max(Date.now(), Number.isFinite(current) ? current : 0));
  base.setUTCMonth(base.getUTCMonth() + 1);
  const until = base.toISOString();

  const patch = await fetch(cfg.supabaseUrl + '/rest/v1/recblue_accounts?id=eq.' + id, {
    method: 'PATCH',
    headers: {
      apikey: cfg.serviceKey,
      Authorization: 'Bearer ' + cfg.serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({ plus_until: until })
  }).catch(() => null);
  if (patch === null) return { ok: false, reason: 'plus unreachable' };
  if (!patch.ok) return { ok: false, reason: 'plus ' + patch.status };
  return { ok: true, until };
}

async function pushGamePlus(env, userId, pseudo, until) {
  const cfg = settings(env);
  if (cfg.bridgeToken === '') return { ok: false, reason: 'bridge off' };
  const names = await gameUsernames(cfg, userId, pseudo);
  if (names.length === 0) return { ok: false, reason: 'no pseudo' };

  let lastStatus = 0;
  for (const username of names) {
    const response = await fetch(cfg.econHost + '/api/site/plus', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.bridgeToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, until })
    }).catch(() => null);

    if (response === null) return { ok: false, reason: 'unreachable' };
    if (response.status === 404) {
      lastStatus = 404;
      continue;
    }
    if (!response.ok) return { ok: false, reason: 'status ' + response.status };
    return { ok: true, username, until };
  }
  return { ok: false, reason: 'status ' + (lastStatus || 404) };
}

export async function handleFreeClaim(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });

  const cfg = settings(env);
  if (cfg.serviceKey === '') {
    return json(503, {
      error: 'La boutique gratuite n’est pas encore activée : le service de comptes est incomplet.'
    });
  }

  const user = await currentUser(request, cfg);
  if (!user) return json(401, { error: 'Connectez-vous pour obtenir un pack gratuit.' });

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const packId = String(body.pack || '').trim();
  const pack = PACKS[packId];
  if (!pack) return json(400, { error: 'Cette offre n’existe pas.' });

  if (ONE_TIME.has(packId) && claimsOf(user)[packId]) {
    return json(200, { alreadyClaimed: true, pack: packId, added: 0, credits: null });
  }

  const pseudo = String(user.email || '').split('@')[0].toLowerCase();

  if (packId === 'pplus') {
    const plus = await grantSitePlus(cfg, user);
    if (!plus.ok) {
      return json(502, {
        error: 'Le Plus gratuit n’a pas pu être enregistré (' + plus.reason + ').'
      });
    }

    const inGame = await grantGameCredits(
      env,
      user.id,
      pack.credits,
      packId,
      pseudo,
      'Pack gratuit REC BLUE — ' + pack.name + ' (une fois par compte)'
    ).catch(() => ({ ok: false, reason: 'error' }));
    const gamePlus = await pushGamePlus(env, user.id, pseudo, plus.until).catch(() => ({
      ok: false,
      reason: 'error'
    }));
    const saved = await markClaim(cfg, user, packId, pack.credits, plus.until);

    let warning = null;
    if (!saved) {
      warning = 'Le pack est offert, mais la trace de réclamation n’a pas pu être enregistrée.';
    } else if (!inGame.ok || !gamePlus.ok) {
      warning = 'Le site a enregistré le Plus, mais le serveur de jeu n’a pas confirmé une partie du pack.';
    }

    return json(200, {
      claimed: true,
      pack: packId,
      added: pack.credits,
      credits: inGame.ok ? inGame.balance : null,
      plusUntil: plus.until,
      inGame: inGame.ok === true,
      plusInGame: gamePlus.ok === true,
      claimSaved: saved,
      warning
    });
  }

  const inGame = await grantGameCredits(
    env,
    user.id,
    pack.credits,
    packId,
    pseudo,
    'Pack gratuit REC BLUE — ' + pack.name
  ).catch(() => ({ ok: false, reason: 'error' }));

  if (!inGame.ok) {
    return json(502, {
      error: 'Le serveur de jeu n’a pas confirmé le pack gratuit. Réessaie dans un instant.'
    });
  }

  const saved = await markClaim(cfg, user, packId, pack.credits);
  return json(200, {
    claimed: true,
    pack: packId,
    added: pack.credits,
    credits: inGame.balance,
    inGame: true,
    claimSaved: saved,
    warning: saved ? null : 'Le pack est offert, mais la trace de réclamation n’a pas pu être enregistrée.'
  });
}

export async function handleClaimHistory(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });

  const cfg = settings(env);
  const user = await currentUser(request, cfg);
  if (!user) return json(401, { error: 'Connectez-vous pour voir vos réclamations.' });

  return json(200, { history: historyOf(user) });
}
