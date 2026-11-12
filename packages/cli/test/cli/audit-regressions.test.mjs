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
const CLI_ROOT = join(HERE, '..', '..');            // packages/cli
const REPO_ROOT = join(CLI_ROOT, '..', '..'); // monorepo root
const BIN = join(CLI_ROOT, 'bin', 'archgen.mjs');

/**
 * Copy the CLI package without node_modules. Installed dependencies can carry
 * symlinks or transient files that make cpSync throw ENOENT, which used to
 * turn this regression test flaky for an unrelated reason. The copy is done
 * entry by entry: a cpSync `filter` trips a Node 26 ERR_INTERNAL_ASSERTION
 * on this tree's `bin/archgen-mcp` symlink.
 */
function copyCliPackage(dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(CLI_ROOT, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    cpSync(join(CLI_ROOT, entry.name), join(dest, entry.name), { recursive: true });
  }
}

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
// completes, classifies broken markers as FAIL, and FAILS the run (a FAIL
// row is a broken state a human must fix).
test('BUG-DOC1 // AUDIT-REGRESSION doctor reports a FAIL row (not a top-level abort) when AGENTS.md has an orphan end marker', () => {
  const proj = initProject();
  writeFileSync(join(proj, 'AGENTS.md'), '# my notes\n<!-- archgen:end -->\n');
  const r = runCli(['doctor', proj]);
  assert.notEqual(r.status, 0, `doctor must fail the run on a FAIL row: ${r.stdout}`);
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
  assert.notEqual(r.status, 0, `doctor must fail the run on a FAIL row: ${r.stdout}`);
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

// BUG-DOC4: store validity = "SKILL.md exists". A store missing a whole
// REQUIRED subtree still reports OK, so doctor green-lights installs whose
// references are gone. (The skill no longer ships a scripts/ tree — that
// subtree is obsolete, not required — so the probe targets references/.)
test('BUG-DOC4 // AUDIT-REGRESSION doctor detects a store missing whole subdirectories (not just SKILL.md)', () => {
  const proj = initProject();
  rmSync(join(proj, '.agents', 'skills', 'archgen', 'references'), { recursive: true, force: true });
  const r = runCli(['doctor', proj, '--check']);
  assert.doesNotMatch(r.stdout, /SKILL\.md present\)/,
    'doctor treated a gutted store (no references/) as fully healthy');
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
  // The install must run against a COPY of the CLI package, not the real one.
  // In link mode installGlobal stamps the SOURCE tree (the packaged skill),
  // so running it against the repository's own packages/cli wrote a
  // .archgen-version into vendor/skills/archgen — a file .gitignore forbids
  // there and one `npm pack` (which does NOT run prepublishOnly, unlike
  // `npm publish`) would then ship in the tarball the smoke test installs.
  //
  // A copy gives the test the same package it would install in production
  // and leaves the repository untouched.
  const pkgRoot = join(dir, 'pkg');
  copyCliPackage(pkgRoot);
  const r = install.installGlobal({ home, packageRoot: pkgRoot });
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

// BUG-SYNC1: sync-vendor mirrors everything under skill/ into the published
// vendor tree — OS junk like .DS_Store must NOT ride along.
test('BUG-SYNC1 // AUDIT-REGRESSION sync-vendor does not copy OS junk (.DS_Store) into the published vendor tree', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'archgen-sync-'));
  try {
    mkdirSync(join(sandbox, 'packages'), { recursive: true });
    copyCliPackage(join(sandbox, 'packages', 'cli'));
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
    // The shipped payload is the skill's GUIDANCE tree only: SKILL.md and
    // references/. The skill carries no code any more, so no scripts/ tree may
    // ride along.
    assert.ok(!existsSync(join(vendor, 'scripts')),
      'sync-vendor shipped a scripts/ tree into the vendor mirror (the skill carries no code)');
    // The mirror must still carry everything the skill actually ships.
    for (const required of ['SKILL.md', 'references']) {
      assert.ok(existsSync(join(vendor, required)),
        `sync-vendor pruned the required ${required} out of the vendor mirror`);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// BUG-SYNC2: sync-config's main guard compared import.meta.url (which Node
// realpath-resolves) against process.argv[1] (which it does NOT), so launching
// the script through a symlinked path made the equality fail and main() silently
// never ran — skipping version derivation during releases. Desired: the guard
// realpath-resolves argv[1] too, so main() runs even via a symlinked launch path.
test('BUG-SYNC2 // AUDIT-REGRESSION sync-config main() runs when launched through a symlinked path', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'archgen-sync2-'));
  try {
    mkdirSync(join(sandbox, 'packages'), { recursive: true });
    copyCliPackage(join(sandbox, 'packages', 'cli'));
    cpSync(join(REPO_ROOT, 'skill'), join(sandbox, 'skill'), { recursive: true });
    cpSync(join(REPO_ROOT, 'archgen.config.json'), join(sandbox, 'archgen.config.json'));

    // Create a symlinked launch path to the script inside the sandbox.
    const linkDir = join(sandbox, 'link');
    mkdirSync(linkDir, { recursive: true });
    const linkPath = join(linkDir, 'sync-config.mjs');
    try {
      symlinkSync(join(sandbox, 'packages', 'cli', 'scripts', 'sync-config.mjs'), linkPath, 'file');
    } catch {
      return; // symlinks unavailable on this platform/user — guard cannot be exercised
    }

    const r = spawnSync(process.execPath, [linkPath, '--check'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `sync-config exited non-zero via symlink: ${r.stderr}`);
    assert.match(r.stdout, /sync-config --check:/,
      `sync-config produced no --check output via symlink (main() did not run): ${r.stdout}${r.stderr}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// AUDIT-REGRESSION: the npm lookup must degrade gracefully (null, never a
// throw) on every platform — including Windows, where an unshelled
// spawnSync('npm', …) fails with EINVAL since the CVE-2024-27980 hardening.
// The root fix routes npm through its JS entry point (lib/spawn-npm.js), so
// the failure mode is asserted cross-platform instead of being skipped on
// every non-Windows CI run.
test('AUDIT-REGRESSION // fetchLatestVersion degrades to null (never throws) when the registry lookup fails', async () => {
  const version = await import(join(CLI_ROOT, 'lib', 'version.js'));
  // An invalid package name fails at the registry boundary on every platform
  // and in every network state (offline included).
  assert.equal(version.fetchLatestVersion('!!not-a-valid-package-name!!'), null);
  // A name that could be interpolated into a shell command is refused outright.
  assert.equal(version.fetchLatestVersion('pkg; rm -rf /'), null);
});

test('AUDIT-REGRESSION // npm invocation resolves npm-cli.js instead of a platform shim', async () => {
  const { npmCliPath, npmInvocation, whichOnPath } = await import(join(CLI_ROOT, 'lib', 'spawn-npm.js'));
  const inv = npmInvocation(['--version']);
  assert.ok(inv.command, 'an npm command is always resolvable');
  assert.ok(Array.isArray(inv.args));
  // When the CLI entry is found we invoke it with node — no .cmd shim, no
  // EINVAL risk on Windows.
  const cli = npmCliPath();
  if (cli) {
    assert.equal(inv.command, process.execPath);
    assert.equal(inv.shell, false);
  }
  // whichOnPath is the portable replacement for `command -v` (POSIX-only).
  assert.equal(whichOnPath('definitely-not-a-real-binary-xyz'), null);
});
