#!/usr/bin/env node
// Enregistrements DNS de la messagerie Zoho Mail pour recblue.net, via l'API Cloudflare.
//
// Par défaut le script NE MODIFIE RIEN : il affiche ce qu'il ferait (mode essai).
// Pour appliquer : ajouter --apply (et fournir un jeton).
//
//   CLOUDFLARE_API_TOKEN=... node hosting/scripts/zoho-dns.mjs            # essai
//   CLOUDFLARE_API_TOKEN=... node hosting/scripts/zoho-dns.mjs --apply    # écrit
//
// Le jeton doit avoir la permission Zone.DNS:Edit sur recblue.net. Ne jamais le
// commiter : il se lit dans la variable d'environnement, ou dans le fichier
// hosting/.cf-token (une seule ligne), qui doit rester hors de git.
//
// Deux enregistrements dépendent de TON compte Zoho et ne peuvent pas être devinés :
// la vérification du domaine et la clé DKIM. Dépose-les dans hosting/.zoho-records.json :
//   { "verification": "zoho-verification=zbXXXXXXXX.zmverify.zoho.eu", "dkim": "v=DKIM1; k=rsa; p=MIIB..." }
// Sans ce fichier, le script applique le reste et signale ce qui manque.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ZONE_NAME = process.env.CLOUDFLARE_ZONE_NAME || 'recblue.net';
// Le compte Zoho a été créé sur le centre de données européen (mail.zoho.eu).
// Ses serveurs de réception sont donc *.zoho.eu ; un compte .com utiliserait *.zoho.com.
const MAIL_HOSTS = [
  { content: 'mx.zoho.eu', priority: 10 },
  { content: 'mx2.zoho.eu', priority: 20 },
  { content: 'mx3.zoho.eu', priority: 50 }
];
const SPF = 'v=spf1 include:zohomail.eu ~all';
const DMARC = 'v=DMARC1; p=none; rua=mailto:dmarc@recblue.net';

const apply = process.argv.includes('--apply');

async function readToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN.trim();
  try {
    const raw = await readFile(join(HERE, '..', '.cf-token'), 'utf8');
    const token = raw.trim();
    return token === '' ? null : token;
  } catch (error) {
    return null;
  }
}

async function readZohoValues() {
  try {
    const raw = await readFile(join(HERE, '..', '.zoho-records.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      verification: typeof parsed.verification === 'string' ? parsed.verification.trim() : '',
      dkim: typeof parsed.dkim === 'string' ? parsed.dkim.trim() : ''
    };
  } catch (error) {
    return { verification: '', dkim: '' };
  }
}

function desiredRecords(zoho) {
  const records = [
    ...MAIL_HOSTS.map(host => ({ type: 'MX', name: ZONE_NAME, content: host.content, priority: host.priority })),
    { type: 'TXT', name: ZONE_NAME, content: SPF },
    { type: 'TXT', name: `_dmarc.${ZONE_NAME}`, content: DMARC }
  ];
  if (zoho.verification) records.push({ type: 'TXT', name: ZONE_NAME, content: zoho.verification });
  if (zoho.dkim) records.push({ type: 'TXT', name: `zmail._domainkey.${ZONE_NAME}`, content: zoho.dkim });
  return records;
}

async function api(token, path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.success === false) {
    const detail = body && body.errors ? JSON.stringify(body.errors) : `HTTP ${response.status}`;
    throw new Error(`API Cloudflare ${path} : ${detail}`);
  }
  return body.result;
}

function describe(record) {
  const priority = record.type === 'MX' ? ` (priorité ${record.priority})` : '';
  const value = record.content.length > 60 ? `${record.content.slice(0, 57)}…` : record.content;
  return `${record.type} ${record.name}${priority} → ${value}`;
}

const zoho = await readZohoValues();
const records = desiredRecords(zoho);
const missing = [];
if (!zoho.verification) missing.push('vérification du domaine (TXT @)');
if (!zoho.dkim) missing.push('clé DKIM (TXT zmail._domainkey)');

console.log(`Zone : ${ZONE_NAME} — mode ${apply ? 'APPLICATION' : 'ESSAI (aucune écriture)'}`);
console.log(`Enregistrements visés : ${records.length}`);
for (const record of records) console.log('  •', describe(record));
if (missing.length > 0) {
  console.log('\nÀ fournir depuis Zoho (hosting/.zoho-records.json) :');
  for (const item of missing) console.log('  -', item);
}

if (!apply) {
  console.log('\nEssai terminé. Relance avec --apply pour écrire réellement.');
  process.exit(0);
}

const token = await readToken();
if (!token) {
  console.error('\nJeton absent : définis CLOUDFLARE_API_TOKEN (Zone.DNS:Edit), ou écris-le dans hosting/.cf-token.');
  process.exit(2);
}

const zones = await api(token, `/zones?name=${encodeURIComponent(ZONE_NAME)}`);
const zone = Array.isArray(zones) ? zones[0] : null;
if (!zone) {
  console.error(`\nZone ${ZONE_NAME} introuvable avec ce jeton.`);
  process.exit(3);
}

const existing = await api(token, `/zones/${zone.id}/dns_records?per_page=100`);
const list = Array.isArray(existing) ? existing : [];
let created = 0;
let updated = 0;
let skipped = 0;

for (const record of records) {
  const sameName = list.filter(item => item.type === record.type && item.name === record.name);
  const exact = sameName.find(item => item.content === record.content);
  if (exact) {
    console.log('déjà en place :', describe(record));
    skipped += 1;
    continue;
  }
  // Un seul enregistrement SPF est autorisé : on ne remplace pas un SPF existant à l'aveugle.
  if (record.content.startsWith('v=spf1') && sameName.some(item => item.content.startsWith('v=spf1'))) {
    console.log('SPF existant différent, laissé intact (à fusionner à la main) :', describe(record));
    skipped += 1;
    continue;
  }
  const sameType = record.type === 'MX' ? null : sameName[0];
  if (sameType) {
    await api(token, `/zones/${zone.id}/dns_records/${sameType.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ content: record.content, type: record.type, name: record.name, ttl: 1 })
    });
    console.log('mis à jour :', describe(record));
    updated += 1;
    continue;
  }
  const payload = { type: record.type, name: record.name, content: record.content, ttl: 1 };
  if (record.type === 'MX') payload.priority = record.priority;
  await api(token, `/zones/${zone.id}/dns_records`, { method: 'POST', body: JSON.stringify(payload) });
  console.log('créé :', describe(record));
  created += 1;
}

console.log(`\nTerminé : ${created} créé(s), ${updated} mis à jour, ${skipped} déjà conforme(s).`);
if (missing.length > 0) console.log('Reste à fournir : ' + missing.join(', ') + '.');
