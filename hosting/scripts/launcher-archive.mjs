#!/usr/bin/env node
// Archive le launcher compilé sur le site et régénère la ligne « Versions archivées ».
//
// À chaque build du launcher :
//   1. lit la version dans launcher-app/RecBlueLauncher.cs (AssemblyVersion) ;
//   2. copie REC-BLUE-Launcher.exe vers hosting/public/download/REC-BLUE-Launcher-<version>.exe
//      (rien n'est réécrit si les octets sont identiques) ;
//   3. écrit la fiche d'empreinte REC-BLUE-Launcher-<version>.sha256.txt
//      (seulement quand le binaire change, pour ne pas réécrire l'horodatage) ;
//   4. réécrit le bloc <!-- launcher-archive:start/end --> de hosting/public/index.html
//      avec une entrée par build archivé, la plus récente en tête.
//
// Usage :
//   node hosting/scripts/launcher-archive.mjs            # met à jour les fichiers locaux
//   node hosting/scripts/launcher-archive.mjs --deploy   # ... puis publie le site (wrangler)
//
// Le script est idempotent : relancé sans nouveau build, il n'écrit rien et le signale.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const deploy = args.includes('--deploy');

const SOURCE_EXE = path.join(root, 'launcher-app', 'REC-BLUE-Launcher.exe');
const SOURCE_CS = path.join(root, 'launcher-app', 'RecBlueLauncher.cs');
const DOWNLOAD_DIR = path.join(root, 'hosting', 'public', 'download');
const INDEX_HTML = path.join(root, 'hosting', 'public', 'index.html');
const WRANGLER = path.join(root, '.tools', 'wr', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const START = '<!-- launcher-archive:start -->';
const END = '<!-- launcher-archive:end -->';

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const shortHash = hash => `${hash.slice(0, 8)}…${hash.slice(-5)}`;
// Nom canonique : la version d'assemblage sans son dernier ".0" (2026.11.8.0 -> 2026.11.8).
const canonicalVersion = version => version.replace(/\.0$/, '');
const buildName = version => `REC-BLUE-Launcher-${canonicalVersion(version)}.exe`;
const archivePattern = /^REC-BLUE-Launcher-(\d{4}\.\d+\.\d+(?:\.\d+)?)\.exe$/;

function fail(message) {
  console.error(`ERREUR : ${message}`);
  process.exit(1);
}

async function readVersion() {
  if (!existsSync(SOURCE_CS)) fail(`source introuvable : ${path.relative(root, SOURCE_CS)}`);
  const cs = await readFile(SOURCE_CS, 'utf8');
  const match = cs.match(/AssemblyVersion\("([^"]+)"\)/);
  if (!match) fail('AssemblyVersion introuvable dans RecBlueLauncher.cs');
  return match[1];
}

async function writeIfChanged(file, content) {
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (existsSync(file)) {
    const current = await readFile(file);
    if (current.equals(next)) return false;
  }
  await writeFile(file, next);
  return true;
}

function checksumSheet(version, size, hash) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `REC BLUE Launcher - build ${version}
Fichier  : ${buildName(version)}
Taille   : ${size} octets
SHA-256  : ${hash}
Verifie  : ${stamp}
`.replace(/\n/g, '\r\n');
}

async function archiveBuild(version) {
  if (!existsSync(SOURCE_EXE)) fail(`launcher compilé introuvable : ${path.relative(root, SOURCE_EXE)}`);
  const buffer = await readFile(SOURCE_EXE);
  const hash = sha256(buffer);
  const target = path.join(DOWNLOAD_DIR, buildName(version));
  const copied = await writeIfChanged(target, buffer);
  const sheet = path.join(DOWNLOAD_DIR, `REC-BLUE-Launcher-${canonicalVersion(version)}.sha256.txt`);
  // La fiche n'est réécrite que si le binaire change : l'horodatage reste celui de la
  // vérification réelle, sinon chaque exécution déclencherait un nouvel envoi d'asset.
  let sheetWritten = false;
  const unchanged = existsSync(sheet)
    && (await readFile(sheet, 'utf8')).includes(`SHA-256  : ${hash}`)
    && (await readFile(sheet, 'utf8')).includes(`Taille   : ${buffer.length} octets`);
  if (!unchanged) {
    await writeFile(sheet, checksumSheet(version, buffer.length, hash));
    sheetWritten = true;
  }
  return { version, hash, size: buffer.length, copied, sheetWritten };
}

async function listArchives() {
  const names = await readdir(DOWNLOAD_DIR);
  const unique = new Map();
  for (const name of names) {
    const match = name.match(archivePattern);
    if (!match) continue;
    const version = canonicalVersion(match[1]);
    const preferred = name === buildName(version);
    if (unique.has(version) && !preferred) continue;
    const full = path.join(DOWNLOAD_DIR, name);
    const info = await stat(full);
    const hash = sha256(await readFile(full));
    unique.set(version, { version, name, size: info.size, hash, time: info.mtimeMs });
  }
  const builds = [...unique.values()];
  return builds.sort((a, b) => {
    const left = a.version.split('.').map(Number);
    const right = b.version.split('.').map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const diff = (right[index] ?? 0) - (left[index] ?? 0);
      if (diff) return diff;
    }
    return b.time - a.time;
  });
}

function renderBlock(builds) {
  const entries = builds
    .map(build => `<a href="download/${build.name}" download>${build.name}</a> · <code>SHA-256 ${shortHash(build.hash)}</code>`)
    .join(' · ');
  return `${START}\r\n<p class="installation-archive">Versions archivées : ${entries}</p>\r\n${END}`;
}

async function updatePage(builds) {
  const html = await readFile(INDEX_HTML, 'utf8');
  const start = html.indexOf(START);
  const end = html.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    fail(`marqueurs ${START} / ${END} absents de hosting/public/index.html`);
  }
  const next = html.slice(0, start) + renderBlock(builds) + html.slice(end + END.length);
  return writeIfChanged(INDEX_HTML, next);
}

async function main() {
  const version = await readVersion();
  const build = await archiveBuild(version);
  const builds = await listArchives();
  const pageChanged = await updatePage(builds);
  const latest = builds[0];
  const strays = builds.filter(entry => entry.version !== version);

  console.log(`build courant      : ${version} -> ${buildName(version)} (${build.size} octets, SHA-256 ${build.hash})`);
  console.log(`archive versionnée : ${build.copied ? 'créée/mise à jour' : 'déjà à jour'} ${buildName(version)}`);
  console.log(`fiche d'empreinte  : ${build.sheetWritten ? 'mise à jour' : 'déjà à jour'} REC-BLUE-Launcher-${canonicalVersion(version)}.sha256.txt`);
  console.log(`ligne du site      : ${pageChanged ? 'régénérée' : 'déjà à jour'} (${builds.length} build(s) listé(s))`);
  if (strays.length) {
    console.log(`builds conservés   : ${strays.map(entry => entry.version).join(', ')}`);
  }

  const plainExe = path.join(DOWNLOAD_DIR, 'REC-BLUE-Launcher.exe');
  if (existsSync(plainExe)) {
    const plainHash = sha256(await readFile(plainExe));
    if (plainHash !== build.hash) {
      console.log(`ATTENTION : download/REC-BLUE-Launcher.exe (${shortHash(plainHash)}) ne correspond pas au build ${version}.`);
    }
  } else {
    console.log('ATTENTION : download/REC-BLUE-Launcher.exe est absent (le bouton PC pointerait dans le vide).');
  }

  if (!deploy) return;

  if (!existsSync(WRANGLER)) {
    console.error(`Publication impossible : wrangler absent (${path.relative(root, WRANGLER)}).`);
    process.exit(2);
  }
  console.log('Publication du site (wrangler deploy)…');
  const result = spawnSync(process.execPath, [WRANGLER, 'deploy', '--config', 'hosting/wrangler.jsonc'], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    console.error('Publication échouée : la ligne du site est à jour localement mais pas en ligne.');
    process.exit(result.status ?? 1);
  }
  console.log('Site publié.');
}

main().catch(error => fail(error && error.stack ? error.stack : String(error)));
