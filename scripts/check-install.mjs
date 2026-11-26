// Used by Start_Narrative_Engine.bat to skip `npm install` when nothing changed.
//
//   node scripts/check-install.mjs         exit 0 = up to date, 1 = install needed
//   node scripts/check-install.mjs stamp   record the current state after a good install
//
// The stamp is a hash of package.json, package-lock.json and the Node ABI
// version, so it catches dependency changes (pulls, updates) and Node upgrades
// that would break native modules. Content hashes avoid false triggers from
// git touching file times.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(root, 'node_modules');
const stampFile = join(nodeModules, '.narrative-install-stamp');

function currentHash() {
  const hash = createHash('sha256');
  for (const name of ['package.json', 'package-lock.json']) {
    const file = join(root, name);
    hash.update(name);
    hash.update(existsSync(file) ? readFileSync(file) : 'missing');
  }
  hash.update(`node-abi:${process.versions.modules}`);
  return hash.digest('hex');
}

if (process.argv[2] === 'stamp') {
  if (existsSync(nodeModules)) writeFileSync(stampFile, currentHash());
  process.exit(0);
}

if (!existsSync(nodeModules) || !existsSync(stampFile)) process.exit(1);
process.exit(readFileSync(stampFile, 'utf8').trim() === currentHash() ? 0 : 1);
