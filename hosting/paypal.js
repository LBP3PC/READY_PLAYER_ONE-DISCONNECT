'use strict';

import { grantGameCredits } from './game-bridge.js';

// Paiement des crédits REC BLUE par PayPal — version Worker.
// Deux actions, toujours appelées par le navigateur avec la session du joueur :
//   create  -> ouvre une commande PayPal au prix fixé ICI (jamais par le client)
//   capture -> vérifie le paiement auprès de PayPal puis ajoute les crédits
// Le montant et les crédits viennent de cette liste : un visiteur ne peut pas
// les modifier depuis la page.
//
// Clés attendues en secrets Cloudflare (jamais dans le code) :
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, SUPABASE_SERVICE_ROLE_KEY
// Optionnelles : PAYPAL_ENV=live, SITE_ORIGIN, SUPABASE_URL.
// Tant que les trois premières manquent, l'endpoint répond 503 et aucun
// paiement ne peut être créé.

const CURRENCY = 'USD';

const PACKS = Object.freeze({
  p500: { credits: 500, cents: 199, name: '500 crédits' },
  p1000: { credits: 1000, cents: 499, name: '1 000 crédits' },
  p3500: { credits: 3500, cents: 999, name: '3 500 crédits' },
  p12000: { credits: 12000, cents: 1999, name: '12 000 crédits' },
  p35000: { credits: 35000, cents: 4999, name: '35 000 crédits' },
  p100000: { credits: 100000, cents: 35000, currency: 'EUR', name: '100 000 crédits' },
  pplus: { credits: 5000, cents: 799, name: 'REC BLUE Abonnement Plus — 1 mois' },
  pstarter: { credits: 5000, cents: 499, name: 'Pack de démarrage' }
});

function settings(env) {
  const keep = value => String(value || '').replace(/\/+$/, '');
  return {
    supabaseUrl: keep(env.SUPABASE_URL || 'https://nnftdqrbagynbblthkfg.supabase.co'),
    supabaseKey:
      env.SUPABASE_PUBLISHABLE_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5uZnRkcXJiYWd5bmJibHRoa2ZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM3MDA5OTEsImV4cCI6MjEwOTI3Njk5MX0.JHTNOWkI9DY1xhU8PKco4KqxsIxp_-IsSZL211NGEE8',
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    siteOrigin: keep(env.SITE_ORIGIN || 'https://recblue.net'),
    clientId: env.PAYPAL_CLIENT_ID || '',
    secret: env.PAYPAL_CLIENT_SECRET || '',
    api:
      String(env.PAYPAL_ENV || 'sandbox').toLowerCase() === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com',
    econHost: String(env.GAME_ECON_HOST || 'https://econ.recblue.net').replace(/\/+$/, ''),
    bridgeToken: env.SITE_BRIDGE_TOKEN || ''
  };
}

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });

// Identifie le joueur à partir de son jeton de session Supabase.
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

async function paypalToken(cfg) {
  const response = await fetch(cfg.api + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(cfg.clientId + ':' + cfg.secret),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error('paypal_auth_' + response.status);
  const data = await response.json().catch(() => null);
  if (!data || !data.access_token) throw new Error('paypal_auth_token');
  return data.access_token;
}

async function paypalRequest(cfg, method, path, payload, requestId) {
  const token = await paypalToken(cfg);
  const headers = { Authorization: 'Bearer ' + token };
  if (payload) headers['Content-Type'] = 'application/json';
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const response = await fetch(cfg.api + path, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

// Ajoute les crédits une seule fois par commande (la fonction SQL est idempotente).
async function credit(cfg, packId, pack, orderId, userId, currency) {
  const response = await fetch(cfg.supabaseUrl + '/rest/v1/rpc/recblue_credit_purchase', {
    method: 'POST',
    headers: {
      apikey: cfg.serviceKey,
      Authorization: 'Bearer ' + cfg.serviceKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      p_order_id: orderId,
      p_user: userId,
      p_pack: packId,
      p_credits: pack.credits,
      p_amount_cents: pack.cents,
      p_currency: currency || CURRENCY
    })
  });
  if (!response.ok) throw new Error('credit_' + response.status);
  return Number(await response.json());
}

const centsOf = value => Math.round(Number(value) * 100);

async function createOrder(cfg, user, packId) {
  const pack = PACKS[packId];
  if (!pack) return json(400, { error: 'Cette offre n’existe pas.' });
  const currency = pack.currency || CURRENCY;
  const created = await paypalRequest(cfg, 'POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: packId,
        custom_id: user.id + '|' + packId,
        description: pack.name + ' — REC BLUE',
        amount: { currency_code: currency, value: (pack.cents / 100).toFixed(2) }
      }
    ],
    application_context: {
      brand_name: 'REC BLUE',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
      return_url: cfg.siteOrigin + '/?paypal=retour',
      cancel_url: cfg.siteOrigin + '/?paypal=annule'
    }
  });
  if (!created.ok) {
    return json(502, { error: 'PayPal n’a pas pu ouvrir le paiement (' + created.status + ').' });
  }
  const links = (created.data && created.data.links) || [];
  const approve = links.find(link => link.rel === 'payer-action' || link.rel === 'approve');
  if (!approve || !approve.href) return json(502, { error: 'Lien de paiement PayPal introuvable.' });
  return json(200, { orderId: created.data.id, approveUrl: approve.href });
}

async function captureOrder(env, cfg, user, orderId) {
  if (!/^[A-Za-z0-9-]{8,40}$/.test(orderId)) return json(400, { error: 'Numéro de commande invalide.' });

  let order = await paypalRequest(cfg, 'GET', '/v2/checkout/orders/' + encodeURIComponent(orderId));
  if (!order.ok) return json(404, { error: 'Commande PayPal introuvable.' });

  const unit = (order.data.purchase_units || [])[0];
  const [owner, packId] = String((unit && unit.custom_id) || '').split('|');
  if (!owner || owner !== user.id) return json(403, { error: 'Cette commande appartient à un autre compte.' });
  const pack = PACKS[packId];
  if (!pack) return json(400, { error: 'Commande liée à une offre inconnue.' });
  const currency = pack.currency || CURRENCY;
  if (
    !unit ||
    centsOf(unit.amount && unit.amount.value) !== pack.cents ||
    (unit.amount && unit.amount.currency_code) !== currency
  ) {
    return json(409, { error: 'Montant inattendu : les crédits n’ont pas été ajoutés.' });
  }

  if (order.data.status === 'APPROVED') {
    order = await paypalRequest(
      cfg,
      'POST',
      '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture',
      {},
      'capture-' + orderId
    );
    if (!order.ok) {
      return json(402, { error: 'PayPal n’a pas confirmé le paiement (' + order.status + ').' });
    }
  }
  if (order.data.status !== 'COMPLETED') {
    return json(402, { error: 'Le paiement n’est pas terminé (' + String(order.data.status) + ').' });
  }

  const capture = (((order.data.purchase_units || [])[0] || {}).payments || {}).captures;
  const paid = Array.isArray(capture) ? capture[0] : null;
  if (!paid || paid.status !== 'COMPLETED') return json(402, { error: 'Le paiement n’a pas été capturé.' });
  if (
    centsOf(paid.amount && paid.amount.value) !== pack.cents ||
    (paid.amount && paid.amount.currency_code) !== currency
  ) {
    return json(409, { error: 'Montant payé inattendu : vérification manuelle nécessaire.' });
  }

  const credits = await credit(cfg, packId, pack, orderId, user.id, currency);

  // Les jetons du JEU, plus une box à ouvrir en jeu. Best-effort : le crédit du site
  // reste valable si le serveur de jeu ne répond pas, et `inGame` le dit à la page.
  // Le nom en jeu est le pseudo de connexion du site (adresse technique
  // `pseudo@players.recblue.invalid`) : on le transmet au pont.
  const pseudo = String(user.email || '').split('@')[0].toLowerCase();
  // La box dit merci ET ce qui a été payé : offre, montant exact et devise.
  const montant = (pack.cents / 100).toFixed(2).replace('.', ',');
  const message = 'Merci pour ton achat de ' + pack.name + ' (' + montant + ' ' + currency + ') !';
  const inGame = await grantGameCredits(env, user.id, pack.credits, orderId, pseudo, message).catch(() => ({
    ok: false,
    reason: 'error'
  }));

  return json(200, {
    credits,
    added: pack.credits,
    pack: packId,
    inGame: inGame.ok === true ? { tokens: pack.credits, username: inGame.username } : null
  });
}

export async function handlePaypal(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });

  const cfg = settings(env);
  try {
    if (!cfg.clientId || !cfg.secret || !cfg.serviceKey) {
      return json(503, {
        error:
          'Le paiement PayPal n’est pas encore activé. Un administrateur doit ajouter les clés PayPal.'
      });
    }
    const user = await currentUser(request, cfg);
    if (!user) return json(401, { error: 'Connectez-vous pour acheter des crédits.' });

    const body = await request.json().catch(() => ({}));
    if (body.action === 'create') return await createOrder(cfg, user, String(body.pack || ''));
    if (body.action === 'capture') {
      return await captureOrder(env, cfg, user, String(body.orderId || '').trim());
    }
    return json(400, { error: 'Action inconnue.' });
  } catch (error) {
    // Jamais de détail technique au visiteur, jamais de secret dans les journaux.
    console.error('paypal', String(error && error.message ? error.message : error));
    return json(500, { error: 'Paiement momentanément indisponible. Réessayez dans un instant.' });
  }
}
