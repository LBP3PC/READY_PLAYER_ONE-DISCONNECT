'use strict';

// Boutique et inventaire du JEU depuis le site — donc depuis l'app iOS installable.
//
// Rien n'est acheté au nom du navigateur : l'identité vient de la session du site, le
// pseudo de jeu est relu depuis les comptes, et l'achat se fait par le pont econ (jeton
// `SITE_BRIDGE_TOKEN`). Le prix n'est jamais envoyé par le client : econ le relit dans
// le catalogue, avec la seule remise qui existe — les 10 % de REC BLUE Plus — et débite
// le même solde que le jeu. Un achat raté ne coûte rien : econ ne débite qu'un article
// qu'il a d'abord résolu, et rembourse si la remise de l'objet échoue.
//
// L'inventaire sert aussi au catalogue : `owned` vient des `AvatarItemDesc` possédés, pour
// que l'app montre « Déjà à vous » au lieu d'un bouton qui rachèterait.

import { currentUser, gameSettings, gameUsernames, json, pseudoFromEmail } from './game-bridge.js';

/** Les ids de boutique acceptés : ceux du jeu, rien d'autre. */
const STOREFRONT_IDS = new Set([1, 2, 3, 100, 101, 102, 103, 300, 400, 401, 402, 403]);

/** Un appel au pont econ, avec le jeton du site. `status` 0 = pont injoignable. */
async function econCall(cfg, path, init) {
  const response = await fetch(cfg.econHost + path, {
    method: (init && init.method) || 'GET',
    headers: {
      Authorization: 'Bearer ' + cfg.bridgeToken,
      ...((init && init.headers) || {})
    },
    body: init && init.body ? init.body : undefined,
    cache: 'no-store'
  }).catch(() => null);
  if (response === null) return { status: 0, body: null };
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** Le premier pseudo de jeu qui a un compte, avec la réponse d'econ. */
async function firstAccount(cfg, names, pathFor) {
  let lastStatus = 0;
  for (const username of names) {
    const result = await econCall(cfg, pathFor(username));
    if (result.status === 404) {
      lastStatus = 404;
      continue;
    }
    return { username, ...result };
  }
  return { username: names[0] || null, status: lastStatus || 404, body: null };
}

/** Session + pseudos de jeu, ou la réponse d'erreur à renvoyer tel quel. */
async function player(cfg, request) {
  const user = await currentUser(request, cfg);
  if (!user) return { error: json(401, { error: 'Connectez-vous d’abord sur le site.' }) };
  if (cfg.bridgeToken === '') {
    return { error: json(503, { error: 'Boutique du jeu indisponible : pont non configuré.' }) };
  }
  const names = await gameUsernames(cfg, user.id, pseudoFromEmail(user.email));
  if (names.length === 0) {
    return { error: json(409, { error: 'Aucun compte de jeu n’est lié à ce compte du site.' }) };
  }
  return { user, names };
}

function outOfReach() {
  return json(502, { error: 'Le service de jeu ne répond pas. Réessayez dans un instant.' });
}

/** `GET /api/game/inventory` : solde et garde-robe du compte de jeu. */
export async function handleGameInventory(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });

  const cfg = gameSettings(env);
  const who = await player(cfg, request);
  if (who.error) return who.error;

  const found = await firstAccount(
    cfg,
    who.names,
    (username) => '/api/site/inventory?username=' + encodeURIComponent(username)
  );
  if (found.status === 0) return outOfReach();
  if (found.status !== 200 || !found.body) {
    return json(404, { error: 'Aucun compte de jeu ne correspond à ce compte du site.' });
  }

  return json(200, {
    username: found.username,
    accountId: Number.isInteger(found.body.accountId) ? found.body.accountId : null,
    credits: typeof found.body.balance === 'number' ? found.body.balance : null,
    items: Array.isArray(found.body.items) ? found.body.items : []
  });
}

/** `GET /api/game/storefront?storefront=3` : le catalogue, avec ce que le joueur possède. */
export async function handleGameStorefront(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });

  const cfg = gameSettings(env);
  const who = await player(cfg, request);
  if (who.error) return who.error;

  const type = Number(new URL(request.url).searchParams.get('storefront') || '3');
  if (!Number.isInteger(type) || !STOREFRONT_IDS.has(type)) {
    return json(400, { error: 'Boutique inconnue.' });
  }

  // L'inventaire d'abord : c'est lui qui dit quels articles sont déjà au joueur.
  const inventory = await firstAccount(
    cfg,
    who.names,
    (username) => '/api/site/inventory?username=' + encodeURIComponent(username)
  );
  if (inventory.status === 0) return outOfReach();
  const owned = new Set(
    (Array.isArray(inventory.body && inventory.body.items) ? inventory.body.items : [])
      .map((item) => (item && item.desc ? String(item.desc) : ''))
      .filter(Boolean)
  );

  const catalog = await econCall(cfg, '/api/site/storefront?storefront=' + type);
  if (catalog.status === 0) return outOfReach();
  if (catalog.status !== 200 || !catalog.body) {
    return json(502, { error: 'Le catalogue de cette boutique est indisponible.' });
  }

  const items = (Array.isArray(catalog.body.items) ? catalog.body.items : []).map((item) => ({
    id: item.id,
    name: item.name || '',
    desc: item.desc || '',
    price: item.price,
    plusOnly: item.plusOnly === true,
    box: item.box === true,
    owned: item.desc ? owned.has(String(item.desc)) : false
  }));

  return json(200, {
    storefront: type,
    username: inventory.username || who.names[0] || null,
    credits: typeof (inventory.body && inventory.body.balance) === 'number' ? inventory.body.balance : null,
    items
  });
}

/** Deux clics sur « Acheter » ne doivent pas coûter deux articles. */
const buying = new Set();

/** `POST /api/game/buy { storefront, item }` : un achat depuis l'app. */
export async function handleGameShopBuy(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });

  const cfg = gameSettings(env);
  const who = await player(cfg, request);
  if (who.error) return who.error;

  const body = await request.json().catch(() => null);
  const storefront = Number(body && body.storefront);
  const item = Number(body && body.item);
  if (!Number.isInteger(storefront) || !STOREFRONT_IDS.has(storefront) || !Number.isInteger(item)) {
    return json(400, { error: 'Demande d’achat invalide.' });
  }

  const key = who.user.id + ':' + storefront + ':' + item;
  if (buying.has(key)) {
    return json(429, { error: 'Un achat de cet article est déjà en cours.' });
  }
  buying.add(key);
  try {
    // Le pseudo qui a un compte décide de qui paie : l'app ne l'envoie jamais.
    const inventory = await firstAccount(
      cfg,
      who.names,
      (username) => '/api/site/inventory?username=' + encodeURIComponent(username)
    );
    if (inventory.status === 0) return outOfReach();
    if (inventory.status !== 200 || !inventory.body || !inventory.username) {
      return json(404, { error: 'Aucun compte de jeu ne correspond à ce compte du site.' });
    }

    const purchase = await econCall(cfg, '/api/site/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: inventory.username, storefront, item })
    });
    if (purchase.status === 0) return outOfReach();

    if (purchase.status === 400 && purchase.body && purchase.body.error === 'Insufficient balance') {
      return json(402, { error: 'Crédits insuffisants pour cet article.' });
    }
    if (purchase.status === 403) {
      return json(403, { error: 'Cet article est réservé aux membres REC BLUE Plus.' });
    }
    if (purchase.status === 404) {
      return json(404, { error: 'Cet article n’est plus en vente.' });
    }
    if (purchase.status !== 200 || !purchase.body) {
      return json(502, { error: 'L’achat n’a pas abouti. Rien n’a été débité.' });
    }

    return json(200, {
      username: inventory.username,
      item: purchase.body.item || { id: item, name: '' },
      charged: typeof purchase.body.charged === 'number' ? purchase.body.charged : null,
      credits: typeof purchase.body.balance === 'number' ? purchase.body.balance : null
    });
  } finally {
    buying.delete(key);
  }
}
