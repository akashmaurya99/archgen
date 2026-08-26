// AUDIT-REGRESSION — regression tests for bugs found in the 2026-08 archgen audit.
// NEW FILE ONLY: no existing file was modified. Each test encodes the DESIRED
// behavior, so tests tagged BUG-* FAIL against the current code until fixed.
// Environment-dependent cases use t.skip() with the reason inline.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(HERE, '..');            // packages/cli
const REPO_ROOT = join(CLI_ROOT, '..', '..'); // monorepo root
const BIN = join(CLI_ROOT, 'bin', 'archgen.mjs');

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'archgen-audit-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: dir, ...opts });
}
function initProject(proj = dir) {
  const r = spawnSync(process.execPath, [BIN, 'init', proj], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return proj;
}

// BUG-DOC1: doctor.js §4 calls upsertManagedFile for repair, and block.js
// upsertBlock() THROWS on a lone end marker — so instead of a FAIL row the
// whole doctor run aborts through bin's top-level catch. Desired: doctor
// completes and classifies broken markers as FAIL.
test('BUG-DOC1 // AUDIT-REGRESSION doctor reports a FAIL row (not a top-level abort) when AGENTS.md has an orphan end marker', () => {
  const proj = initProject();
  writeFileSync(join(proj, 'AGENTS.md'), '# my notes\n<!-- archgen:end -->\n');
  const r = runCli(['doctor', proj]);
  assert.equal(r.status, 0, `doctor aborted instead of reporting: ${r.stderr}`);
  assert.match(r.stdout, /\[fail/i);
  assert.match(r.stdout, /marker/i);
});

// BUG-DOC2: same crash class as BUG-DOC1 via the CLAUDE.md §5 repair path.
test('BUG-DOC2 // AUDIT-REGRESSION doctor reports a FAIL row (not a top-level abort) when CLAUDE.md has a lone start marker', () => {
  const proj = initProject();
  writeFileSync(
    join(proj, 'CLAUDE.md'),
    '# notes\n<!-- archgen:start (managed block - do not edit between markers) -->\nno end marker\n',
  );
  const r = runCli(['doctor', proj]);
  assert.equal(r.status, 0, `doctor aborted instead of reporting: ${r.stderr}`);
  assert.match(r.stdout, /\[fail/i);
});

// BUG-DOC3: doctor §4 only counts features markers (fsCount===1 && feCount===1
// → OK) without checking their ORDER. Reversed markers pass doctor but make
// update-agents.mjs exit 4 ("found start but no end"), i.e. doctor blessed a
// broken state.
test('BUG-DOC3 // AUDIT-REGRESSION doctor flags reversed archgen:features markers instead of reporting OK', () => {
  const proj = initProject();
  const p = join(proj, 'AGENTS.md');
  const fsM = '<!-- archgen:features:start -->';
  const feM = '<!-- archgen:features:end -->';
  const raw = readFileSync(p, 'utf8');
  writeFileSync(p, raw.replace(fsM, '@@FS@@').replace(feM, fsM).replace('@@FS@@', feM));
  const r = runCli(['doctor', proj, '--check']);
  assert.doesNotMatch(r.stdout, /block \+ features registry present/,
    'doctor reported OK for reversed features markers');
});

// BUG-DOC4: store validity = "SKILL.md exists". A store missing scripts/ (or
// any whole subtree) still reports OK, so doctor green-lights installs whose
// verify-plan/set-status entry points are gone.
test('BUG-DOC4 // AUDIT-REGRESSION doctor detects a store missing whole subdirectories (not just SKILL.md)', () => {
  const proj = initProject();
  rmSync(join(proj, '.agents', 'skills', 'archgen', 'scripts'), { recursive: true, force: true });
  const r = runCli(['doctor', proj, '--check']);
  assert.doesNotMatch(r.stdout, /SKILL\.md present\)/,
    'doctor treated a gutted store (no scripts/) as fully healthy');
});

// BUG-INST1: installGlobal treats ANY existing symlink at <target>/archgen as
// "SAME" without checking WHERE it points, then records it in the uninstall
// manifest — so `archgen-skill uninstall` later deletes the user's own link.
// Desired: foreign links are neither claimed nor recorded.
test('BUG-INST1 // AUDIT-REGRESSION global install does not record a FOREIGN symlink in the uninstall manifest', async (t) => {
  const probe = join(dir, 'probe-link');
  try { symlinkSync('.', probe, 'dir'); unlinkSync(probe); } catch {
    return t.skip('symlinks unavailable on this platform/user');
  }
  const home = join(dir, 'home');
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(home, '.cursor', 'skills'), { recursive: true });
  const usersOwn = join(dir, 'users-own-skill');
  mkdirSync(usersOwn);
  writeFileSync(join(usersOwn, 'SKILL.md'), '# user own skill\n');
  symlinkSync(usersOwn, join(home, '.claude', 'skills', 'archgen'), 'dir');

  const install = await import(join(CLI_ROOT, 'lib', 'install.js'));
  const r = install.installGlobal({ home });
  assert.equal(r.failures, 0, JSON.stringify(r.rows));

  const manifest = readFileSync(join(home, '.archgen-install-manifest.list'), 'utf8');
  assert.doesNotMatch(manifest, /\.claude.*skills.*archgen/,
    'foreign symlink at ~/.claude/skills/archgen was recorded into our uninstall manifest');

  install.uninstallGlobal(home);
  assert.ok(existsSync(join(home, '.claude', 'skills', 'archgen')),
    'uninstallGlobal deleted the user’s own foreign symlink');
  assert.equal(readFileSync(join(usersOwn, 'SKILL.md'), 'utf8'), '# user own skill\n',
    'foreign target disturbed');
});

// BUG-SYNC1: sync-vendor copies everything under skill/ except .gitkeep and
// scripts/test — OS junk like .DS_Store rides into the published npm tarball.
test('BUG-SYNC1 // AUDIT-REGRESSION sync-vendor does not copy OS junk (.DS_Store) into the published vendor tree', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'archgen-sync-'));
  try {
    mkdirSync(join(sandbox, 'packages'), { recursive: true });
    cpSync(CLI_ROOT, join(sandbox, 'packages', 'cli'), { recursive: true });
    cpSync(join(REPO_ROOT, 'skill'), join(sandbox, 'skill'), { recursive: true });
    writeFileSync(join(sandbox, 'skill', '.DS_Store'), 'junk');
    const r = spawnSync(
      process.execPath,
      [join(sandbox, 'packages', 'cli', 'scripts', 'sync-vendor.mjs')],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    const vendor = join(sandbox, 'packages', 'cli', 'vendor', 'skills', 'archgen');
    const names = readdirSync(vendor);
    assert.ok(!names.includes('.DS_Store'),
      `sync-vendor copied .DS_Store into vendor: ${names.join(', ')}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// SKIP-ENV (Windows-only): bin/archgen.mjs `update` runs spawnSync('npm', …)
// and version.js fetchLatestVersion likewise, WITHOUT shell:true. Since Node's
// CVE-2024-27980 fix, spawning a .cmd/.bat shim unshelled fails with EINVAL,
// so on Windows `update` always reports "could not reach the npm registry" /
// "global upgrade failed" even while online. Desired (asserted on Windows):
// fetchLatestVersion degrades to null instead of surfacing EINVAL.
test('SKIP-ENV // AUDIT-REGRESSION update/fetchLatestVersion degrade gracefully where spawning npm .cmd shims is refused', async (t) => {
  if (process.platform !== 'win32') {
    return t.skip('Windows-only: spawnSync("npm") without shell:true fails with EINVAL on recent Node');
  }
  const version = await import(join(CLI_ROOT, 'lib', 'version.js'));
  assert.equal(version.fetchLatestVersion('archgen-skill'), null);
});
