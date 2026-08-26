// Safety tests: zero-data-loss global copy installs (divergence → backup,
// identical → SAME), dangling-symlink repair, and the restore tooling across
// both vaults (project .archgen/.backup + global <skills>/.archgen-backups).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdtempSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../lib/init.js';
import { installGlobal } from '../lib/install.js';
import { restoreBackups, restoreMain } from '../lib/restore.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(CLI, 'vendor', 'skills', 'archgen');
const VERSION = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')).version;
const STORE = (p) => join(p, '.agents', 'skills', 'archgen');

let proj, home, pkgRoot;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'ag-safe-proj-'));
  home = mkdtempSync(join(tmpdir(), 'ag-safe-home-'));
  // Hermetic package root so global installs never stamp the repo's own vendor/.
  pkgRoot = mkdtempSync(join(tmpdir(), 'ag-safe-pkg-'));
  mkdirSync(join(pkgRoot, 'vendor', 'skills'), { recursive: true });
  cpSync(VENDOR, join(pkgRoot, 'vendor', 'skills', 'archgen'), { recursive: true });
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'archgen-skill', version: VERSION }));
});

afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(pkgRoot, { recursive: true, force: true });
});

function twoSkillDirs() {
  mkdirSync(join(home, '.claude/skills'), { recursive: true });
  mkdirSync(join(home, '.agents/skills'), { recursive: true });
}

function projectBackupTs(backupRel) {
  return backupRel.split('\\').join('/').split('/')[2];
}

test('copy mode backs up a divergent dest into the global vault before replacing it', () => {
  twoSkillDirs();
  const r1 = installGlobal({ home, packageRoot: pkgRoot, copy: true });
  assert.equal(r1.failures, 0);
  assert.deepEqual(r1.backups, [], 'fresh install makes no backups');

  const claudeDest = join(home, '.claude/skills/archgen');
  writeFileSync(join(claudeDest, 'SKILL.md'), 'USER EDIT X\n', { flag: 'a' });

  const r2 = installGlobal({ home, packageRoot: pkgRoot, copy: true });
  assert.equal(r2.failures, 0);
  assert.ok(
    r2.rows.some((r) => r[0] === 'BACKED-UP' && r[2].includes('.archgen-backups')),
    'BACKED-UP note row emitted',
  );

  const vault = r2.backups.find((p) => p.includes(join('.claude', 'skills')));
  assert.ok(vault, 'a backup was recorded for the claude target');
  assert.match(vault, /[\\/]\.archgen-backups[\\/][^\\/]+[\\/]archgen$/, '<tdir>/.archgen-backups/<ts>/archgen layout');
  assert.ok(readFileSync(join(vault, 'SKILL.md'), 'utf8').includes('USER EDIT X'), 'divergent bytes preserved in the vault');

  assert.equal(
    readFileSync(join(claudeDest, 'SKILL.md'), 'utf8'),
    readFileSync(join(pkgRoot, 'vendor/skills/archgen/SKILL.md'), 'utf8'),
    'dest refreshed to canonical content after the backup',
  );
});

test('copy mode reports SAME on an identical dest and creates no backup', () => {
  twoSkillDirs();
  installGlobal({ home, packageRoot: pkgRoot, copy: true });
  const r2 = installGlobal({ home, packageRoot: pkgRoot, copy: true });
  assert.equal(r2.failures, 0);
  assert.deepEqual(r2.backups, []);
  const sameRows = r2.rows.filter((r) => r[0] === 'SAME' && r[1] === 'copy');
  assert.ok(sameRows.length >= 2, 'both existing targets report SAME/copy');
  assert.ok(!existsSync(join(home, '.claude/skills/.archgen-backups')), 'no vault created when nothing diverged');
});

test('link mode repairs a dangling symlink and reports REPAIRED', () => {
  mkdirSync(join(home, '.claude/skills'), { recursive: true });
  const dest = join(home, '.claude/skills/archgen');
  symlinkSync(join(home, '.claude/skills/evicted-npx-cache'), dest, 'dir');
  assert.ok(lstatSync(dest).isSymbolicLink() && !existsSync(dest), 'precondition: dangling link');

  const r = installGlobal({ home, packageRoot: pkgRoot });
  assert.equal(r.failures, 0);
  const row = r.rows.find((x) => x[2] === dest);
  assert.ok(row, 'row present for the target');
  assert.equal(row[0], 'REPAIRED', 'dangling link is reported REPAIRED, not SAME');

  assert.ok(lstatSync(dest).isSymbolicLink(), 'still a symlink after repair');
  assert.equal(realpathSync(dest), realpathSync(join(pkgRoot, 'vendor/skills/archgen')));
  assert.ok(existsSync(join(dest, 'SKILL.md')), 'link resolves to real skill content');
});

test('restore list discovers snapshots from both the project and the global vault', () => {
  twoSkillDirs();
  initProject(proj, CLI);
  writeFileSync(join(STORE(proj), 'SKILL.md'), 'PROJECT DIVERGED\n', { flag: 'a' });
  const rInit = initProject(proj, CLI);
  assert.equal(rInit.backups.length, 1);
  const projectTs = projectBackupTs(rInit.backups[0]);

  installGlobal({ home, packageRoot: pkgRoot, copy: true });
  writeFileSync(join(home, '.claude/skills/archgen/SKILL.md'), 'GLOBAL DIVERGED\n', { flag: 'a' });
  const rInst = installGlobal({ home, packageRoot: pkgRoot, copy: true });
  assert.ok(rInst.backups.length >= 1);

  const listed = restoreBackups(proj, { list: true, home });
  const kinds = new Set(listed.snapshots.map((s) => s.origin));
  assert.ok(kinds.has('project') && kinds.has('global'), 'both origin kinds discovered');

  const p = listed.snapshots.find((s) => s.origin === 'project' && s.ts === projectTs);
  assert.ok(p, 'project snapshot with its timestamp id is listed');
  assert.ok(p.summary.files > 0 && p.summary.topLevel.includes('.agents'));

  const g = listed.snapshots.find((s) => s.origin === 'global');
  assert.ok(g, 'global snapshot listed');
  assert.ok(g.summary.topLevel.includes('archgen'));
});

test('restore roundtrip recovers the original bytes of a backed-up store', () => {
  initProject(proj, CLI);
  const original = readFileSync(join(STORE(proj), 'SKILL.md'), 'utf8');

  writeFileSync(join(STORE(proj), 'SKILL.md'), 'DIVERGED-THEN-BACKED-UP\n', { flag: 'a' });
  const rInit = initProject(proj, CLI);
  assert.equal(rInit.backups.length, 1);
  const ts = projectBackupTs(rInit.backups[0]);
  const vaultStore = join(proj, '.archgen', '.backup', ts, '.agents', 'skills', 'archgen');
  const snapshotBytes = readFileSync(join(vaultStore, 'SKILL.md'), 'utf8');

  writeFileSync(join(STORE(proj), 'SKILL.md'), 'CURRENT-STATE\n');

  const res = restoreBackups(proj, { snapshot: ts, includeGlobal: false });
  assert.equal(res.action, 'restored');
  assert.ok(res.restored.some((e) => e.to === join(proj, '.agents')), 'snapshot child mapped back to its original path');
  const restoredBytes = readFileSync(join(STORE(proj), 'SKILL.md'), 'utf8');
  assert.equal(restoredBytes, snapshotBytes, 'vault bytes come back out exactly (roundtrip)');
  assert.ok(restoredBytes.startsWith(original), 'pristine content preserved inside the restored file');
});

test('restore never deletes current state without first backing it up', () => {
  initProject(proj, CLI);
  writeFileSync(join(STORE(proj), 'SKILL.md'), 'DIVERGED\n', { flag: 'a' });
  const rInit = initProject(proj, CLI);
  const ts = projectBackupTs(rInit.backups[0]);
  writeFileSync(join(STORE(proj), 'SKILL.md'), 'PRECIOUS CURRENT STATE\n', { flag: 'a' });

  const backupRoot = join(proj, '.archgen', '.backup');
  const before = readdirSync(backupRoot);

  const res = restoreBackups(proj, { snapshot: ts, includeGlobal: false });
  assert.equal(res.action, 'restored');
  assert.ok(res.safetyBackups.length >= 1, 'result records a safety backup of current state');

  const after = readdirSync(backupRoot);
  const newTs = after.find((d) => !before.includes(d));
  assert.ok(newTs, 'a fresh safety snapshot dir was created');

  let found = false;
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (readFileSync(p, 'utf8').includes('PRECIOUS CURRENT STATE')) found = true;
    }
  })(join(backupRoot, newTs));
  assert.ok(found, 'current-state bytes recoverable from the safety snapshot');
});

test('restoreMain lists deterministically and exits nonzero on unknown snapshot', async () => {
  initProject(proj, CLI);
  writeFileSync(join(STORE(proj), 'SKILL.md'), 'X\n', { flag: 'a' });
  initProject(proj, CLI);

  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const codeList = await restoreMain(['--list', '--project', proj]);
    assert.equal(codeList, 0);
    assert.ok(logs.some((l) => l.includes('[project]')), 'listing shows the project snapshot');

    const codeMissing = await restoreMain(['--snapshot', '1970-01-01T00-00-00-000Z', '--project', proj]);
    assert.equal(codeMissing, 1);
    assert.ok(errors.some((l) => l.includes('no backup snapshot')), 'unknown snapshot errors clearly');
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});
