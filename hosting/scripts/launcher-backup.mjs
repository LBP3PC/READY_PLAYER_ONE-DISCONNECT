#!/usr/bin/env node
// Sauvegarde complète (site + launcher + bot) découpée sous la limite de 25 Mio des
// fichiers statiques Cloudflare, régénérée à chaque nouveau build du launcher.
//
// À chaque exécution :
//   1. lit la version dans launcher-app/RecBlueLauncher.cs (AssemblyVersion) ;
//   2. aligne hosting/public/download/REC-BLUE-Launcher.exe sur le build courant ;
//   3. crée backups/REC-BLUE-site-launcher-<version>.zip (hosting, launcher-app,
//      discord-status ; sans node_modules, .wrangler, *.log ni anciens morceaux) ;
//   4. découpe en morceaux de 20 Mio et les dépose dans hosting/public/download/,
//      avec la fiche d'empreintes REC-BLUE-sauvegarde-<version>.sha256.txt ;
//   5. réécrit le bloc <!-- launcher-backup:start/end --> de hosting/public/index.html ;
//   6. publie le site avec --deploy.
//
// Usage :
//   node hosting/scripts/launcher-backup.mjs            # fichiers locaux seulement
//   node hosting/scripts/launcher-backup.mjs --deploy   # ... puis publie (wrangler)
//   node hosting/scripts/launcher-backup.mjs --force    # reconstruit même si la version
//                                                       # est déjà découpée sur le site
//
// Le script est idempotent : relancé sans nouveau build, il ne reconstruit pas l'archive
// et ne réécrit rien.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, readdir, unlink, mkdir, rm, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const deploy = args.includes('--deploy');
const force = args.includes('--force');

const SOURCE_CS = path.join(root, 'launcher-app', 'RecBlueLauncher.cs');
const SOURCE_EXE = path.join(root, 'launcher-app', 'REC-BLUE-Launcher.exe');
const DOWNLOAD_DIR = path.join(root, 'hosting', 'public', 'download');
const INDEX_HTML = path.join(root, 'hosting', 'public', 'index.html');
const BACKUPS = path.join(root, 'backups');
const WRANGLER = path.join(root, '.tools', 'wr', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const TAR = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe');

const START = '<!-- launcher-backup:start -->';
const END = '<!-- launcher-backup:end -->';
const PART_SIZE = 20 * 1024 * 1024;
const SOURCES = ['hosting', 'launcher-app', 'discord-status'];
const PREFIX = 'REC-BLUE-sauvegarde-';
const SKIP_DIRS = new Set(['node_modules', '.wrangler', '.git']);

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const shortHash = hash => `${hash.slice(0, 8)}…${hash.slice(-5)}`;
const canonical = version => version.replace(/\.0$/, '');
const sheetName = version => `${PREFIX}${canonical(version)}.sha256.txt`;
const partName = (version, index, count) =>
  `${PREFIX}${canonical(version)}-part${index}-de${count}.zip`;

function fail(message) {
  console.error(`ERREUR : ${message}`);
  process.exit(1);
}

function skipped(name) {
  return SKIP_DIRS.has(name) || name.endsWith('.log') || name.startsWith(PREFIX);
}

async function readVersion() {
  if (!existsSync(SOURCE_CS)) fail(`source introuvable : ${path.relative(root, SOURCE_CS)}`);
  const source = await readFile(SOURCE_CS, 'utf8');
  const match = source.match(/AssemblyVersion\("([^"]+)"\)/);
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

// Le bouton PC du site doit rester le build courant, sinon la sauvegarde figerait
// l'ancien exe et la page pointerait sur deux versions différentes.
async function syncButtonExe() {
  if (!existsSync(SOURCE_EXE)) {
    console.log('ATTENTION : launcher-app/REC-BLUE-Launcher.exe absent, bouton PC laissé tel quel.');
    return;
  }
  const buffer = await readFile(SOURCE_EXE);
  const target = path.join(DOWNLOAD_DIR, 'REC-BLUE-Launcher.exe');
  const updated = await writeIfChanged(target, buffer);
  console.log(`bouton PC       : ${updated ? 'mis à jour' : 'déjà à jour'} (${buffer.length} octets)`);
}

function zipEntries(zipPath) {
  const result = spawnSync(TAR, ['-tf', zipPath], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

async function createZipFallback(zipPath) {
  const stage = path.join(BACKUPS, '.stage');
  await rm(stage, { recursive: true, force: true });
  for (const source of SOURCES) {
    const from = path.join(root, source);
    if (!existsSync(from)) continue;
    await cp(from, path.join(stage, source), {
      recursive: true,
      filter: src => !skipped(path.basename(src))
    });
  }
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`],
    { stdio: 'inherit' });
  await rm(stage, { recursive: true, force: true });
  if (result.status !== 0) fail('création du zip impossible (tar et PowerShell ont échoué).');
}

async function createZip(zipPath) {
  if (existsSync(zipPath)) await rm(zipPath, { force: true });
  await mkdir(BACKUPS, { recursive: true });
  const viable = existsSync(TAR) && !SKIP_DIRS.has('');
  if (viable) {
    const tarArgs = ['-a', '-c', '-f', zipPath];
    for (const dir of SKIP_DIRS) tarArgs.push(`--exclude=${dir}`);
    tarArgs.push('--exclude=*.log', `--exclude=${PREFIX}*`, '--exclude=*/' + PREFIX + '*');
    const result = spawnSync(TAR, tarArgs.concat(SOURCES), { cwd: root, stdio: 'inherit' });
    if (result.status === 0) {
      const entries = zipEntries(zipPath);
      const forbidden = (entries || []).filter(entry =>
        entry.split(/[\\/]/).some(part => skipped(part)));
      if (forbidden.length === 0) return;
      console.log(`tar a laissé ${forbidden.length} entrée(s) indésirable(s) : repli sur PowerShell.`);
    }
  }
  await createZipFallback(zipPath);
}

async function listParts(version) {
  const names = await readdir(DOWNLOAD_DIR);
  return names
    .filter(name => name.startsWith(`${PREFIX}${canonical(version)}-part`) && name.endsWith('.zip'))
    .sort((left, right) => {
      const number = name => Number((name.match(/-part(\d+)-/) || [0, 0])[1]);
      return number(left) - number(right);
    });
}

async function removeStale(keep) {
  const names = await readdir(DOWNLOAD_DIR);
  const removed = [];
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    if (keep.has(name)) continue;
    await unlink(path.join(DOWNLOAD_DIR, name));
    removed.push(name);
  }
  return removed;
}

function checksumSheet(version, total, totalHash, parts) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const lines = [
    `REC BLUE - sauvegarde du site et du launcher (build ${version})`,
    `Archive complète après recollage : REC-BLUE-site-launcher-${canonical(version)}.zip`,
    `Taille de l'archive complète : ${total} octets`,
    `SHA-256 de l'archive complète : ${totalHash}`,
    '',
    'Recoller sous Windows (PowerShell, dans le dossier des morceaux) :',
    `  ${rejoinCommand(parts)}`,
    `Puis : Get-FileHash REC-BLUE-sauvegarde.zip -Algorithm SHA256`,
    `La valeur doit être : ${totalHash}`,
    '',
    ...parts.map(part => `${part.hash}  ${part.name}`)
  ];
  return lines.join('\r\n') + '\r\n';
}

const rejoinCommand = parts =>
  `Get-Content ${parts.map(part => part.name).join(',')} -Encoding Byte -ReadCount 0 | Set-Content REC-BLUE-sauvegarde.zip -Encoding Byte`;

function renderBlock(version, totalHash, parts) {
  const links = parts
    .map((part, index) => `<a href="download/${part.name}" download>Partie ${index + 1}</a>`)
    .join(' · ');
  const lines = [
    START,
    `<p class="installation-archive">Sauvegarde complète (parties à recoller avant ouverture) : ${links} · <a href="download/${sheetName(version)}" download>SHA-256</a> · <code>SHA-256 ${shortHash(totalHash)}</code></p>`,
    '<div class="installation-archive">',
    '<p>Comment recoller les parties : télécharge toutes les parties dans le même dossier.</p>',
    '<p>Ouvre ensuite PowerShell dans ce dossier et colle cette commande :</p>',
    `<p><code>${rejoinCommand(parts)}</code></p>`,
    `<p>Le fichier obtenu est l’archive complète ; son SHA-256 doit être : <code>${shortHash(totalHash)}</code></p>`,
    '</div>',
    END
  ];
  return lines.join('\r\n');
}

async function updatePage(version, totalHash, parts) {
  const html = await readFile(INDEX_HTML, 'utf8');
  const start = html.indexOf(START);
  const end = html.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    fail(`marqueurs ${START} / ${END} absents de hosting/public/index.html`);
  }
  const next = html.slice(0, start) + renderBlock(version, totalHash, parts) + html.slice(end + END.length);
  return writeIfChanged(INDEX_HTML, next);
}

async function main() {
  const version = await readVersion();
  await mkdir(DOWNLOAD_DIR, { recursive: true });
  await syncButtonExe();

  const existing = await listParts(version);
  let totalHash = '';
  let totalSize = 0;
  let rebuilt = false;

  const sheetPath = path.join(DOWNLOAD_DIR, sheetName(version));
  const known = existing.length > 0 && existsSync(sheetPath)
    ? (await readFile(sheetPath, 'utf8')).match(/SHA-256 de l'archive complète : ([0-9a-f]{64})/)
    : null;

  if (existing.length > 0 && known && !force) {
    totalHash = known[1];
    const firstZip = path.join(BACKUPS, `REC-BLUE-site-launcher-${canonical(version)}.zip`);
    if (existsSync(firstZip)) totalSize = (await readFile(firstZip)).length;
  } else {
    const zipPath = path.join(BACKUPS, `REC-BLUE-site-launcher-${canonical(version)}.zip`);
    console.log('Création de l\'archive complète…');
    await createZip(zipPath);
    const buffer = await readFile(zipPath);
    totalSize = buffer.length;
    totalHash = sha256(buffer);

    const count = Math.max(1, Math.ceil(buffer.length / PART_SIZE));
    const parts = [];
    for (let index = 0; index < count; index += 1) {
      const slice = buffer.subarray(index * PART_SIZE, (index + 1) * PART_SIZE);
      const name = partName(version, index + 1, count);
      await writeFile(path.join(DOWNLOAD_DIR, name), slice);
      parts.push({ name, size: slice.length, hash: sha256(slice) });
    }

    const names = new Set(parts.map(part => part.name).concat(sheetName(version)));
    const removed = await removeStale(names);
    if (removed.length) console.log(`anciens morceaux  : ${removed.length} supprimé(s)`);

    await writeFile(sheetPath, checksumSheet(version, totalSize, totalHash, parts));
    console.log(`archive           : ${path.relative(root, zipPath)} (${totalSize} octets, SHA-256 ${totalHash})`);
    console.log(`morceaux          : ${parts.map(part => `${part.name} (${part.size})`).join(', ')}`);
    rebuilt = true;
  }

  const parts = [];
  for (const name of existing.length ? existing : await listParts(version)) {
    const full = path.join(DOWNLOAD_DIR, name);
    const buffer = await readFile(full);
    parts.push({ name, size: buffer.length, hash: sha256(buffer) });
  }
  if (!parts.length) fail('aucun morceau de sauvegarde trouvé.');

  if (!totalHash) {
    const sheet = await readFile(sheetPath, 'utf8');
    const match = sheet.match(/SHA-256 de l'archive complète : ([0-9a-f]{64})/);
    if (!match) fail(`empreinte absente de ${sheetName(version)}`);
    totalHash = match[1];
  }

  const pageChanged = await updatePage(version, totalHash, parts);
  console.log(`sauvegarde        : ${rebuilt ? 'régénérée' : 'déjà à jour'} — ${parts.length} morceau(x), SHA-256 ${totalHash}`);
  console.log(`ligne du site     : ${pageChanged ? 'régénérée' : 'déjà à jour'}`);

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
    console.error('Publication échouée : les fichiers sont à jour localement mais pas en ligne.');
    process.exit(result.status ?? 1);
  }
  console.log('Site publié.');
}

main().catch(error => fail(error && error.stack ? error.stack : String(error)));
