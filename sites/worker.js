'use strict';

// REC BLUE — hébergement « Sites » : fichiers du jeu + paiement PayPal.
// Même logique que hosting/public/api/paypal.js, réécrite pour un Worker
// (pas de process.env ni de Buffer) : les clés viennent de l'environnement.

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

const CURRENCY = 'USD';
const SUPABASE_URL = 'https://nnftdqrbagynbblthkfg.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_nNEX-XcGXuBsZyDerHxfLw_WS1BFp-0';

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

const trim = value => String(value || '').replace(/\/+$/, '');

// Identifie le joueur à partir de son jeton de session Supabase.
async function currentUser(request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const response = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + match[1] }
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  return data && data.id ? data : null;
}

function paypalApi(env) {
  return String(env.PAYPAL_ENV || 'sandbox').toLowerCase() === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

async function paypalToken(env) {
  const basic = btoa(String(env.PAYPAL_CLIENT_ID) + ':' + String(env.PAYPAL_CLIENT_SECRET));
  const response = await fetch(paypalApi(env) + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error('paypal_auth_' + response.status);
  const data = await response.json();
  if (!data || !data.access_token) throw new Error('paypal_auth_token');
  return data.access_token;
}

async function paypalRequest(env, method, path, payload, requestId) {
  const token = await paypalToken(env);
  const headers = { Authorization: 'Bearer ' + token };
  if (payload) headers['Content-Type'] = 'application/json';
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const response = await fetch(paypalApi(env) + path, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

// Ajoute les crédits une seule fois par commande (fonction SQL idempotente).
async function creditCredits(env, packId, credits, cents, orderId, userId, currency) {
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  const response = await fetch(SUPABASE_URL + '/rest/v1/rpc/recblue_credit_purchase', {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      p_order_id: orderId,
      p_user: userId,
      p_pack: packId,
      p_credits: credits,
      p_amount_cents: cents,
      p_currency: currency || CURRENCY
    })
  });
  if (!response.ok) throw new Error('credit_' + response.status);
  return Number(await response.json());
}

const centsOf = value => Math.round(Number(value) * 100);

async function createOrder(env, request, user, packId) {
  const pack = PACKS[packId];
  if (!pack) return json(400, { error: 'Cette offre n’existe pas.' });
  const origin = trim(env.SITE_ORIGIN || new URL(request.url).origin);
  const currency = pack.currency || CURRENCY;
  const created = await paypalRequest(env, 'POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: packId,
      custom_id: user.id + '|' + packId,
      description: pack.name + ' — REC BLUE',
      amount: { currency_code: currency, value: (pack.cents / 100).toFixed(2) }
    }],
    application_context: {
      brand_name: 'REC BLUE',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
      return_url: origin + '/?paypal=retour',
      cancel_url: origin + '/?paypal=annule'
    }
  });
  if (!created.ok) return json(502, { error: 'PayPal n’a pas pu ouvrir le paiement (' + created.status + ').' });
  const links = (created.data && created.data.links) || [];
  const approve = links.find(link => link.rel === 'payer-action' || link.rel === 'approve');
  if (!approve || !approve.href) return json(502, { error: 'Lien de paiement PayPal introuvable.' });
  return json(200, { orderId: created.data.id, approveUrl: approve.href });
}

async function captureOrder(env, user, orderId) {
  if (!/^[A-Za-z0-9-]{8,40}$/.test(orderId)) return json(400, { error: 'Numéro de commande invalide.' });

  let order = await paypalRequest(env, 'GET', '/v2/checkout/orders/' + encodeURIComponent(orderId));
  if (!order.ok) return json(404, { error: 'Commande PayPal introuvable.' });

  const unit = (order.data.purchase_units || [])[0];
  const [owner, packId] = String((unit && unit.custom_id) || '').split('|');
  if (!owner || owner !== user.id) return json(403, { error: 'Cette commande appartient à un autre compte.' });
  const pack = PACKS[packId];
  if (!pack) return json(400, { error: 'Commande liée à une offre inconnue.' });
  const currency = pack.currency || CURRENCY;
  if (!unit || centsOf(unit.amount && unit.amount.value) !== pack.cents || (unit.amount && unit.amount.currency_code) !== currency) {
    return json(409, { error: 'Montant inattendu : les crédits n’ont pas été ajoutés.' });
  }

  if (order.data.status === 'APPROVED') {
    order = await paypalRequest(env, 'POST', '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', {}, 'capture-' + orderId);
    if (!order.ok) return json(402, { error: 'PayPal n’a pas confirmé le paiement (' + order.status + ').' });
  }
  if (order.data.status !== 'COMPLETED') {
    return json(402, { error: 'Le paiement n’est pas terminé (' + String(order.data.status) + ').' });
  }

  const capture = (((order.data.purchase_units || [])[0] || {}).payments || {}).captures;
  const paid = Array.isArray(capture) ? capture[0] : null;
  if (!paid || paid.status !== 'COMPLETED') return json(402, { error: 'Le paiement n’a pas été capturé.' });
  if (centsOf(paid.amount && paid.amount.value) !== pack.cents || (paid.amount && paid.amount.currency_code) !== currency) {
    return json(409, { error: 'Montant payé inattendu : vérification manuelle nécessaire.' });
  }

  const credits = await creditCredits(env, packId, pack.credits, pack.cents, orderId, user.id, currency);
  return json(200, { credits, added: pack.credits, pack: packId });
}

async function handlePaypal(env, request) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });
  try {
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return json(503, { error: 'Le paiement PayPal n’est pas encore activé. Un administrateur doit ajouter les clés PayPal.' });
    }
    const user = await currentUser(request);
    if (!user) return json(401, { error: 'Connectez-vous pour acheter des crédits.' });

    const body = await request.json().catch(() => ({}));
    if (body.action === 'create') return await createOrder(env, request, user, String(body.pack || ''));
    if (body.action === 'capture') return await captureOrder(env, user, String(body.orderId || '').trim());
    return json(400, { error: 'Action inconnue.' });
  } catch (error) {
    // Jamais de détail technique au visiteur, jamais de secret dans les journaux.
    console.error('paypal', String(error && error.message ? error.message : error));
    return json(500, { error: 'Paiement momentanément indisponible. Réessayez dans un instant.' });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/paypal' || url.pathname === '/api/paypal/') return handlePaypal(env, request);
    return env.ASSETS.fetch(request);
  }
};
