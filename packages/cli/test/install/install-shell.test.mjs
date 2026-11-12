// install-shell.test.mjs — install.sh, driven against a throwaway machine.
//
// WHY THIS FILE EXISTS.
//
// install.sh is the installer most people run, and it is a SHELL script: the
// CLI's node:test suite never executed a line of it. An audit found the
// uninstaller deleting any path ENDING in `/skills/archgen` (a suffix test,
// not an allowlist), dropping the last manifest line when it had no trailing
// newline, deleting the manifest even after reporting a problem, destroying
// an edited install with no backup, and claiming success after writing
// nothing.
//
// Every one of those is a behaviour, and a behaviour belongs in a test. This
// file runs the REAL script with a throwaway HOME and project, and asserts
// what it does to the filesystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const INSTALL_SH = join(REPO, 'install.sh');

/**
 * A throwaway machine: a HOME and a project, and a stub `npx` so the server
 * bootstrap never touches the network or the real machine.
 *
 * @returns {{home: string, project: string, bin: string, cleanup: () => void}}
 */
function machine() {
  const root = mkdtempSync(join(tmpdir(), 'ag-install-sh-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // A stub npx: the bootstrap is not what these tests are about, and the
  // real one would install packages.
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', 'utf8');
  writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 0\n', 'utf8');
  return { home, project, bin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Run install.sh.
 *
 * @param {string[]} args
 * @param {{home: string, project: string, bin: string}} m
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function run(args, m) {
  const r = spawnSync('bash', [INSTALL_SH, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: m.home,
      PATH: `${m.bin}:${process.env.PATH}`,
      // No npx, no network: the stub answers every call.
      npm_config_offline: 'true',
    },
    cwd: m.project,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('install.sh --init creates the store and the pointer blocks', () => {
  const m = machine();
  try {
    const r = run(['--init'], m);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(m.project, '.agents', 'skills', 'archgen', 'SKILL.md')), 'the canonical store exists');
    assert.ok(existsSync(join(m.project, 'AGENTS.md')), 'AGENTS.md exists');
    assert.ok(existsSync(join(m.project, 'CLAUDE.md')), 'CLAUDE.md exists');
    assert.match(readFileSync(join(m.project, 'AGENTS.md'), 'utf8'), /archgen:start/, 'the managed block is written');
  } finally {
    m.cleanup();
  }
});

test('install.sh --init refreshes the block stamp and KEEPS the feature registry', () => {
  const m = machine();
  try {
    assert.equal(run(['--init'], m).status, 0);
    const agents = join(m.project, 'AGENTS.md');
    // The user's registry rows, inside the managed block.
    const withRows = readFileSync(agents, 'utf8').replace(
      '<!-- archgen:features:end -->',
      '| demo | planned | 2026-01-01 |\n<!-- archgen:features:end -->',
    );
    writeFileSync(agents, withRows, 'utf8');
    // A stale stamp: the block must be refreshed to the CURRENT version.
    const stale = readFileSync(agents, 'utf8').replace(/archgen:block v[^\s>]+/, 'archgen:block v0.0.0-stale');
    writeFileSync(agents, stale, 'utf8');

    assert.equal(run(['--init'], m).status, 0);
    const after = readFileSync(agents, 'utf8');
    assert.doesNotMatch(after, /archgen:block v0\.0\.0-stale/, 'the stale stamp was refreshed');
    assert.match(after, /archgen:block v\d+\.\d+\.\d+/, 'the block carries a real version stamp');
    assert.match(after, /\| demo \| planned \| 2026-01-01 \|/, 'the feature registry survived the refresh');
  } finally {
    m.cleanup();
  }
});

test('install.sh --init refuses a directory AGENTS.md and says so', () => {
  const m = machine();
  try {
    mkdirSync(join(m.project, 'AGENTS.md'), { recursive: true });
    const r = run(['--init'], m);
    assert.notEqual(r.status, 0, 'a failed pointer write is a non-zero exit');
    assert.doesNotMatch(r.stdout, /\+ AGENTS\.md/, 'the summary does not claim a block that was not written');
    assert.match(r.stdout + r.stderr, /directory/i, 'the reason is reported');
  } finally {
    m.cleanup();
  }
});

test('install.sh --init writes the PROJECT install manifest (CLI parity)', () => {
  const m = machine();
  try {
    assert.equal(run(['--init'], m).status, 0);
    const manifest = join(m.project, '.archgen', '.install-manifest.json');
    assert.ok(existsSync(manifest), 'the project manifest exists');
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(parsed.version, 1);
    const paths = parsed.entries.map((e) => `${e.kind}:${e.path}`);
    assert.ok(paths.includes('dir:.agents/skills/archgen'), 'the store is recorded');
    assert.ok(paths.includes('block:AGENTS.md'), 'the pointer block is recorded');
    assert.ok(paths.includes('block:CLAUDE.md'), 'the bridge is recorded');
  } finally {
    m.cleanup();
  }
});

test('install.sh --uninstall removes ONLY the recorded, allowed destinations', () => {
  const m = machine();
  try {
    const manifest = join(m.home, '.archgen-install-manifest.list');
    const allowed = join(m.home, '.agents', 'skills', 'archgen');
    const victim = join(m.home, 'victim', 'skills', 'archgen');
    mkdirSync(allowed, { recursive: true });
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(allowed, 'SKILL.md'), 'x', 'utf8');
    writeFileSync(join(victim, 'SKILL.md'), 'x', 'utf8');
    // The manifest names a destination this installer never creates.
    writeFileSync(manifest, `copy\t${victim}\n`, 'utf8');

    const r = run(['--uninstall'], m);
    assert.notEqual(r.status, 0, 'a skipped entry is a problem');
    assert.ok(existsSync(victim), 'the unlisted destination SURVIVED');
    assert.ok(existsSync(manifest), 'the manifest keeps the entry that was not removed');
    assert.match(readFileSync(manifest, 'utf8'), /victim/, 'the kept entry is still recorded');
  } finally {
    m.cleanup();
  }
});

test('install.sh --uninstall processes the LAST manifest line even without a newline', () => {
  const m = machine();
  try {
    const manifest = join(m.home, '.archgen-install-manifest.list');
    const allowed = join(m.home, '.agents', 'skills', 'archgen');
    mkdirSync(allowed, { recursive: true });
    writeFileSync(join(allowed, 'SKILL.md'), 'x', 'utf8');
    // NO trailing newline: the read loop used to drop this line entirely.
    writeFileSync(manifest, `copy\t${allowed}`, 'utf8');

    const r = run(['--uninstall'], m);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(allowed), 'the recorded destination was removed');
    assert.match(r.stdout, /1 removed/, 'the removal is reported');
  } finally {
    m.cleanup();
  }
});

test('install.sh --uninstall backs up an EDITED copy before removing it', () => {
  const m = machine();
  try {
    const manifest = join(m.home, '.archgen-install-manifest.list');
    const allowed = join(m.home, '.agents', 'skills', 'archgen');
    mkdirSync(allowed, { recursive: true });
    writeFileSync(join(allowed, 'SKILL.md'), 'edited by the user', 'utf8');
    writeFileSync(manifest, `copy\t${allowed}\n`, 'utf8');

    const r = run(['--uninstall'], m);
    assert.equal(r.status, 0, r.stderr);
    const backupRoot = join(m.home, '.agents', 'skills', '.archgen-backups');
    assert.ok(existsSync(backupRoot), 'the edited copy was backed up');
    const stamp = readdirSync(backupRoot)[0];
    const kept = readFileSync(join(backupRoot, stamp, 'archgen', 'SKILL.md'), 'utf8');
    assert.match(kept, /edited by the user/, 'the edits survive the uninstall');
  } finally {
    m.cleanup();
  }
});

test('install.sh --init and --uninstall cannot be combined', () => {
  const m = machine();
  try {
    const r = run(['--init', '--uninstall'], m);
    assert.notEqual(r.status, 0, 'the contradiction is refused');
    assert.match(r.stderr, /cannot be combined/i, 'the reason is named');
    assert.ok(!existsSync(join(m.project, '.agents', 'skills', 'archgen')), 'nothing was installed');
  } finally {
    m.cleanup();
  }
});

test('install.sh --init accepts a FLAG after --init', () => {
  const m = machine();
  try {
    // The flag used to be swallowed as the project directory.
    const r = run(['--init', '--no-codegraph'], m);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /cannot enter directory/, 'the flag is a flag');
    assert.ok(existsSync(join(m.project, '.agents', 'skills', 'archgen')), 'the install happened');
  } finally {
    m.cleanup();
  }
});
