/**
 * recblue-backup — sauvegarde quotidienne de la base D1 et des réglages joueurs.
 *
 * Principe :
 *   - un cron quotidien lit toute la base D1 (table par table) et tout le
 *     namespace KV des réglages joueurs ;
 *   - chaque table est compressée (gzip) puis écrite dans le namespace BACKUPS
 *     sous la clé  bk:<AAAA-MM-JJ>:d1:<table> ;
 *   - le schéma (CREATE TABLE / CREATE INDEX) va sous bk:<date>:schema : sans lui
 *     une sauvegarde n'est qu'un tas de lignes et ne peut pas reconstruire la base ;
 *   - les réglages joueurs vont sous  bk:<AAAA-MM-JJ>:kv:players ;
 *   - un manifeste résume la sauvegarde du jour (bk:<date>:manifest) et
 *     "latest" pointe toujours vers la dernière réussie ;
 *   - les sauvegardes de plus de RETENTION_DAYS jours sont supprimées.
 *
 * Le worker ne modifie jamais les données du jeu : D1 et PLAYER_SETTINGS sont
 * ouverts en lecture seule, les écritures ne vont que dans BACKUPS.
 *
 * Déclenchement manuel (test) : POST /run avec l'en-tête x-backup-key.
 */

const RETENTION_DAYS = 7;
const ROWS_PER_QUERY = 500;
const KV_PREFIX = 'player:';
const KEY_ROOT = 'bk:';

const isoDate = (date = new Date()) => date.toISOString().slice(0, 10);

async function gzipText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Liste les tables applicatives de la base. */
async function listTables(db) {
  const result = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'" +
        " AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
    )
    .all();
  return (result.results || []).map(row => row.name).filter(Boolean);
}

const citer = (nom, guillemet) => guillemet + String(nom).replaceAll(guillemet, guillemet + guillemet) + guillemet;

/** Colonnes d'une table : nom, type déclaré et caractère calculé. */
async function listColumns(db, table) {
  const result = await db.prepare(`PRAGMA table_xinfo(${citer(table, '"')})`).all();
  let rows = result.results || [];
  if (rows.length === 0) {
    const bis = await db.prepare(`SELECT name, type, hidden FROM pragma_table_xinfo(${citer(table, "'")})`).all();
    rows = bis.results || [];
  }
  return rows.map(row => ({
    nom: String(row.name),
    type: String(row.type || '').toUpperCase(),
    calculee: Number(row.hidden) === 2 || Number(row.hidden) === 3,
  }));
}

/**
 * Lit une table entière et rend son JSON tel que SQLite l'écrit.
 *
 * Passer par `json_object` n'est pas un détail de style : D1 rend les entiers
 * comme des nombres JavaScript, et au-delà de 2^53 (identifiants d'inventions,
 * de comptes…) ces nombres sont arrondis. Le 25/11/2026, 21 des 22 identifiants
 * d'invention dépassant cette limite étaient faux dans la sauvegarde, et
 * l'inventaire restauré pointait vers des inventions inexistantes. Ici les
 * chiffres ne quittent jamais SQLite : ils arrivent en texte, exacts.
 *
 * Les colonnes BLOB ne sont pas gérées (aucune dans cette base) : mieux vaut un
 * échec visible qu'une conversion silencieuse.
 */
async function readTable(db, table) {
  const colonnes = await listColumns(db, table);
  const blob = colonnes.find(c => c.type === 'BLOB');
  if (blob) throw new Error(`colonne BLOB non gérée : ${table}.${blob.nom}`);

  const total = Number(
    ((await db.prepare(`SELECT COUNT(*) AS n FROM ${citer(table, '"')}`).all()).results || [{}])[0].n || 0
  );
  if (colonnes.length === 0 || total === 0) return { text: '[]', rows: 0 };

  const paires = colonnes.map(c => `${citer(c.nom, "'")}, ${citer(c.nom, '"')}`).join(', ');
  const morceaux = [];
  for (let offset = 0; offset < total; offset += ROWS_PER_QUERY) {
    const page = await db
      .prepare(
        `SELECT json_group_array(json_object(${paires})) AS bloc` +
          ` FROM (SELECT * FROM ${citer(table, '"')} LIMIT ${ROWS_PER_QUERY} OFFSET ${offset})`
      )
      .all();
    const bloc = (page.results || [])[0] ? (page.results || [])[0].bloc : null;
    const texte = typeof bloc === 'string' ? bloc : '[]';
    if (texte === '[]') break;
    const dedans = texte.slice(1, -1);
    if (dedans !== '') morceaux.push(dedans);
  }
  return { text: '[' + morceaux.join(',') + ']', rows: total };
}

/** Le schéma complet, sans les tables internes de D1 ni celles de SQLite. */
async function readSchema(db) {
  const result = await db
    .prepare(
      'SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL' +
        " AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type DESC, name"
    )
    .all();
  const objets = (result.results || []).map(row => ({
    type: row.type,
    name: row.name,
    sql: row.sql,
  }));
  return { objets, text: JSON.stringify(objets) };
}

/** Lit toutes les réglages joueurs du namespace KV. */
async function readPlayerSettings(namespace, prefix) {
  const entries = {};
  let cursor;
  do {
    const page = await namespace.list({ prefix, cursor });
    for (const key of page.keys) {
      entries[key.name] = await namespace.get(key.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return entries;
}

/** Supprime les sauvegardes plus anciennes que la fenêtre de rétention. */
async function pruneOldBackups(namespace, today) {
  const cutoff = new Date(today + 'T00:00:00Z');
  cutoff.setUTCDate(cutoff.getUTCDate() - (RETENTION_DAYS - 1));
  const oldestKept = isoDate(cutoff);

  const removed = [];
  let cursor;
  do {
    const page = await namespace.list({ prefix: KEY_ROOT, cursor });
    for (const key of page.keys) {
      const match = /^bk:(\d{4}-\d{2}-\d{2}):/.exec(key.name);
      if (match && match[1] < oldestKept) {
        await namespace.delete(key.name);
        removed.push(key.name);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return removed;
}

async function runBackup(env) {
  const startedAt = Date.now();
  const today = isoDate();
  const manifest = {
    date: today,
    createdAt: new Date().toISOString(),
    retentionDays: RETENTION_DAYS,
    d1: { tables: {}, totalRows: 0, bytes: 0, schema: { objects: 0, bytes: 0 } },
    kv: { prefix: KV_PREFIX, keys: 0, bytes: 0 },
  };

  // 1. Le schéma d'abord : c'est lui qui rend la sauvegarde reconstructible.
  const schema = await readSchema(env.DB);
  const schemaGz = await gzipText(schema.text);
  // Meme convention que les tables (`bk:<date>:d1:<nom>`) : la route /dump n'a
  // qu'un seul prefixe a connaitre, et aucun table ne s'appelle « schema ».
  await env.BACKUPS.put(`${KEY_ROOT}${today}:d1:schema`, schemaGz);
  manifest.d1.schema = { objects: schema.objets.length, bytes: schemaGz.byteLength };

  // 2. Base D1, table par table.
  const tables = await listTables(env.DB);
  for (const table of tables) {
    const { text, rows } = await readTable(env.DB, table);
    const compressed = await gzipText(text);
    await env.BACKUPS.put(`${KEY_ROOT}${today}:d1:${table}`, compressed);
    manifest.d1.tables[table] = { rows, bytes: compressed.byteLength };
    manifest.d1.totalRows += rows;
    manifest.d1.bytes += compressed.byteLength;
  }

  // 3. Réglages joueurs.
  const settings = await readPlayerSettings(env.PLAYER_SETTINGS, KV_PREFIX);
  const settingsCompressed = await gzipText(JSON.stringify(settings));
  await env.BACKUPS.put(`${KEY_ROOT}${today}:kv:players`, settingsCompressed);
  manifest.kv.keys = Object.keys(settings).length;
  manifest.kv.bytes = settingsCompressed.byteLength;

  manifest.durationMs = Date.now() - startedAt;

  // 4. Manifeste du jour, puis référence "latest".
  await env.BACKUPS.put(`${KEY_ROOT}${today}:manifest`, JSON.stringify(manifest));
  await env.BACKUPS.put('latest', JSON.stringify(manifest));

  // 5. Rotation des anciennes copies.
  manifest.pruned = await pruneOldBackups(env.BACKUPS, today);
  return manifest;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/run') {
    if (request.method !== 'POST') {
      return new Response('Méthode non autorisée.', { status: 405 });
    }
    const given = request.headers.get('x-backup-key') || '';
    if (!env.BACKUP_KEY || given !== env.BACKUP_KEY) {
      return new Response('Non autorisé.', { status: 401 });
    }
    try {
      const manifest = await runBackup(env);
      return Response.json({ ok: true, manifest });
    } catch (error) {
      return Response.json({ ok: false, error: String(error && error.stack || error) }, { status: 500 });
    }
  }

  // Restitution d'une sauvegarde : réservé à la clé de déclenchement.
  if (url.pathname === '/dump') {
    const given = request.headers.get('x-backup-key') || '';
    if (!env.BACKUP_KEY || given !== env.BACKUP_KEY) {
      return new Response('Non autorisé.', { status: 401 });
    }
    const date = url.searchParams.get('date') || '';
    const name = url.searchParams.get('name') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(d1:[A-Za-z0-9_-]+|kv:players)$/.test(name)) {
      return new Response('Paramètres invalides.', { status: 400 });
    }
    const raw = await env.BACKUPS.get(`${KEY_ROOT}${date}:${name}`, 'arrayBuffer');
    if (!raw) return new Response('Sauvegarde introuvable.', { status: 404 });
    const text = await new Response(
      new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))
    ).text();
    return new Response(text, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  // État d'une sauvegarde : aucune donnée sensible, seulement des tailles.
  const wantedDate = url.searchParams.get('date');
  if (wantedDate && /^\d{4}-\d{2}-\d{2}$/.test(wantedDate)) {
    const manifest = await env.BACKUPS.get(`${KEY_ROOT}${wantedDate}:manifest`);
    if (!manifest) return Response.json({ ready: false, message: 'Aucune sauvegarde pour cette date.' }, { status: 404 });
    return Response.json({ ready: true, manifest: JSON.parse(manifest) }, { headers: { 'cache-control': 'no-store' } });
  }

  const latest = await env.BACKUPS.get('latest');
  if (!latest) {
    return Response.json({ ready: false, message: 'Aucune sauvegarde enregistrée pour le moment.' });
  }
  return Response.json({ ready: true, latest: JSON.parse(latest) }, {
    headers: { 'cache-control': 'no-store' },
  });
}

export { runBackup, readTable, readSchema };

export default {
  async scheduled(controller, env, ctx) {
    try {
      const manifest = await runBackup(env);
      console.log('sauvegarde terminee', JSON.stringify(manifest));
    } catch (error) {
      const message = String(error && error.stack || error);
      console.error('sauvegarde echouee', message);
      try {
        await env.BACKUPS.put(`${KEY_ROOT}${isoDate()}:error`, message.slice(0, 4000));
      } catch (secondary) {
        console.error('impossible d enregistrer l erreur', String(secondary));
      }
    }
  },

  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
