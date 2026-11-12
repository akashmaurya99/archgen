// Project-scoped fixes.
//
// H2: init removed a legacy claude copy BEFORE the containment guard ran.
// M4: a failed MCP bootstrap was swallowed — init/install reported success.
// M5: the project uninstall deleted the canonical store without a containment
//     check, so a symlinked `.agents` took a tree outside the project with it.
// M6: a symlinked AGENTS.md left the uninstall half-finished and failed.
// M14: the store install was not atomic — a failed copy left an orphan temp
//     directory and a failed rename left NO store.
// L1: assertWithinRoot was a no-op when the root did not exist yet.
// L8: saveManifest wrote through a symlinked `.archgen` parent.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../lib/init.js';
import { uninstallProject } from '../lib/uninstall-project.js';
import { assertWithinRoot, saveManifest } from '../lib/store.js';
import { bootstrapServers } from '../lib/bootstrap.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(CLI, 'vendor', 'skills', 'archgen');
const BIN = join(CLI, 'bin', 'archgen.mjs');
const REFUSE_RE = /Refusing to write through symlink/;
// The installed package's version comes from the ONE shared helper.
import { RELEASE } from './versions.mjs';
const STORE = (p) => join(p, '.agents', 'skills', 'archgen');
const NO_BOOTSTRAP = { env: { ARCHGEN_CODEGRAPH: '0' } };

let proj, outside, pkgRoot;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'ag-proj-fix-'));
  outside = mkdtempSync(join(tmpdir(), 'ag-proj-outside-'));
  // Hermetic package root so a failing copy never touches the repo's vendor.
  pkgRoot = mkdtempSync(join(tmpdir(), 'ag-proj-pkg-'));
  mkdirSync(join(pkgRoot, 'vendor', 'skills'), { recursive: true });
  cpSync(VENDOR, join(pkgRoot, 'vendor', 'skills', 'archgen'), { recursive: true });
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'archgen-skill', version: RELEASE }));
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(pkgRoot, { recursive: true, force: true });
});

test('H2: init refuses a symlinked .claude parent BEFORE it removes the legacy copy', () => {
  // The legacy dual copy lives outside the project, behind a symlinked
  // `.claude` parent.
  mkdirSync(join(outside, 'skills'), { recursive: true });
  cpSync(VENDOR, join(outside, 'skills', 'archgen'), { recursive: true });
  symlinkSync(outside, join(proj, '.claude'));

  assert.throws(() => initProject(proj, CLI, NO_BOOTSTRAP), REFUSE_RE);
  assert.ok(
    existsSync(join(outside, 'skills', 'archgen', 'SKILL.md')),
    'the copy outside the project was not removed',
  );
});

test('M4: a failed MCP bootstrap is visible to the caller and reported to the user', () => {
  const stub = join(outside, 'mcp-fail.mjs');
  writeFileSync(stub, '#!/usr/bin/env node\nprocess.exit(3);\n', { mode: 0o755 });

  const r = bootstrapServers({ projectDir: proj, env: { ARCHGEN_MCP_BIN: stub } });
  assert.equal(r.ok, false, 'the caller sees the failure');
  assert.ok(r.detail, 'the failure carries a detail');

  const init = initProject(proj, CLI, { env: { ARCHGEN_MCP_BIN: stub } });
  assert.ok(
    init.warnings.some((w) => /server bootstrap incomplete/.test(w)),
    `expected a bootstrap warning, got: ${JSON.stringify(init.warnings)}`,
  );

  const cli = spawnSync(process.execPath, [BIN, 'init', proj], {
    encoding: 'utf8',
    // The bootstrap must actually run: the suite's own env disables it.
    env: { ...process.env, ARCHGEN_CODEGRAPH: '1', ARCHGEN_MCP_BIN: stub },
  });
  assert.match(cli.stdout + cli.stderr, /server bootstrap incomplete/);
});

test('M5: the project uninstall does not delete the store through a symlinked .agents', () => {
  // A tree outside the project, reachable as <proj>/.agents/skills/archgen.
  mkdirSync(join(outside, 'skills'), { recursive: true });
  cpSync(VENDOR, join(outside, 'skills', 'archgen'), { recursive: true });
  symlinkSync(outside, join(proj, '.agents'));

  const u = uninstallProject(proj, CLI);
  assert.equal(u.storeRemoved, false, 'the store was not removed');
  assert.equal(u.storeKept, true);
  assert.ok(
    existsSync(join(outside, 'skills', 'archgen', 'SKILL.md')),
    'the tree outside the project survived',
  );
});

test('M6: the project uninstall refuses to write through a symlinked AGENTS.md and stays coherent', () => {
  initProject(proj, CLI, NO_BOOTSTRAP);
  const victim = join(outside, 'notes.md');
  writeFileSync(victim, '# user notes\n<!-- archgen:start -->\nmanaged\n<!-- archgen:end -->\n');
  rmSync(join(proj, 'AGENTS.md'));
  symlinkSync(victim, join(proj, 'AGENTS.md'));

  const u = uninstallProject(proj, CLI);
  assert.ok(
    u.warnings.some((w) => /AGENTS\.md is a symlink/.test(w)),
    `expected a symlink warning, got: ${JSON.stringify(u.warnings)}`,
  );
  assert.equal(
    readFileSync(victim, 'utf8'),
    '# user notes\n<!-- archgen:start -->\nmanaged\n<!-- archgen:end -->\n',
    'the file behind the symlink was not written through',
  );
  // The rest of the uninstall completed: the project is in a coherent state.
  assert.equal(u.storeRemoved, true);
  assert.equal(u.manifestRemoved, true);
  assert.equal(u.linkRemoved, true);
});

test('M6: the CLI uninstall of a project with a symlinked AGENTS.md succeeds', () => {
  const r = spawnSync(process.execPath, [BIN, 'init', proj], {
    encoding: 'utf8',
    env: { ...process.env, ARCHGEN_CODEGRAPH: '0', HOME: join(proj, 'home') },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const victim = join(outside, 'notes.md');
  writeFileSync(victim, 'notes\n');
  rmSync(join(proj, 'AGENTS.md'));
  symlinkSync(victim, join(proj, 'AGENTS.md'));

  const u = spawnSync(process.execPath, [BIN, 'uninstall', '--project', proj], {
    encoding: 'utf8',
    env: { ...process.env, ARCHGEN_CODEGRAPH: '0', HOME: join(proj, 'home') },
  });
  assert.equal(u.status, 0, 'the uninstall must not fail: ' + u.stdout + u.stderr);
  assert.match(u.stdout, /AGENTS\.md is a symlink/);
});

test('the project uninstall removes the dead extension runtime directory', () => {
  // The VS Code extension wrote a heartbeat + acknowledgements under
  // `.archgen/.runtime/`. It is archgen-owned state and it is dead now that
  // the extension is gone — so the uninstall takes it with it.
  initProject(proj, CLI, NO_BOOTSTRAP);
  const runtime = join(proj, '.archgen', '.runtime');
  mkdirSync(join(runtime, 'cmd'), { recursive: true });
  writeFileSync(join(runtime, 'bridge.json'), '{"protocol":1}\n');
  writeFileSync(join(runtime, 'cmd', 'abc.json'), '{"id":"abc"}\n');

  const u = uninstallProject(proj, CLI);
  assert.equal(u.runtimeRemoved, true, 'the runtime dir must be reported as removed');
  assert.equal(existsSync(runtime), false, 'the dead runtime dir survived the uninstall');
});

test('the project uninstall keeps the feature folders beside the runtime dir', () => {
  // `.archgen/<slug>` holds the user's PLAN — it must survive, even when the
  // dead runtime directory beside it is removed.
  initProject(proj, CLI, NO_BOOTSTRAP);
  const runtime = join(proj, '.archgen', '.runtime');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'bridge.json'), '{"protocol":1}\n');
  const feature = join(proj, '.archgen', 'demo');
  mkdirSync(feature, { recursive: true });
  writeFileSync(join(feature, 'tasks.yaml'), 'tasks: []\n');

  const u = uninstallProject(proj, CLI);
  assert.equal(u.runtimeRemoved, true);
  assert.equal(existsSync(runtime), false, 'the dead runtime dir survived');
  assert.equal(existsSync(join(feature, 'tasks.yaml')), true, 'the user plan was deleted');
});

test('M14: a failed copy leaves no orphaned temp directory and no missing store', () => {
  // A pre-existing store that must survive the failed install.
  mkdirSync(STORE(proj), { recursive: true });
  writeFileSync(join(STORE(proj), 'SKILL.md'), 'PREVIOUS STORE\n');

  // Make the staged copy fail: an unreadable file in the source tree.
  const locked = join(pkgRoot, 'vendor', 'skills', 'archgen', 'references', 'locked.md');
  writeFileSync(locked, 'secret\n');
  chmodSync(locked, 0o000);
  let failed = false;
  try {
    initProject(proj, pkgRoot, NO_BOOTSTRAP);
  } catch {
    failed = true;
  } finally {
    chmodSync(locked, 0o600);
  }
  assert.ok(failed, 'the install must fail when the copy cannot be completed');

  const leftovers = readdirSync(join(proj, '.agents', 'skills')).filter((n) => n.startsWith('.archgen-tmp-'));
  assert.deepEqual(leftovers, [], 'an orphaned temp directory was left behind');
  assert.equal(
    readFileSync(join(STORE(proj), 'SKILL.md'), 'utf8'),
    'PREVIOUS STORE\n',
    'the previous store survived the failed install',
  );
});

test('M14: a successful install leaves no swap-aside directory behind', () => {
  initProject(proj, CLI, NO_BOOTSTRAP);
  const names = readdirSync(join(proj, '.agents', 'skills'));
  assert.deepEqual(names.filter((n) => n.startsWith('.archgen-')), [], 'stray swap directories remain');
});

test('L1: assertWithinRoot still refuses a lexical escape when the root does not exist', () => {
  const missingRoot = join(outside, 'not-created-yet');
  assert.ok(!existsSync(missingRoot), 'precondition: the root does not exist');
  assert.throws(
    () => assertWithinRoot(missingRoot, join(missingRoot, '..', 'escape', 'file')),
    REFUSE_RE,
    'the guard was inert because the root does not exist',
  );
  assert.doesNotThrow(
    () => assertWithinRoot(missingRoot, join(missingRoot, '.agents', 'skills', 'archgen')),
    'a legitimate path inside a not-yet-created root must pass',
  );
});

test('L8: saveManifest refuses to write through a symlinked .archgen parent', () => {
  symlinkSync(outside, join(proj, '.archgen'));
  assert.throws(() => saveManifest(proj, { version: 1, entries: [] }), REFUSE_RE);
  assert.ok(
    !existsSync(join(outside, '.install-manifest.json')),
    'the manifest was written outside the project',
  );
});

test('L8: the init manifest is never written through a symlinked .archgen', () => {
  symlinkSync(outside, join(proj, '.archgen'));
  assert.throws(() => initProject(proj, CLI, NO_BOOTSTRAP), REFUSE_RE);
  assert.deepEqual(readdirSync(outside), [], 'nothing was written through the symlink');
  assert.ok(lstatSync(join(proj, '.archgen')).isSymbolicLink(), 'the symlink was left in place');
});
