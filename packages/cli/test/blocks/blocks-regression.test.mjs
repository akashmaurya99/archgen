// Managed-block and migration fixes.
//
// L6: the duplicated-marker branch validated only the TAIL of the file, so an
//     orphan `<!-- archgen:end -->` BEFORE a well-formed block survived the
//     rewrite — upsertBlock created the broken state it is meant to normalize.
// L7: atomicWrite left its temp file behind when the rename failed, and its
//     'wx' flag made two writes inside the same millisecond fail with EEXIST
//     instead of retrying.
// M16: the migration framework backed up `mig.files(ctx)` and then called
//     `mig.apply(ctx)`, which re-derived its OWN file set — so a file created
//     between the two scans was mutated with no backup.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { END, START, atomicWrite, renderBlock, upsertBlock } from '../../lib/block.js';
import { makeCtx } from '../../lib/migrations/index.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ag-block-fix-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('L6: an orphan end marker BEFORE a well-formed block is refused', () => {
  const broken = END + '\n' + START + '\nbody\n' + END + '\n';
  assert.throws(
    () => upsertBlock(broken, renderBlock()),
    /one archgen marker/,
    'the orphan marker survived the rewrite',
  );
});

test('L6: a stray marker inside a block body is normalized (the body is replaced)', () => {
  const text = START + '\n' + START + '\nbody\n' + END + '\n';
  const out = upsertBlock(text, renderBlock());
  assert.equal(out.split(START).length, 2, 'exactly one block remains');
  assert.equal(out.split(END).length, 2, 'exactly one end marker remains');
});

test('L6: a well-formed file with a duplicated block is still normalized', () => {
  const text = 'HEAD\n' + START + '\nold a\n' + END + '\nMID\n' + START + '\nold b\n' + END + '\nTAIL\n';
  const out = upsertBlock(text, renderBlock());
  assert.equal(out.split(START).length, 2, 'exactly one block remains');
  assert.ok(out.startsWith('HEAD\n') && out.includes('MID') && out.includes('TAIL'));
});

test('L7: a failed rename leaves no temp file behind', () => {
  const target = join(dir, 'a-directory');
  mkdirSync(target);
  assert.throws(() => atomicWrite(target, 'x'), 'the rename onto a directory must fail');
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.includes('.tmp-')),
    [],
    'a temp file was left behind',
  );
});

test('L7: a temp-name collision is retried instead of failing the write', () => {
  const target = join(dir, 'file.txt');
  // Occupy every temp name the writer could pick in this window.
  const now = Date.now();
  for (let i = -5; i <= 50; i++) {
    try {
      writeFileSync(`${target}.tmp-${process.pid}-${now + i}`, 'occupied');
    } catch { /* ignore */ }
  }
  atomicWrite(target, 'hello');
  assert.equal(readFileSync(target, 'utf8'), 'hello');
  for (const n of readdirSync(dir)) {
    if (n.includes('.tmp-')) rmSync(join(dir, n));
  }
});

test('M16: a migration mutates exactly the files the framework backed up', async () => {
  const mig = await import('../../lib/migrations/001-stamp-provenance.mjs');
  const project = join(dir, 'project');
  mkdirSync(join(project, '.archgen', 'demo'), { recursive: true });
  mkdirSync(join(project, '.archgen', 'other'), { recursive: true });
  writeFileSync(join(project, '.archgen', 'demo', 'tasks.yaml'), 'tasks: []\n');
  writeFileSync(join(project, '.archgen', 'other', 'tasks.yaml'), 'tasks: []\n');

  const ctx = makeCtx(project, { dryRun: false });
  // The framework hands apply() the backed-up list: only that file may change.
  mig.apply(ctx, ['.archgen/demo/tasks.yaml']);

  assert.ok(
    readFileSync(join(project, '.archgen', 'demo', 'tasks.yaml'), 'utf8').includes('# schema_version:'),
    'the listed file was stamped',
  );
  assert.ok(
    !readFileSync(join(project, '.archgen', 'other', 'tasks.yaml'), 'utf8').includes('# schema_version:'),
    'a file outside the backed-up set was mutated',
  );
});

test('M16: the framework reports the backed-up file set as the applied set', async () => {
  const { applyMigration } = await import('../../lib/migrations/index.mjs');
  const project = join(dir, 'project2');
  mkdirSync(join(project, '.archgen', 'demo'), { recursive: true });
  writeFileSync(join(project, '.archgen', 'demo', 'tasks.yaml'), 'tasks: []\n');

  const r = await applyMigration('001-stamp-provenance', project, { dryRun: false });
  assert.equal(r.status, 'applied');
  assert.deepEqual(r.files, ['.archgen/demo/tasks.yaml']);
  assert.equal(r.backups.length, 1);
  assert.ok(existsSync(join(project, r.backups[0].backup)), 'the backup exists');
});
