// Restore-tooling fixes.
//
// H1: a restore used to put back the snapshot's TOP-LEVEL directory, so
//     restoring a `.agents` snapshot replaced the whole `.agents/` tree —
//     every sibling skill the user had installed was gone. The vault now
//     records the exact backed-up paths and the restore puts back exactly
//     those, leaving siblings untouched.
// L5: `--project -foo` used to be read as a directory named "-foo"; a
//     flag-shaped value is an option, never a path.
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
import { initProject } from '../lib/init.js';
import { installGlobal } from '../lib/install.js';
import { restoreBackups, restoreMain } from '../lib/restore.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = (p) => join(p, '.agents', 'skills', 'archgen');

let proj;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'ag-restore-fix-'));
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
});

function projectBackupTs(backupRel) {
  return backupRel.split('\\').join('/').split('/')[2];
}

test('H1: restoring a snapshot puts back the backed-up path and leaves sibling skills alone', () => {
  initProject(proj, CLI, { env: { ARCHGEN_CODEGRAPH: "0" } });

  // A sibling skill the user installed next to ours.
  const sibling = join(proj, '.agents', 'skills', 'other-skill');
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, 'SKILL.md'), '# sibling skill\n');

  // Diverge the store so the next init backs it up.
  writeFileSync(join(STORE(proj), 'SKILL.md'), 'DIVERGED-STATE\n');
  const r = initProject(proj, CLI, { env: { ARCHGEN_CODEGRAPH: "0" } });
  assert.equal(r.backups.length, 1, 'the divergent store was backed up');
  const ts = projectBackupTs(r.backups[0]);

  const res = restoreBackups(proj, { snapshot: ts, includeGlobal: false });
  assert.equal(res.action, 'restored');
  assert.ok(
    res.restored.some((e) => e.to === STORE(proj)),
    'the exact backed-up path is restored, not the whole .agents tree',
  );
  assert.ok(existsSync(join(sibling, 'SKILL.md')), 'the sibling skill survived the restore');
  assert.equal(readFileSync(join(sibling, 'SKILL.md'), 'utf8'), '# sibling skill\n');
});

test('H1: a restore never removes a sibling skill that is not part of the snapshot', () => {
  initProject(proj, CLI, { env: { ARCHGEN_CODEGRAPH: "0" } });
  writeFileSync(join(STORE(proj), 'SKILL.md'), 'DIVERGED-STATE\n');
  const r = initProject(proj, CLI, { env: { ARCHGEN_CODEGRAPH: "0" } });
  const ts = projectBackupTs(r.backups[0]);

  // The sibling appears AFTER the snapshot was taken.
  const sibling = join(proj, '.agents', 'skills', 'later-skill');
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, 'SKILL.md'), '# later\n');

  restoreBackups(proj, { snapshot: ts, includeGlobal: false });
  assert.ok(existsSync(join(sibling, 'SKILL.md')), 'a skill installed after the snapshot survived');
});

test('L5: restore refuses a flag-shaped --project value instead of using it as a directory', async () => {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const code = await restoreMain(['--list', '--project', '-foo']);
    assert.equal(code, 1, 'a flag-shaped value is not a directory');
    assert.ok(errors.some((l) => /unknown flag/.test(l)), `expected an unknown-flag error, got: ${errors.join(' | ')}`);
    assert.ok(!logs.some((l) => l.includes('-foo')), 'the flag-shaped value was not used as a path');
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});

test('H1: the global vault records its exact path and restores exactly that', () => {
  const home = mkdtempSync(join(tmpdir(), 'ag-restore-home-'));
  try {
    const skills = join(home, '.claude', 'skills');
    mkdirSync(skills, { recursive: true });
    const dest = join(skills, 'archgen');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'SKILL.md'), 'GLOBAL STORE\n');

    // A divergent global copy is moved into the global vault.
    const pkgRoot = mkdtempSync(join(tmpdir(), 'ag-restore-pkg-'));
    try {
      mkdirSync(join(pkgRoot, 'vendor', 'skills'), { recursive: true });
      cpSync(join(CLI, 'vendor', 'skills', 'archgen'), join(pkgRoot, 'vendor', 'skills', 'archgen'), { recursive: true });
      writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'archgen-skill', version: '0.0.7' }));
      const r = installGlobal({ home, packageRoot: pkgRoot, copy: true });
      assert.equal(r.failures, 0, JSON.stringify(r.rows));
      writeFileSync(join(dest, 'SKILL.md'), 'DIVERGED\n');
      const r2 = installGlobal({ home, packageRoot: pkgRoot, copy: true });
      assert.ok(r2.backups.length >= 1);

      // A sibling skill in the same harness dir must survive the restore.
      const sibling = join(skills, 'other-skill');
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, 'SKILL.md'), '# sibling\n');

      const listed = restoreBackups(proj, { list: true, home });
      const globals = listed.snapshots.filter((s) => s.origin === 'global');
      assert.ok(globals.length >= 2, 'both global snapshots are listed');
      const g = globals[globals.length - 1]; // oldest first: the original store

      const res = restoreBackups(proj, { snapshot: g.ts, home });
      assert.equal(res.action, 'restored');
      assert.ok(res.restored.some((e) => e.to === dest), 'the exact global path was restored');
      assert.ok(existsSync(join(sibling, 'SKILL.md')), 'the sibling skill survived');
      assert.ok(readFileSync(join(dest, 'SKILL.md'), 'utf8').includes('GLOBAL STORE'));
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('H1: a legacy snapshot without a path record restores file-by-file, not directory-by-directory', () => {
  initProject(proj, CLI, { env: { ARCHGEN_CODEGRAPH: '0' } });
  // A snapshot written by an older CLI: no path record, just the tree.
  const ts = '2020-01-01T00-00-00-000Z';
  const snapshotStore = join(proj, '.archgen', '.backup', ts, '.agents', 'skills', 'archgen');
  mkdirSync(snapshotStore, { recursive: true });
  writeFileSync(join(snapshotStore, 'SKILL.md'), 'LEGACY SNAPSHOT\n');

  const sibling = join(proj, '.agents', 'skills', 'other-skill');
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, 'SKILL.md'), '# sibling\n');

  const res = restoreBackups(proj, { snapshot: ts, includeGlobal: false });
  assert.equal(res.action, 'restored');
  assert.ok(existsSync(join(sibling, 'SKILL.md')), 'the sibling skill survived the legacy restore');
  assert.equal(
    readFileSync(join(STORE(proj), 'SKILL.md'), 'utf8'),
    'LEGACY SNAPSHOT\n',
    'the snapshot bytes were restored',
  );
});
