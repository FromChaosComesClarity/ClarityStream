#!/usr/bin/env node
'use strict';
// Builds the Arch packages.
//
// Everything is vendored into the staged tree: the app, the engine, and the
// Electron runtime itself. The result needs no system nodejs and no system
// electron, which is the point. The CLI and the root helper run on the
// bundled Electron through ELECTRON_RUN_AS_NODE.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const name = `clarity-stream-${version}`;

const dist = path.join(root, 'dist');
const stage = path.join(dist, 'stage', name);
const build = path.join(dist, 'pkg');

const say = (m) => console.log(`  ${m}`);

// A stale tree silently ships yesterday's code, so it is rebuilt every time.
fs.rmSync(path.join(dist, 'stage'), { recursive: true, force: true });
fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(build, { recursive: true });

const copy = (from, to) => {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) throw new Error(`missing: ${from}`);
  fs.cpSync(src, path.join(stage, to), { recursive: true, dereference: true });
};

say('staging the app');
fs.mkdirSync(path.join(stage, 'app'), { recursive: true });
for (const p of ['bin', 'packages', 'apps']) copy(p, path.join('app', p));
fs.copyFileSync(path.join(root, 'package.json'), path.join(stage, 'app', 'package.json'));

// The Electron runtime, vendored. This is the bulk of the package and the
// reason the two front ends share one common package rather than each
// carrying a copy.
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
if (!fs.existsSync(electronDist)) {
  console.error('node_modules/electron/dist is missing. Run npm install first.');
  process.exit(1);
}
say('staging the electron runtime');
fs.cpSync(electronDist, path.join(stage, 'electron'), { recursive: true, dereference: true });

say('staging packaging files');
copy('packaging', 'packaging');
for (const f of ['LICENSE', 'README.md']) {
  if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(stage, f));
}

say('making the tarball');
execFileSync('tar', ['-czf', path.join(build, `${name}.tar.gz`), '-C', path.join(dist, 'stage'), name],
  { stdio: 'inherit' });

// The PKGBUILD carries the version, so it is written from package.json rather
// than kept in sync by hand.
const pkgbuild = fs.readFileSync(path.join(root, 'packaging', 'PKGBUILD'), 'utf8')
  .replace(/^pkgver=.*$/m, `pkgver=${version}`);
fs.writeFileSync(path.join(build, 'PKGBUILD'), pkgbuild);

say('running makepkg');
try {
  execFileSync('makepkg', ['-f', '--noconfirm'], { cwd: build, stdio: 'inherit' });
} catch {
  console.error('\nmakepkg failed. The staged tree is in dist/pkg if you want to look.');
  process.exit(1);
}

const built = fs.readdirSync(build).filter((f) => f.endsWith('.pkg.tar.zst'));
console.log('\nBuilt:');
for (const f of built) {
  const size = (fs.statSync(path.join(build, f)).size / (1024 * 1024)).toFixed(1);
  console.log(`  ${f}  ${size} MB`);
}
const host = built.filter((f) => /common|^clarity-stream-0|clarity-stream-\d/.test(f) && !/client/.test(f));
const client = built.filter((f) => /common|client/.test(f));
console.log('\nInstall the host with:');
console.log(`  sudo pacman -U ${host.map((f) => `dist/pkg/${f}`).join(' ')}`);
console.log('Install the client with:');
console.log(`  sudo pacman -U ${client.map((f) => `dist/pkg/${f}`).join(' ')}`);
