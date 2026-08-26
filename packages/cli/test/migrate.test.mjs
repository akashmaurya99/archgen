// Migration framework tests: dry-run default (fs untouched), --apply stamps
// files + writes migrate backups, idempotent second run, and tolerance of the
// skill scripts (set-status / verify-plan) for stamped artifacts.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateMain } from '../lib/migrate.js';
import { applyMigration, listMigrations, pendingMigrations } from '../lib/migrations/index.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(CLI, '..', '..');
const SKILL_SCRIPTS = join(REPO, 'skill', 'scripts');
const CORPUS = join(REPO, 'fixtures', 'yaml-corpus');

const TASKS_SRC = readFileSync(join(CORPUS, 'tasks-block.yaml'), 'utf8');
const ARCH_SRC = readFileSync(join(CORPUS, 'architecture.yaml'), 'utf8');

let proj;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'ag-migrate-'));
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
});

/** Seed an unstamped .archgen/<slug>/ artifact set. */
function seedArtifacts(slug = 'demo-shop') {
  const dir = join(proj, '.archgen', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tasks.yaml'), TASKS_SRC);
  writeFileSync(join(dir, 'architecture.yaml'), ARCH_SRC);
  return dir;
}

/** Full fs snapshot: relpath -> content. Used to prove check-mode never writes. */
function snapshot(root) {
  const out = {};
  (function walk(abs, rel) {
    const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const ent of entries) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(join(abs, ent.name), r);
      else out[r] = readFileSync(join(abs, ent.name), 'utf8');
    }
  })(root, '');
  return out;
}

/** Capture console.log around an async fn; restores even on throw. */
async function captureStdout(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const result = await fn();
    return { lines, result };
  } finally {
    console.log = orig;
  }
}

function runScript(script, args) {
  return spawnSync(process.execPath, [join(SKILL_SCRIPTS, script), ...args], { encoding: 'utf8' });
}

test('framework API: listMigrations exposes 001 metadata in order', async () => {
  const all = await listMigrations();
  assert.ok(all.length >= 1);
  const m = all.find((x) => x.id === '001-stamp-provenance');
  assert.ok(m, '001-stamp-provenance registered');
  assert.equal(m.fromSchema, null);
  assert.equal(m.toSchema, 1);
  assert.match(m.description, /provenance/);
  // ids are sorted by numeric prefix
  const ids = all.map((x) => x.id);
  assert.deepEqual(ids, [...ids].sort());
});

test('--check (default) lists pending migrations + affected files WITHOUT writing', async () => {
  seedArtifacts();
  const before = snapshot(proj);

  const { lines, result: code } = await captureStdout(() => migrateMain([proj]));

  assert.equal(code, 0);
  assert.deepEqual(snapshot(proj), before, '--check must not touch a single byte');
  const out = lines.join('\n');
  assert.match(out, /check mode: no changes made/);
  assert.match(out, /\[would-apply\] 001-stamp-provenance/);
  assert.match(out, /\.archgen\/demo-shop\/tasks\.yaml/);
  assert.match(out, /\.archgen\/demo-shop\/architecture\.yaml/);
  assert.match(out, /Summary: 1 migration\(s\) pending, 2 file\(s\) would change/);
});

test('--apply stamps provenance comments and snapshots each file into migrate backups', async () => {
  const dir = seedArtifacts();

  const { lines, result: code } = await captureStdout(() => migrateMain([proj, '--apply']));

  assert.equal(code, 0);
  const tasks = readFileSync(join(dir, 'tasks.yaml'), 'utf8');
  const arch = readFileSync(join(dir, 'architecture.yaml'), 'utf8');
  for (const [name, content] of [['tasks.yaml', tasks], ['architecture.yaml', arch]]) {
    const ls = content.split('\n');
    assert.equal(ls[0], '# schema_version: 1', `${name} line 1`);
    assert.match(ls[1], /^# generator: archgen( v\d+\.\d+\.\d+)?$/, `${name} line 2`);
    assert.match(ls[2], /^# generated_at: /, `${name} line 3`);
    assert.ok(!Number.isNaN(Date.parse(ls[2].slice('# generated_at: '.length))), `${name} generated_at is ISO`);
    const original = name === 'tasks.yaml' ? TASKS_SRC : ARCH_SRC;
    assert.ok(content.endsWith(original), `${name} original body appended verbatim`);
  }

  // Backups hold the ORIGINAL bytes under .archgen/.backup/<ts>/migrate/<rel>.
  const backupRoot = join(proj, '.archgen', '.backup');
  const tsDirs = readdirSync(backupRoot);
  assert.equal(tsDirs.length, 1, 'one timestamped backup group per run');
  for (const f of ['tasks.yaml', 'architecture.yaml']) {
    const bak = join(backupRoot, tsDirs[0], 'migrate', '.archgen', 'demo-shop', f);
    assert.ok(existsSync(bak), `backup exists for ${f}`);
    assert.equal(readFileSync(bak, 'utf8'), f === 'tasks.yaml' ? TASKS_SRC : ARCH_SRC, `backup of ${f} is byte-identical original`);
  }
  assert.match(lines.join('\n'), /\[applied\] 001-stamp-provenance/);
  assert.match(lines.join('\n'), /backup: \.archgen\/\.backup\//);
});

test('idempotent: second run reports nothing pending and changes nothing', async () => {
  seedArtifacts();
  await captureStdout(() => migrateMain([proj, '--apply']));
  const afterFirst = snapshot(proj);

  // Default check run: nothing pending.
  const { lines, result: code1 } = await captureStdout(() => migrateMain([proj]));
  assert.equal(code1, 0);
  assert.match(lines.join('\n'), /nothing to do — all migrations applied/);
  assert.doesNotMatch(lines.join('\n'), /would-apply/);

  // Explicit --apply re-run: also a no-op on disk.
  const { result: code2 } = await captureStdout(() => migrateMain([proj, '--apply']));
  assert.equal(code2, 0);
  assert.deepEqual(snapshot(proj), afterFirst, 're-apply must be byte-for-byte inert');

  assert.deepEqual(await pendingMigrations(proj), []);
});

test('set-status.mjs works on a stamped tasks.yaml: status flips, stamp survives verbatim', async () => {
  const dir = seedArtifacts();
  const tasksPath = join(dir, 'tasks.yaml');
  const r0 = await applyMigration('001-stamp-provenance', proj, { dryRun: false });
  assert.equal(r0.status, 'applied');

  const r = runScript('set-status.mjs', [tasksPath, 'C', 'running']);
  assert.equal(r.status, 0, r.stderr);

  const after = readFileSync(tasksPath, 'utf8');
  const ls = after.split('\n');
  assert.equal(ls[0], '# schema_version: 1', 'stamp line 1 intact at top');
  assert.match(ls[1], /^# generator: archgen( v\d+\.\d+\.\d+)?$/, 'stamp line 2 intact');
  assert.match(ls[2], /^# generated_at: /, 'stamp line 3 intact');
  assert.match(after, /status: running/, 'status mutation landed');
  assert.ok(after.includes('# comment lines are preserved by set-status.mjs — annotate freely'), 'body comments preserved');
  assert.ok(after.includes('# Core pipeline — do first'));
});

test('verify-plan.mjs APPROVEs a stamped fixture copied from the yaml corpus', async () => {
  const dir = seedArtifacts('corpus-check');
  const plansDir = join(proj, 'plans-x');
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(join(plansDir, 'plan.md'), '# Plan\nDo C first, then B, then A. Acceptance per tasks.yaml.\n');

  const r0 = await applyMigration('001-stamp-provenance', proj, { dryRun: false });
  assert.equal(r0.status, 'applied');
  assert.match(readFileSync(join(dir, 'tasks.yaml'), 'utf8'), /^# schema_version: 1/);

  const r = runScript('verify-plan.mjs', [join(dir, 'tasks.yaml'), '--plan', plansDir]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(JSON.parse(r.stdout).verdict, 'APPROVE');
});

test('applyMigration API: unknown id -> not-found; clean project -> clean; dryRun default refuses backup', async () => {
  assert.equal((await applyMigration('999-nope', proj)).status, 'not-found');
  assert.equal((await applyMigration('001-stamp-provenance', proj)).status, 'clean', 'no artifacts -> nothing pending');

  seedArtifacts();
  // dryRun defaults to TRUE: detect fires but nothing may be written.
  const before = snapshot(proj);
  const dry = await applyMigration('001-stamp-provenance', proj);
  assert.equal(dry.status, 'would-apply');
  assert.deepEqual(dry.files.sort(), ['.archgen/demo-shop/architecture.yaml', '.archgen/demo-shop/tasks.yaml']);
  assert.deepEqual(snapshot(proj), before, 'default dry-run wrote nothing');

  const ctxBackupThrows = await import('../lib/migrations/index.mjs').then(({ makeCtx }) => {
    const ctx = makeCtx(proj, { dryRun: true });
    try { ctx.backup('.archgen/demo-shop/tasks.yaml'); return false; } catch { return true; }
  });
  assert.ok(ctxBackupThrows, 'ctx.backup() must throw under dry-run');
});

test('--migration targets one id; usage errors exit 2', async () => {
  seedArtifacts();
  const { lines, result: code } = await captureStdout(() =>
    migrateMain([proj, '--apply', '--migration', '001-stamp-provenance']));
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /\[applied\] 001-stamp-provenance/);

  let r = await captureStdout(() => migrateMain([proj, '--migration', '999-nope']));
  assert.equal(r.result, 2);
  r = await captureStdout(() => migrateMain([proj, '--check', '--apply']));
  assert.equal(r.result, 2, '--check + --apply mutually exclusive');
  r = await captureStdout(() => migrateMain([proj, '--bogus']));
  assert.equal(r.result, 2, 'unknown flag rejected');
});

test('projects without .archgen/ are up to date (no crash, no writes)', async () => {
  const before = snapshot(proj);
  const { lines, result: code } = await captureStdout(() => migrateMain([proj]));
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /up to date/);
  assert.deepEqual(snapshot(proj), before);
});

// Guard: the canonical corpus itself must stay unstamped — tests copy it out,
// they never mutate it.
test('canonical yaml-corpus files remain unstamped (additive-only contract)', () => {
  for (const f of ['tasks-block.yaml', 'architecture.yaml']) {
    assert.doesNotMatch(readFileSync(join(CORPUS, f), 'utf8'), /^#\s*schema_version:/m, `${f} must stay canonical`);
  }
});
