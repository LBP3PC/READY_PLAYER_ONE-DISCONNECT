'use strict';

// Paiement des crédits REC BLUE par PayPal.
// Deux actions, toujours appelées par le navigateur avec la session du joueur :
//   create  -> ouvre une commande PayPal au prix fixé ICI (jamais par le client)
//   capture -> vérifie le paiement auprès de PayPal puis ajoute les crédits
// Le montant et les crédits viennent de cette liste : un visiteur ne peut pas
// les modifier depuis la page.

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://nnftdqrbagynbblthkfg.supabase.co').replace(/\/+$/, '');
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_nNEX-XcGXuBsZyDerHxfLw_WS1BFp-0';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SITE_ORIGIN = (process.env.SITE_ORIGIN || 'https://recblue.vercel.app').replace(/\/+$/, '');
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_API = String(process.env.PAYPAL_ENV || 'sandbox').toLowerCase() === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';
const CURRENCY = 'USD';

const PACKS = Object.freeze({
  p500: { credits: 500, cents: 199, name: '500 crédits' },
  p1000: { credits: 1000, cents: 499, name: '1 000 crédits' },
  p3500: { credits: 3500, cents: 999, name: '3 500 crédits' },
  p12000: { credits: 12000, cents: 1999, name: '12 000 crédits' },
  pstarter: { credits: 5000, cents: 499, name: 'Pack de démarrage' }
});

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

// Identifie le joueur à partir de son jeton de session Supabase.
async function currentUser(req) {
  const header = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const response = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + match[1] }
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  return data && data.id ? data : null;
}

async function paypalToken() {
  const basic = Buffer.from(PAYPAL_CLIENT_ID + ':' + PAYPAL_SECRET).toString('base64');
  const response = await fetch(PAYPAL_API + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error('paypal_auth_' + response.status);
  const data = await response.json();
  if (!data || !data.access_token) throw new Error('paypal_auth_token');
  return data.access_token;
}

async function paypalRequest(method, path, payload, requestId) {
  const token = await paypalToken();
  const headers = { Authorization: 'Bearer ' + token };
  if (payload) headers['Content-Type'] = 'application/json';
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const response = await fetch(PAYPAL_API + path, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

// Ajoute les crédits une seule fois par commande (la fonction SQL est idempotente).
async function credit(packId, credits, cents, orderId, userId) {
  const response = await fetch(SUPABASE_URL + '/rest/v1/rpc/recblue_credit_purchase', {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      p_order_id: orderId,
      p_user: userId,
      p_pack: packId,
      p_credits: credits,
      p_amount_cents: cents,
      p_currency: CURRENCY
    })
  });
  if (!response.ok) throw new Error('credit_' + response.status);
  return Number(await response.json());
}

const centsOf = value => Math.round(Number(value) * 100);

async function createOrder(res, user, packId) {
  const pack = PACKS[packId];
  if (!pack) return json(res, 400, { error: 'Cette offre n’existe pas.' });
  const created = await paypalRequest('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: packId,
      custom_id: user.id + '|' + packId,
      description: pack.name + ' — REC BLUE',
      amount: { currency_code: CURRENCY, value: (pack.cents / 100).toFixed(2) }
    }],
    application_context: {
      brand_name: 'REC BLUE',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
      return_url: SITE_ORIGIN + '/?paypal=retour',
      cancel_url: SITE_ORIGIN + '/?paypal=annule'
    }
  });
  if (!created.ok) return json(res, 502, { error: 'PayPal n’a pas pu ouvrir le paiement (' + created.status + ').' });
  const links = (created.data && created.data.links) || [];
  const approve = links.find(link => link.rel === 'payer-action' || link.rel === 'approve');
  if (!approve || !approve.href) return json(res, 502, { error: 'Lien de paiement PayPal introuvable.' });
  return json(res, 200, { orderId: created.data.id, approveUrl: approve.href });
}

async function captureOrder(res, user, orderId) {
  if (!/^[A-Za-z0-9-]{8,40}$/.test(orderId)) return json(res, 400, { error: 'Numéro de commande invalide.' });

  let order = await paypalRequest('GET', '/v2/checkout/orders/' + encodeURIComponent(orderId));
  if (!order.ok) return json(res, 404, { error: 'Commande PayPal introuvable.' });

  const unit = (order.data.purchase_units || [])[0];
  const [owner, packId] = String((unit && unit.custom_id) || '').split('|');
  if (!owner || owner !== user.id) return json(res, 403, { error: 'Cette commande appartient à un autre compte.' });
  const pack = PACKS[packId];
  if (!pack) return json(res, 400, { error: 'Commande liée à une offre inconnue.' });
  if (!unit || centsOf(unit.amount && unit.amount.value) !== pack.cents || (unit.amount && unit.amount.currency_code) !== CURRENCY) {
    return json(res, 409, { error: 'Montant inattendu : les crédits n’ont pas été ajoutés.' });
  }

  if (order.data.status === 'APPROVED') {
    order = await paypalRequest('POST', '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', {}, 'capture-' + orderId);
    if (!order.ok) return json(res, 402, { error: 'PayPal n’a pas confirmé le paiement (' + order.status + ').' });
  }
  if (order.data.status !== 'COMPLETED') {
    return json(res, 402, { error: 'Le paiement n’est pas terminé (' + String(order.data.status) + ').' });
  }

  const capture = (((order.data.purchase_units || [])[0] || {}).payments || {}).captures;
  const paid = Array.isArray(capture) ? capture[0] : null;
  if (!paid || paid.status !== 'COMPLETED') return json(res, 402, { error: 'Le paiement n’a pas été capturé.' });
  if (centsOf(paid.amount && paid.amount.value) !== pack.cents || (paid.amount && paid.amount.currency_code) !== CURRENCY) {
    return json(res, 409, { error: 'Montant payé inattendu : vérification manuelle nécessaire.' });
  }

  const credits = await credit(packId, pack.credits, pack.cents, orderId, user.id);
  return json(res, 200, { credits, added: pack.credits, pack: packId });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Méthode non autorisée.' });
  try {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET || !SUPABASE_SERVICE_KEY) {
      return json(res, 503, { error: 'Le paiement PayPal n’est pas encore activé. Un administrateur doit ajouter les clés PayPal.' });
    }
    const user = await currentUser(req);
    if (!user) return json(res, 401, { error: 'Connectez-vous pour acheter des crédits.' });

    const body = await readBody(req);
    if (body.action === 'create') return await createOrder(res, user, String(body.pack || ''));
    if (body.action === 'capture') return await captureOrder(res, user, String(body.orderId || '').trim());
    return json(res, 400, { error: 'Action inconnue.' });
  } catch (error) {
    // Jamais de détail technique au visiteur, jamais de secret dans les journaux.
    console.error('paypal', String(error && error.message ? error.message : error));
    return json(res, 500, { error: 'Paiement momentanément indisponible. Réessayez dans un instant.' });
  }
};
