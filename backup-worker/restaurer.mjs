#!/usr/bin/env node
/**
 * Restauration d'une sauvegarde recblue-backup.
 *
 *   node backup-worker/restaurer.mjs                # dernière sauvegarde
 *   node backup-worker/restaurer.mjs 2026-11-25     # date précise
 *
 * Produit trois fichiers dans le dossier courant :
 *   schema-<date>.sql         → CREATE TABLE / CREATE INDEX, à rejouer en premier
 *   restauration-<date>.sql   → les lignes, à rejouer ensuite
 *   reglages-<date>.json      → contenu des réglages joueurs (KV)
 *
 * Pour une base neuve :
 *   wrangler d1 execute recflare --remote --file schema-<date>.sql
 *   wrangler d1 execute recflare --remote --file restauration-<date>.sql
 *
 * Le fichier de lignes ne contient aucune valeur écrite à la main : chaque
 * INSERT laisse SQLite décoder le JSON (`json_each`, `json_extract`). C'est
 * volontaire. Une version précédente faisait `JSON.parse` puis reconstruisait
 * les valeurs : au-delà de 2^53 (identifiants d'inventions, de comptes) elle
 * écrivait des chiffres arrondis, et l'inventaire restauré pointait vers des
 * inventions inexistantes. Rien ici ne passe par un nombre JavaScript.
 *
 * Deux autres pièges corrigés le 26/11/2026 :
 *   - les colonnes calculées (`GENERATED ALWAYS AS`) ne peuvent pas être
 *     écrites ; les lister fait échouer tout le fichier. On les écarte ;
 *   - le schéma n'était pas sauvegardé : sans lui, les lignes ne reconstruisent
 *     aucune base. Il l'est maintenant (`d1:schema`).
 *
 * La clé de déclenchement est lue dans %USERPROFILE%\.recblue-backup-key.
 */

import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const WORKER = 'https://recblue-backup.recblue.workers.dev';
const keyFile = path.join(os.homedir(), '.recblue-backup-key');
// Une requête SQL confortable : on découpe les lignes par paquets de cette taille.
const TAILLE_PAQUET = 50000;

const key = (await readFile(keyFile, 'utf8')).trim();
if (!key) {
  console.error('Clé de déclenchement vide :', keyFile);
  process.exit(1);
}

const auth = { 'x-backup-key': key };

/** Rend le texte brut d'une clé de sauvegarde, sans jamais le décoder. */
async function fetchTexte(name, { optionnel = false } = {}) {
  const url = `${WORKER}/dump?date=${date}&name=${encodeURIComponent(name)}`;
  let dernierStatut = 0;
  for (let essai = 1; essai <= 3; essai += 1) {
    const response = await fetch(url, { headers: auth });
    dernierStatut = response.status;
    if (response.ok) return response.text();
    if (optionnel && response.status === 404) return null;
    await new Promise(resolve => setTimeout(resolve, 400 * essai));
  }
  if (optionnel) return null;
  throw new Error(`${name} : réponse invalide (${dernierStatut})`);
}

/**
 * Découpe un tableau JSON en ses éléments, en texte brut.
 * Un scanner suffit : on suit l'état « dans une chaîne » pour ne pas couper
 * sur une virgule qui appartient à une valeur.
 */
function elementsTableau(texte) {
  const elements = [];
  const corps = texte.trim();
  if (!corps.startsWith('[')) return elements;
  let profondeur = 0;
  let dansChaine = false;
  let echappe = false;
  let courant = '';
  for (const caractere of corps) {
    if (dansChaine) {
      courant += caractere;
      if (echappe) echappe = false;
      else if (caractere === '\\') echappe = true;
      else if (caractere === '"') dansChaine = false;
      continue;
    }
    if (caractere === '"') { dansChaine = true; courant += caractere; continue; }
    if (caractere === '[' || caractere === '{') { profondeur += 1; if (profondeur > 1) courant += caractere; continue; }
    if (caractere === ']' || caractere === '}') { profondeur -= 1; if (profondeur > 0) courant += caractere; continue; }
    if (profondeur === 1 && (caractere === ' ' || caractere === '\n' || caractere === '\r' || caractere === '\t')) continue;
    if (profondeur === 1 && caractere === ',') {
      if (courant !== '') elements.push(courant);
      courant = '';
      continue;
    }
    courant += caractere;
  }
  if (courant !== '') elements.push(courant);
  return elements;
}

/** Colonnes d'une table lues dans son CREATE TABLE, colonnes calculées exclues. */
function colonnesInsirables(sql) {
  const debut = String(sql).indexOf('(');
  const fin = String(sql).lastIndexOf(')');
  if (debut < 0 || fin <= debut) return [];
  const definitions = [];
  let profondeur = 0;
  let courant = '';
  for (const caractere of String(sql).slice(debut + 1, fin)) {
    if (caractere === '(') profondeur += 1;
    if (caractere === ')') profondeur -= 1;
    if (caractere === ',' && profondeur === 0) { definitions.push(courant); courant = ''; continue; }
    courant += caractere;
  }
  definitions.push(courant);

  const colonnes = [];
  for (const definition of definitions) {
    const texte = definition.trim();
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(texte)) continue;
    if (/GENERATED\s+ALWAYS/i.test(texte)) continue;
    const nom = texte.match(/^"?([^"\s,()]+)"?/);
    if (nom) colonnes.push(nom[1]);
  }
  return colonnes;
}

const wanted = process.argv[2];
const statusUrl = wanted ? `${WORKER}/?date=${wanted}` : `${WORKER}/`;
const statusResponse = await fetch(statusUrl);
if (!statusResponse.ok) {
  console.error('Aucune sauvegarde pour cette date.');
  process.exit(1);
}
const status = await statusResponse.json();
const manifest = status.manifest || status.latest;
const date = manifest.date;
const tables = Object.keys(manifest.d1.tables);

console.log(`sauvegarde du ${date} — ${tables.length} tables, ${manifest.d1.totalRows} lignes`);

// 1. Le schéma : obligatoire pour une base neuve.
const schemaTexte = await fetchTexte('d1:schema', { optionnel: true });
const schema = schemaTexte ? JSON.parse(schemaTexte) : null;
const colonnesParTable = new Map();
if (schema) {
  const instructions = schema
    .map(objet => String(objet.sql || '').trim())
    .filter(Boolean)
    .map(instruction => (instruction.endsWith(';') ? instruction : instruction + ';'));
  await writeFile(`schema-${date}.sql`, instructions.join('\n') + '\n');
  for (const objet of schema) if (objet.type === 'table') colonnesParTable.set(objet.name, colonnesInsirables(objet.sql));
  console.log(`schéma : ${schema.length} objets → schema-${date}.sql`);
}

// 2. Les lignes : un INSERT par paquet, décodage fait par SQLite.
const parts = ['PRAGMA defer_foreign_keys = ON;\n'];
let restored = 0;

for (const table of tables) {
  let texte;
  try {
    texte = await fetchTexte('d1:' + table);
  } catch (error) {
    console.error(`  ${table} : ${error.message}`);
    continue;
  }
  const elements = elementsTableau(texte);
  const quoted = '"' + table.replace(/"/g, '""') + '"';
  // Sans schéma (sauvegarde ancienne), les noms de colonnes viennent de la première
  // ligne : on ne lit que ses clefs, jamais ses valeurs.
  const colonnes = colonnesParTable.get(table) || (elements.length ? Object.keys(JSON.parse(elements[0])) : []);
  parts.push(`DELETE FROM ${quoted};\n`);
  if (elements.length && colonnes.length === 0) {
    console.error(`  ${table} : schéma absent, lignes non converties`);
    continue;
  }
  if (elements.length) {
    const liste = colonnes.map(nom => '"' + nom.replace(/"/g, '""') + '"').join(', ');
    const choix = colonnes
      .map(nom => `json_extract(value, '$."${nom.replace(/"/g, '""')}"')`)
      .join(', ');
    let paquet = [];
    let taille = 0;
    const vider = () => {
      if (paquet.length === 0) return;
      const tableau = '[' + paquet.join(',') + ']';
      parts.push(
        `INSERT INTO ${quoted} (${liste}) SELECT ${choix} FROM json_each('${tableau.replace(/'/g, "''")}');\n`
      );
      paquet = [];
      taille = 0;
    };
    for (const element of elements) {
      paquet.push(element);
      taille += element.length + 1;
      if (taille >= TAILLE_PAQUET) vider();
    }
    vider();
  }
  restored += elements.length;
  process.stdout.write(`\r  ${table.padEnd(28)} ${elements.length} ligne(s)`);
}
process.stdout.write('\n');

// 3. Les réglages joueurs.
const reglagesTexte = await fetchTexte('kv:players', { optionnel: true });
let settingsCount = 0;
if (reglagesTexte) {
  const reglages = JSON.parse(reglagesTexte);
  settingsCount = Object.keys(reglages).length;
  await writeFile(`reglages-${date}.json`, reglagesTexte);
}

await writeFile(`restauration-${date}.sql`, parts.join(''));

console.log(`\nfichiers écrits :`);
if (schema) console.log(`  schema-${date}.sql`);
console.log(`  restauration-${date}.sql  (${restored} lignes)`);
if (settingsCount) console.log(`  reglages-${date}.json     (${settingsCount} clés)`);
console.log(`\nRejouer avec :`);
if (schema) console.log(`  wrangler d1 execute recflare --remote --file schema-${date}.sql`);
console.log(`  wrangler d1 execute recflare --remote --file restauration-${date}.sql`);

if (!schema) {
  console.warn(
    '\nATTENTION : cette sauvegarde ne contient pas de schéma (antérieure au 26/11/2026).' +
      '\nElle ne peut remplir qu’une base qui existe déjà, et ses identifiants 64 bits peuvent' +
      '\nêtre arrondis : vérifier avec `node backup-worker/verifier.mjs <date>`.'
  );
}
