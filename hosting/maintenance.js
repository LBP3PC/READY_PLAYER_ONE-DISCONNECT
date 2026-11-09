'use strict';

// État de maintenance du jeu, stocké dans un objet Supabase Storage privé.
// Aucun schéma SQL à créer : le Worker crée le bucket au premier réglage.
import { gameSettings } from './game-bridge.js';

const BUCKET = 'recblue-config';
const OBJECT = 'maintenance.json';
const DEFAULT_CODE = 'SUMMER';
const DEFAULT_MESSAGE = 'Le jeu est en maintenance. Entre le code d’accès pour jouer.';

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });

function text(value, fallback) {
  const result = String(value == null ? '' : value).trim();
  return result === '' ? fallback : result;
}

function defaultConfig() {
  return { active: false, message: DEFAULT_MESSAGE, code: DEFAULT_CODE, updatedAt: '' };
}

function normalizeConfig(raw) {
  const base = defaultConfig();
  if (!raw || typeof raw !== 'object') return base;
  const code = text(raw.code, DEFAULT_CODE).toUpperCase();
  return {
    active: raw.active === true,
    message: text(raw.message, DEFAULT_MESSAGE).slice(0, 200),
    code: /^[A-Z0-9_-]{3,40}$/.test(code) ? code : DEFAULT_CODE,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : ''
  };
}

function storageHeaders(cfg, extra) {
  return Object.assign(
    {
      apikey: cfg.serviceKey,
      Authorization: 'Bearer ' + cfg.serviceKey
    },
    extra || {}
  );
}

async function ensureBucket(cfg) {
  if (!cfg.serviceKey) return false;
  const response = await fetch(cfg.supabaseUrl + '/storage/v1/bucket', {
    method: 'POST',
    headers: storageHeaders(cfg, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false })
  }).catch(() => null);
  // 400/409 : le bucket existe déjà. L’upload confirmera qu’il est utilisable.
  return !!response && (response.ok || response.status === 400 || response.status === 409);
}

async function readConfig(cfg) {
  if (!cfg.serviceKey) return defaultConfig();
  const response = await fetch(
    cfg.supabaseUrl + '/storage/v1/object/' + BUCKET + '/' + OBJECT,
    { headers: storageHeaders(cfg), cache: 'no-store' }
  ).catch(() => null);
  if (!response || !response.ok) return defaultConfig();
  const data = await response.json().catch(() => null);
  return normalizeConfig(data);
}

async function writeConfig(cfg, config) {
  if (!(await ensureBucket(cfg))) return false;
  const response = await fetch(
    cfg.supabaseUrl + '/storage/v1/object/' + BUCKET + '/' + OBJECT,
    {
      method: 'POST',
      headers: storageHeaders(cfg, {
        'Content-Type': 'application/json',
        'x-upsert': 'true'
      }),
      body: JSON.stringify(config)
    }
  ).catch(() => null);
  return !!response && response.ok;
}

function bearer(request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : '';
}

async function currentUser(request, cfg) {
  const token = bearer(request);
  if (!token) return null;
  const response = await fetch(cfg.supabaseUrl + '/auth/v1/user', {
    headers: { apikey: cfg.supabaseKey, Authorization: 'Bearer ' + token }
  }).catch(() => null);
  if (!response || !response.ok) return null;
  const data = await response.json().catch(() => null);
  return data && data.id ? data : null;
}

async function roleOf(cfg, user, token) {
  if (!user || !user.id) return '';
  const key = cfg.serviceKey || cfg.supabaseKey;
  const authorization = cfg.serviceKey ? 'Bearer ' + cfg.serviceKey : 'Bearer ' + token;
  const response = await fetch(
    cfg.supabaseUrl +
      '/rest/v1/recblue_accounts?select=role&id=eq.' +
      encodeURIComponent(String(user.id)),
    { headers: { apikey: key, Authorization: authorization } }
  ).catch(() => null);
  if (!response || !response.ok) return '';
  const data = await response.json().catch(() => null);
  return Array.isArray(data) && data[0] ? String(data[0].role || '') : '';
}

async function adminSession(request, cfg) {
  const user = await currentUser(request, cfg);
  if (!user) return { user: null, role: '' };
  const role = await roleOf(cfg, user, bearer(request));
  return { user, role };
}

export async function handleMaintenanceStatus(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' });
  const config = await readConfig(gameSettings(env));
  return json(200, {
    active: config.active,
    message: config.message,
    updatedAt: config.updatedAt
  });
}

export async function handleMaintenanceAdmin(request, env) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json(405, { error: 'Méthode non autorisée.' });
  }

  const cfg = gameSettings(env);
  if (!cfg.serviceKey) return json(503, { error: 'Service de configuration incomplet.' });

  const session = await adminSession(request, cfg);
  if (!session.user) return json(401, { error: 'Connectez-vous d’abord sur le site.' });
  if (session.role !== 'admin') return json(403, { error: 'Réservé aux administrateurs.' });

  if (request.method === 'GET') {
    return json(200, await readConfig(cfg));
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const current = await readConfig(cfg);
  const active = typeof body.active === 'boolean' ? body.active : current.active;
  let code = current.code;
  if (typeof body.code === 'string' && body.code.trim() !== '') {
    code = body.code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,40}$/.test(code)) {
      return json(400, { error: 'Le code doit contenir 3 à 40 lettres, chiffres, tirets ou underscores.' });
    }
  }
  const message = typeof body.message === 'string' ? body.message.trim() : current.message;
  const config = normalizeConfig({
    active,
    message,
    code,
    updatedAt: new Date().toISOString()
  });

  if (!(await writeConfig(cfg, config))) {
    return json(502, { error: 'Impossible d’enregistrer la maintenance pour le moment.' });
  }
  return json(200, config);
}

export async function handleMaintenanceAccess(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Méthode non autorisée.' });

  const cfg = gameSettings(env);
  const config = await readConfig(cfg);
  if (!config.active) return json(200, { allowed: true, reason: 'open' });

  const token = bearer(request);
  if (token) {
    const user = await currentUser(request, cfg);
    if (user && (await roleOf(cfg, user, token)) === 'admin') {
      return json(200, { allowed: true, reason: 'admin' });
    }
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const code = String(body.code == null ? '' : body.code).trim().toUpperCase();
  if (code !== '' && code === config.code) {
    return json(200, { allowed: true, reason: 'code' });
  }
  return json(200, {
    allowed: false,
    error: code === ''
      ? 'Le jeu est en maintenance. Entre le code d’accès.'
      : 'Code d’accès incorrect.'
  });
}
