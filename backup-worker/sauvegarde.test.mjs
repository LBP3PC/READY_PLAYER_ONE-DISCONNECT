// Ce que ces tests protègent, et pourquoi :
// le 25/11/2026, une restauration réelle a montré que 21 identifiants d'invention
// sur 22 étaient arrondis dans la sauvegarde (D1 les rend en nombres JavaScript,
// qui perdent les chiffres au-delà de 2^53) et que le schéma n'était pas
// sauvegardé du tout. Sans schéma, les lignes seules ne reconstruisent rien.
//
//   node --test backup-worker/sauvegarde.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runBackup, readTable } from './index.js';

const SCHEMA = `
  CREATE TABLE invention (
    data TEXT NOT NULL,
    id INTEGER GENERATED ALWAYS AS (json_extract(data, '$.InventionId')) VIRTUAL,
    creator_player_id INT
  );
  CREATE TABLE inventory_invention (
    account_id INTEGER NOT NULL,
    invention_id INTEGER NOT NULL,
    acquired_at TEXT NOT NULL,
    PRIMARY KEY (account_id, invention_id)
  );
`;

/** Une D1 de test : node:sqlite derriere l'API `.prepare(...).all()`. */
function baseSimulee() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  // Les valeurs sont ecrites en SQL, jamais en nombre JavaScript : c'est tout l'enjeu.
  db.exec(
    `INSERT INTO invention (data, creator_player_id) VALUES
      ('{"InventionId":1484353954885913309}', 2),
      ('{"InventionId":3789383760817750731}', 2);
     INSERT INTO inventory_invention VALUES
      (2, 1484353954885913309, '2026-11-23T22:10:09.356Z'),
      (2, 3789383760817750731, '2026-11-24T10:00:00.000Z');`
  );
  return {
    prepare: (sql) => ({ all: async () => ({ results: db.prepare(sql).all() }) }),
    _db: db,
  };
}

function kvSimule() {
  const contenu = new Map();
  return {
    contenu,
    async put(cle, valeur) { contenu.set(cle, valeur); },
    async get(cle, type) {
      const valeur = contenu.get(cle);
      if (valeur === undefined) return null;
      if (type === 'arrayBuffer') {
        if (valeur instanceof Uint8Array) {
          return valeur.buffer.slice(valeur.byteOffset, valeur.byteOffset + valeur.byteLength);
        }
        return new TextEncoder().encode(valeur).buffer;
      }
      if (valeur instanceof Uint8Array) return new TextDecoder().decode(valeur);
      return valeur;
    },
    async delete(cle) { contenu.delete(cle); },
    async list({ prefix = '' } = {}) {
      return { keys: [...contenu.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    },
  };
}

const kvJoueurs = {
  async list() { return { keys: [{ name: 'player:2' }], list_complete: true }; },
  async get() { return '{"a":1}'; },
};

async function lireDump(sauvegardes, cle) {
  const octets = sauvegardes.contenu.get(cle);
  return new Response(new Blob([octets]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

test('une table garde les identifiants au-delà de 2^53, chiffre pour chiffre', async () => {
  const db = baseSimulee();
  const { text, rows } = await readTable(db, 'inventory_invention');
  assert.equal(rows, 2);
  assert.ok(text.includes('1484353954885913309'), 'identifiant exact attendu dans le texte');
  assert.ok(text.includes('3789383760817750731'), 'second identifiant exact');
  // Preuve du piège : une fois parse en JavaScript, la valeur est deja fausse.
  assert.notEqual(String(JSON.parse(text)[0].invention_id), '1484353954885913309');
});

test('la sauvegarde emporte le schéma, sans les colonnes calculées à écrire', async () => {
  const DB = baseSimulee();
  const BACKUPS = kvSimule();
  const manifest = await runBackup({ DB, BACKUPS, PLAYER_SETTINGS: kvJoueurs });

  assert.ok(manifest.d1.schema.objects >= 2, 'le schéma est compté dans le manifeste');
  const schemaTexte = await lireDump(BACKUPS, `bk:${manifest.date}:d1:schema`);
  const schema = JSON.parse(schemaTexte);
  assert.ok(schema.some(o => o.name === 'invention' && /CREATE TABLE/.test(o.sql)));
  assert.ok(manifest.d1.tables.invention.rows === 2);
  assert.equal(manifest.d1.totalRows, 4);
});

test('une sauvegarde se restaure dans une base neuve, sans perte ni arrondi', async () => {
  const DB = baseSimulee();
  const BACKUPS = kvSimule();
  const manifest = await runBackup({ DB, BACKUPS, PLAYER_SETTINGS: kvJoueurs });

  // Base neuve : uniquement ce que la sauvegarde contient.
  const schema = JSON.parse(await lireDump(BACKUPS, `bk:${manifest.date}:d1:schema`));
  const neuf = new DatabaseSync(':memory:', { readBigInts: true });
  for (const objet of schema) neuf.exec(String(objet.sql));

  const calculees = (sql) => {
    const noms = new Set();
    for (const definition of sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')')).split(/,(?![^(]*\))/)) {
      if (!/GENERATED\s+ALWAYS/i.test(definition)) continue;
      const nom = definition.match(/^\s*"?([^"\s,()]+)"?/);
      if (nom) noms.add(nom[1]);
    }
    return noms;
  };

  for (const table of Object.keys(manifest.d1.tables)) {
    const texte = await lireDump(BACKUPS, `bk:${manifest.date}:d1:${table}`);
    const lignes = JSON.parse(texte);
    const sql = String(schema.find(o => o.name === table).sql);
    const ecartees = calculees(sql);
    const colonnes = Object.keys(lignes[0]).filter(nom => !ecartees.has(nom));
    // On insere depuis le TEXTE, pas depuis l'objet parse : c'est la seule facon
    // de garder les identifiants exacts.
    for (const brut of texte.slice(1, -1).split(/(?<=\}),(?=\{)/)) {
      const valeurs = colonnes.map(nom => {
        const trouve = new RegExp('"' + nom + '":(null|-?[\\d.]+|"(?:[^"\\\\]|\\\\.)*")').exec(brut);
        if (!trouve) throw new Error(`colonne ${nom} absente de ${table}`);
        const brutValeur = trouve[1];
        // Un nombre part tel quel (chiffres exacts) ; une chaîne passe par JSON
        // pour retrouver son texte, puis par les guillemets simples de SQL.
        if (brutValeur.startsWith('"')) {
          return "'" + JSON.parse(brutValeur).replace(/'/g, "''") + "'";
        }
        return brutValeur;
      });
      neuf.exec(
        `INSERT INTO "${table}" (${colonnes.map(c => '"' + c + '"').join(', ')}) VALUES (${valeurs.join(', ')})`
      );
    }
  }

  const inventaire = neuf.prepare('SELECT CAST(invention_id AS TEXT) AS id FROM inventory_invention ORDER BY id').all();
  assert.deepEqual(inventaire.map(r => r.id), ['1484353954885913309', '3789383760817750731']);

  const inventions = neuf.prepare('SELECT CAST(id AS TEXT) AS id FROM invention ORDER BY id').all();
  assert.deepEqual(inventions.map(r => r.id), ['1484353954885913309', '3789383760817750731']);

  // Le lien inventaire -> invention tient debout apres restauration.
  const orphelins = neuf
    .prepare('SELECT COUNT(*) AS n FROM inventory_invention ii LEFT JOIN invention i ON i.id = ii.invention_id WHERE i.id IS NULL')
    .get().n;
  assert.equal(Number(orphelins), 0);
  neuf.close();
});
