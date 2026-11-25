#!/usr/bin/env node
/**
 * Vérification d'une sauvegarde : on la restaure pour de vrai dans une base
 * SQLite neuve, puis on compare au manifeste et au contenu sauvegardé.
 *
 *   node backup-worker/verifier.mjs                 # dernière sauvegarde
 *   node backup-worker/verifier.mjs 2026-11-26      # date précise
 *   node backup-worker/verifier.mjs --dossier .tmp/verification
 *
 * Ce que le script prouve, et que des comptes de lignes ne prouvent pas :
 *   - le schéma sauvegardé suffit à recréer la base (aucune base vivante lue) ;
 *   - toutes les lignes se rechargent, table par table, sans erreur ;
 *   - le contenu relu est identique au contenu sauvegardé (empreinte SHA-256
 *     par table) ;
 *   - aucun identifiant 64 bits n'a été arrondi.
 *
 * Tout le transport des valeurs se fait en TEXTE et le décodage est fait par
 * SQLite (`json_each`, `json_extract`) : c'est le seul moyen de ne pas perdre
 * les chiffres au-delà de 2^53 en chemin. Une première version lisait le JSON
 * avec JSON.parse et réintroduisait l'arrondi qu'elle était censée détecter.
 *
 * Aucun service n'est touché : `node:sqlite` (fourni par Node 22) suffit.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const WORKER = 'https://recblue-backup.recblue.workers.dev';
const LIMITE_ENTIER = 9007199254740992; // 2^53

const args = process.argv.slice(2);
const optionDossier = args.indexOf('--dossier');
const dossier = optionDossier >= 0 ? args[optionDossier + 1] : '.tmp/verification';
const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || '';

const key = readFileSync(path.join(os.homedir(), '.recblue-backup-key'), 'utf8').trim();
const auth = { 'x-backup-key': key };

/** Rend le texte brut d'une clé de sauvegarde (jamais de JSON.parse ici). */
async function dumpTexte(dateSauvegarde, name) {
  const url = `${WORKER}/dump?date=${dateSauvegarde}&name=${encodeURIComponent(name)}`;
  const response = await fetch(url, { headers: auth });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${name} : HTTP ${response.status}`);
  return response.text();
}

const statusResponse = await fetch(date ? `${WORKER}/?date=${date}` : `${WORKER}/`);
if (!statusResponse.ok) {
  console.error('Aucune sauvegarde pour cette date.');
  process.exit(1);
}
const status = await statusResponse.json();
const manifest = status.manifest || status.latest;
const jour = manifest.date;

console.log(`sauvegarde du ${jour} : ${Object.keys(manifest.d1.tables).length} tables, ${manifest.d1.totalRows} lignes`);

const schemaTexte = await dumpTexte(jour, 'd1:schema');
if (!schemaTexte) {
  console.error('Cette sauvegarde ne contient pas de schéma : elle ne peut pas recréer la base.');
  process.exit(2);
}

mkdirSync(dossier, { recursive: true });
const fichier = path.join(dossier, `verification-${jour}.sqlite`);
rmSync(fichier, { force: true });
const db = new DatabaseSync(fichier, { readBigInts: true });
db.exec('PRAGMA foreign_keys = OFF');

const schema = JSON.parse(schemaTexte);
const tablesSchema = new Map();
for (const objet of schema) {
  db.exec(String(objet.sql));
  if (objet.type === 'table') tablesSchema.set(String(objet.name), String(objet.sql));
}

/** Colonnes calculées : elles se recalculent, on ne les écrit pas. */
function colonnesCalculees(sql) {
  const calculees = new Set();
  const debut = sql.indexOf('(');
  const fin = sql.lastIndexOf(')');
  if (debut < 0 || fin <= debut) return calculees;
  const definitions = [];
  let profondeur = 0;
  let courant = '';
  for (const caractere of sql.slice(debut + 1, fin)) {
    if (caractere === '(') profondeur += 1;
    if (caractere === ')') profondeur -= 1;
    if (caractere === ',' && profondeur === 0) {
      definitions.push(courant);
      courant = '';
      continue;
    }
    courant += caractere;
  }
  definitions.push(courant);
  for (const definition of definitions) {
    if (!/GENERATED\s+ALWAYS/i.test(definition)) continue;
    const nom = definition.match(/^\s*"?([^"\s,()]+)"?/);
    if (nom) calculees.add(nom[1]);
  }
  return calculees;
}

const citer = (nom) => '"' + String(nom).replace(/"/g, '""') + '"';

const problemes = [];
const differentes = [];
const arrondis = [];
let totalLocal = 0;
let identiques = 0;

for (const [table, attendu] of Object.entries(manifest.d1.tables).sort()) {
  const texte = await dumpTexte(jour, 'd1:' + table);
  if (texte === null) {
    problemes.push({ table, raison: 'absente de la sauvegarde' });
    continue;
  }
  const sql = tablesSchema.get(table);
  if (!sql) {
    problemes.push({ table, raison: 'table absente du schéma sauvegardé' });
    continue;
  }
  const ecartees = colonnesCalculees(sql);
  const colonnes = db
    .prepare(`PRAGMA table_xinfo(${citer(table)})`)
    .all()
    .filter(c => c.hidden !== 2 && c.hidden !== 3)
    .map(c => c.name)
    .filter(nom => !ecartees.has(nom));

  try {
    db.exec('BEGIN');
    db.exec(`DELETE FROM ${citer(table)}`);
    if (colonnes.length) {
      const liste = colonnes.map(citer).join(', ');
      const choix = colonnes.map(c => `json_extract(value, '$."${c.replace(/"/g, '""')}"')`).join(', ');
      db.prepare(`INSERT INTO ${citer(table)} (${liste}) SELECT ${choix} FROM json_each(?)`).run(texte);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    problemes.push({ table, raison: error.message });
    continue;
  }

  const relues = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${citer(table)}`).get().n);
  totalLocal += relues;
  if (relues !== attendu.rows) {
    problemes.push({ table, raison: `relu ${relues} lignes sur ${attendu.rows}` });
    continue;
  }

  // Empreinte : les deux côtés sont mis en texte par SQLite, puis tries.
  const empreinte = (objets) => {
    objets.sort();
    return createHash('sha256').update(objets.join('\n')).digest('hex').slice(0, 16);
  };
  const cle = (c) => `'${c.replace(/'/g, "''")}'`;
  const champsLocal = colonnes.map(c => `${cle(c)}, ${citer(c)}`).join(', ');
  const champsSauvegarde = colonnes
    .map(c => `${cle(c)}, json_extract(value, '$."${c.replace(/"/g, '""')}"')`)
    .join(', ');
  const coteLocal = colonnes.length
    ? db.prepare(`SELECT json_object(${champsLocal}) AS objet FROM ${citer(table)}`).all().map(r => r.objet)
    : [];
  const coteSauvegarde = colonnes.length
    ? db.prepare(`SELECT json_object(${champsSauvegarde}) AS objet FROM json_each(?)`).all(texte).map(r => r.objet)
    : [];

  if (empreinte(coteSauvegarde) === empreinte(coteLocal) && relues === attendu.rows) {
    identiques += 1;
  } else {
    differentes.push({ table, attendu: attendu.rows, local: relues });
  }

  // Identifiants au-delà de 2^53 : compares en entiers SQLite, jamais en JavaScript.
  const grands = db
    .prepare(
      'SELECT COUNT(*) AS n FROM json_each(?) t, json_each(t.value) c' +
        " WHERE c.type = 'integer' AND (c.value >= ? OR c.value <= -?)"
    )
    .get(texte, LIMITE_ENTIER, LIMITE_ENTIER).n;
  if (Number(grands) > 0) arrondis.push({ table, nombres: Number(grands) });
}

const nbTables = Object.keys(manifest.d1.tables).length;
console.log(`\ntables sauvegardées            : ${nbTables}`);
console.log(`tables restaurées identiques   : ${identiques}`);
console.log(`lignes attendues / relues      : ${manifest.d1.totalRows} / ${totalLocal}`);
console.log(`entiers au-delà de 2^53        : ${arrondis.reduce((n, a) => n + a.nombres, 0)}`);
for (const a of arrondis.slice(0, 5)) console.log(`  ${a.table} : ${a.nombres}`);
if (differentes.length) {
  console.log(`contenus différents (${differentes.length}) :`);
  for (const d of differentes) console.log(`  ${d.table} : ${d.attendu} / ${d.local}`);
}
if (problemes.length) {
  console.log(`problèmes (${problemes.length}) :`);
  for (const p of problemes) console.log(`  ${p.table} : ${p.raison}`);
}
const integrite = db.prepare('PRAGMA integrity_check').get().integrity_check;
const violations = db.prepare('PRAGMA foreign_key_check').all().length;
console.log(`\nintegrity_check : ${integrite}`);
console.log(`foreign_key_check : ${violations} violation(s)`);
db.close();

const verdictOk =
  identiques === nbTables &&
  totalLocal === manifest.d1.totalRows &&
  problemes.length === 0 &&
  integrite === 'ok';
console.log(`\nVERDICT : ${verdictOk ? 'sauvegarde restaurable sans perte' : 'écarts à corriger (voir ci-dessus)'}`);
writeFileSync(
  path.join(dossier, `bilan-${jour}.json`),
  JSON.stringify(
    { jour, nbTables, identiques, attendues: manifest.d1.totalRows, relues: totalLocal, arrondis, differentes, problemes, integrite, violations, verdictOk },
    null,
    2
  )
);
process.exit(verdictOk ? 0 : 1);
