// Global-install uninstall fixes.
//
// M15: the uninstall guard was a pure SUFFIX test, so any manifest path
//      ending in `skills/archgen` was removed — including paths outside the
//      known harness directories; a skipped entry was discarded together with
//      the manifest; and an edited copy-mode install was removed with no
//      backup at all.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGlobal, uninstallGlobal, MANIFEST_NAME } from '../../lib/install.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENDOR = join(CLI, 'vendor', 'skills', 'archgen');
const VERSION = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')).version;

let home, pkgRoot, outside;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ag-inst-fix-home-'));
  outside = mkdtempSync(join(tmpdir(), 'ag-inst-fix-out-'));
  pkgRoot = mkdtempSync(join(tmpdir(), 'ag-inst-fix-pkg-'));
  mkdirSync(join(pkgRoot, 'vendor', 'skills'), { recursive: true });
  cpSync(VENDOR, join(pkgRoot, 'vendor', 'skills', 'archgen'), { recursive: true });
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'archgen-skill', version: VERSION }));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(pkgRoot, { recursive: true, force: true });
});

test('M15: a manifest path outside the known harness dirs is never removed', () => {
  // A path that ends in skills/archgen but lives outside every harness dir.
  const victim = join(outside, 'skills', 'archgen');
  mkdirSync(join(outside, 'skills'), { recursive: true });
  cpSync(VENDOR, victim, { recursive: true });
  writeFileSync(join(home, MANIFEST_NAME), `copy\t${victim}\n`);

  const r = uninstallGlobal(home);
  assert.equal(r.removed, 0, 'nothing outside the harness dirs may be removed');
  assert.equal(r.failed, 1);
  assert.ok(existsSync(join(victim, 'SKILL.md')), 'the out-of-scope tree survived');
});

test('M15: a skipped entry is KEPT in the manifest', () => {
  const victim = join(outside, 'skills', 'archgen');
  mkdirSync(join(outside, 'skills'), { recursive: true });
  cpSync(VENDOR, victim, { recursive: true });
  const manifest = join(home, MANIFEST_NAME);
  writeFileSync(manifest, `copy\t${victim}\n`);

  uninstallGlobal(home);
  assert.ok(existsSync(manifest), 'the manifest was removed even though an entry was skipped');
  const kept = readFileSync(manifest, 'utf8');
  assert.ok(kept.includes(victim), 'the skipped entry was discarded');
});

test('M15: the manifest is removed when every entry was uninstalled', () => {
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  const r = installGlobal({ home, packageRoot: pkgRoot, copy: true });
  assert.equal(r.failures, 0, JSON.stringify(r.rows));
  const dest = join(home, '.claude', 'skills', 'archgen');
  assert.ok(existsSync(dest));

  const u = uninstallGlobal(home, { packageRoot: pkgRoot });
  assert.ok(u.removed >= 1);
  assert.ok(!existsSync(dest));
  assert.ok(!existsSync(join(home, MANIFEST_NAME)), 'the manifest survives an empty uninstall');
});

test('M15: an edited copy-mode install is backed up before it is removed', () => {
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  const r = installGlobal({ home, packageRoot: pkgRoot, copy: true });
  assert.equal(r.failures, 0, JSON.stringify(r.rows));

  const dest = join(home, '.claude', 'skills', 'archgen');
  writeFileSync(join(dest, 'SKILL.md'), 'USER EDIT — DO NOT LOSE\n', { flag: 'a' });

  const u = uninstallGlobal(home, { packageRoot: pkgRoot });
  assert.ok(u.removed >= 1, 'the install was removed');
  assert.ok(u.backups.length >= 1, 'the edited copy was backed up');
  const vault = u.backups[0];
  assert.match(vault, /[\\/]\.archgen-backups[\\/][^\\/]+[\\/]archgen$/, 'the vault layout is unchanged');
  assert.ok(
    readFileSync(join(vault, 'SKILL.md'), 'utf8').includes('USER EDIT — DO NOT LOSE'),
    'the edited bytes are recoverable from the vault',
  );
  assert.ok(!existsSync(dest), 'the edited copy was removed from the harness dir');
});

test('M15: an unedited copy-mode install needs no backup', () => {
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  installGlobal({ home, packageRoot: pkgRoot, copy: true });
  const u = uninstallGlobal(home, { packageRoot: pkgRoot });
  assert.deepEqual(u.backups, [], 'an unmodified copy is not backed up');
});
