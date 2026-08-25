// CLI tests: single-store init, claude symlink adapter, managed blocks,
// divergence→backup safety, legacy dual-copy migration, doctor repairs,
// project uninstall round-trip, and global install/uninstall.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  mkdtempSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../lib/init.js';
import { installGlobal, uninstallGlobal } from '../lib/install.js';
import { doctorProject } from '../lib/doctor.js';
import { uninstallProject } from '../lib/uninstall-project.js';
import {
  renderBlock,
  upsertBlock,
  stripBlock,
  upsertFeaturesRegistry,
  START,
  END,
  FEATURES_START,
  FEATURES_END,
} from '../lib/block.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(CLI, 'vendor', 'skills', 'archgen');
const VERSION = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')).version;
const STORE = (p) => join(p, '.agents', 'skills', 'archgen');
const CLAUDE_LINK = (p) => join(p, '.claude', 'skills', 'archgen');

function lstatSafe(p) {
  try { return lstatSync(p); } catch { return null; }
}

let proj, home;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'ag-proj-'));
  home = mkdtempSync(join(tmpdir(), 'ag-home-'));
});

afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function legacyDualCopy() {
  // Simulate the pre-single-store layout: two full real copies, no stamp.
  mkdirSync(join(proj, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(proj, '.claude', 'skills'), { recursive: true });
  cpSync(VENDOR, STORE(proj), { recursive: true });
  cpSync(VENDOR, CLAUDE_LINK(proj), { recursive: true });
}

test('init creates ONE canonical store + relative claude symlink (no second copy)', () => {
  const r = initProject(proj, CLI);
  assert.equal(r.storePath, STORE(proj));
  assert.ok(existsSync(join(STORE(proj), 'SKILL.md')));
  const storeStat = lstatSync(STORE(proj));
  assert.ok(storeStat.isDirectory() && !storeStat.isSymbolicLink());

  assert.equal(readFileSync(join(STORE(proj), '.archgen-version'), 'utf8').trim(), VERSION);

  const linkStat = lstatSync(CLAUDE_LINK(proj));
  assert.ok(linkStat.isSymbolicLink(), '.claude/skills/archgen must be a symlink, not a real dir');
  assert.equal(readlinkSync(CLAUDE_LINK(proj)), '../../.agents/skills/archgen');
  assert.equal(realpathSync(CLAUDE_LINK(proj)), realpathSync(STORE(proj)));

  assert.equal(r.claudeLink, 'created');
  assert.deepEqual(r.backups, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.contextFiles, ['AGENTS.md', 'CLAUDE.md']);
  assert.deepEqual(r.createdContextFiles, ['AGENTS.md', 'CLAUDE.md']);
});

test('init writes AGENTS.md block with empty features registry + CLAUDE.md @AGENTS.md bridge + manifest', () => {
  initProject(proj, CLI);

  const agents = readFileSync(join(proj, 'AGENTS.md'), 'utf8');
  assert.equal(agents.split(START).length, 2, 'exactly one managed block');
  assert.match(agents, /\.agents\/skills\/archgen\/SKILL\.md/);
  const fi = agents.indexOf(FEATURES_START);
  const fe = agents.indexOf(FEATURES_END);
  assert.ok(fi !== -1 && fe > fi, 'features markers inside managed block');
  assert.equal(
    agents.slice(fi + FEATURES_START.length, fe).replace(/^\n+|\n+$/g, ''),
    '| Feature | Status | Updated |\n| --- | --- | --- |',
    'initial registry is the empty table header',
  );
  assert.ok(fe < agents.indexOf(END), 'features registry sits before the block end marker');

  const claude = readFileSync(join(proj, 'CLAUDE.md'), 'utf8');
  const s = claude.indexOf(START);
  const e = claude.indexOf(END);
  assert.equal(claude.slice(s + START.length, e).replace(/^\n+|\n+$/g, ''), '@AGENTS.md');

  const manifest = JSON.parse(readFileSync(join(proj, '.archgen', '.install-manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.ok(!Number.isNaN(Date.parse(manifest.createdAt)), 'createdAt is ISO');
  const paths = manifest.entries.map((en) => [en.kind, en.path].join(':'));
  assert.ok(paths.includes('dir:.agents/skills/archgen'));
  assert.ok(paths.includes('link:.claude/skills/archgen'));
  assert.ok(paths.includes('block:AGENTS.md'));
  assert.ok(paths.includes('block:CLAUDE.md'));
  for (const en of manifest.entries) assert.ok(!Number.isNaN(Date.parse(en.createdAt)));
});

test('CLAUDE.md already-imports detection leaves file byte-identical (BOM + CRLF preserved)', () => {
  const original = '\uFEFF# Claude rules\r\n\r\n@AGENTS.md\r\n';
  writeFileSync(join(proj, 'CLAUDE.md'), original);
  const r = initProject(proj, CLI);
  assert.ok(!r.contextFiles.includes('CLAUDE.md'), 'CLAUDE.md not rewritten');
  assert.ok(r.warnings.some((w) => w.includes('already-imports')));
  assert.equal(readFileSync(join(proj, 'CLAUDE.md'), 'utf8'), original, 'byte-for-byte untouched');
});

test('CRLF+BOM CLAUDE.md without import gets bridge appended preserving BOM and CRLF', () => {
  writeFileSync(join(proj, 'CLAUDE.md'), '\uFEFF# Claude rules\r\nBe terse.\r\n');
  initProject(proj, CLI);
  const c = readFileSync(join(proj, 'CLAUDE.md'), 'utf8');
  assert.equal(c.charCodeAt(0), 0xfeff, 'BOM preserved');
  assert.ok(c.startsWith('\uFEFF# Claude rules\r\nBe terse.'), 'user content intact');
  assert.ok(c.includes('\r\n\r\n' + START + '\r\n@AGENTS.md\r\n' + END + '\r\n'), 'bridge uses CRLF');
});

test('divergent store is backed up first, then replaced fresh', () => {
  initProject(proj, CLI);
  writeFileSync(join(STORE(proj), 'SKILL.md'), 'USER EDIT X\n');
  const vendorSkill = readFileSync(join(VENDOR, 'SKILL.md'), 'utf8');

  const r2 = initProject(proj, CLI);
  assert.equal(r2.backups.length, 1);
  const backupRel = r2.backups[0];
  assert.match(backupRel, /^\.archgen\/\.backup\//);
  assert.ok(readFileSync(join(proj, backupRel, 'SKILL.md'), 'utf8').includes('USER EDIT X'));
  assert.equal(readFileSync(join(STORE(proj), 'SKILL.md'), 'utf8'), vendorSkill, 'store restored to canonical');
  assert.equal(readFileSync(join(STORE(proj), '.archgen-version'), 'utf8').trim(), VERSION);
});

test('identical store refreshes in place without backup (idempotent)', () => {
  initProject(proj, CLI);
  const r2 = initProject(proj, CLI);
  assert.deepEqual(r2.backups, []);
  assert.equal(r2.claudeLink, 'existing');
  assert.equal(readFileSync(join(proj, 'AGENTS.md'), 'utf8').split(START).length, 2);
  assert.equal(readFileSync(join(STORE(proj), '.archgen-version'), 'utf8').trim(), VERSION);
});

test('legacy dual-copy migration: identical claude copy becomes symlink (migrated)', () => {
  legacyDualCopy();
  const r = initProject(proj, CLI);
  assert.equal(r.claudeLink, 'migrated');
  assert.ok(lstatSync(CLAUDE_LINK(proj)).isSymbolicLink());
  assert.ok(!lstatSync(CLAUDE_LINK(proj)).isDirectory());
  assert.deepEqual(r.backups, [], 'unmodified legacy store refreshes without backup');
  assert.ok(existsSync(join(STORE(proj), '.archgen-version')), 'stamp added on refresh');
});

test('legacy dual-copy migration: modified claude copy kept with warning', () => {
  legacyDualCopy();
  writeFileSync(join(CLAUDE_LINK(proj), 'SKILL.md'), 'CUSTOMIZED\n', { flag: 'a' });
  const r = initProject(proj, CLI);
  assert.equal(r.claudeLink, 'kept-divergent');
  assert.ok(r.warnings.some((w) => w.includes('user-customized claude copy kept')));
  const st = lstatSync(CLAUDE_LINK(proj));
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), 'real dir left in place');
  assert.ok(readFileSync(join(CLAUDE_LINK(proj), 'SKILL.md'), 'utf8').includes('CUSTOMIZED'));
});

test('uninstall removes link/blocks/store/manifest but preserves feature folders and backups', () => {
  writeFileSync(join(proj, 'AGENTS.md'), '# My rules\n\nBe terse.\n');
  initProject(proj, CLI);
  mkdirSync(join(proj, '.archgen', 'booking-platform'), { recursive: true });
  writeFileSync(join(proj, '.archgen', 'booking-platform', 'architecture.yaml'), 'slug: booking-platform\n');
  mkdirSync(join(proj, '.archgen', '.backup', 'old'), { recursive: true });
  writeFileSync(join(proj, '.archgen', '.backup', 'old', 'keep.txt'), 'x');

  const u = uninstallProject(proj, CLI);
  assert.equal(u.linkRemoved, true);
  assert.deepEqual(u.strippedBlocks.sort(), ['AGENTS.md', 'CLAUDE.md']);
  assert.equal(u.storeRemoved, true);
  assert.equal(u.manifestRemoved, true);
  assert.deepEqual(u.warnings, []);

  assert.ok(!existsSync(CLAUDE_LINK(proj)));
  assert.ok(!existsSync(STORE(proj)));
  assert.ok(!existsSync(join(proj, '.archgen', '.install-manifest.json')));

  const agents = readFileSync(join(proj, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith('# My rules'), 'user content survives');
  assert.ok(!agents.includes('archgen:start'));
  const claude = readFileSync(join(proj, 'CLAUDE.md'), 'utf8');
  assert.ok(!claude.includes('@AGENTS.md'));

  assert.equal(readFileSync(join(proj, '.archgen', 'booking-platform', 'architecture.yaml'), 'utf8'), 'slug: booking-platform\n');
  assert.equal(readFileSync(join(proj, '.archgen', '.backup', 'old', 'keep.txt'), 'utf8'), 'x');
});

test('uninstall keeps a customized store with a warning', () => {
  initProject(proj, CLI);
  writeFileSync(join(STORE(proj), 'references', 'platforms.md'), 'MY NOTES\n', { flag: 'a' });

  const u = uninstallProject(proj, CLI);
  assert.equal(u.storeKept, true);
  assert.equal(u.storeRemoved, false);
  assert.ok(u.warnings.some((w) => w.includes('kept')));
  assert.ok(existsSync(join(STORE(proj), 'SKILL.md')));
  assert.ok(readFileSync(join(STORE(proj), 'references', 'platforms.md'), 'utf8').includes('MY NOTES'));
});

test('doctor recreates a missing/dangling claude link; --check reports only', () => {
  initProject(proj, CLI);
  unlinkSync(CLAUDE_LINK(proj));

  const d1 = doctorProject(proj, CLI);
  assert.equal(d1.failures, 0);
  assert.ok(d1.checks.some((c) => c.status === 'FIXED' && /claude link/.test(c.msg)));
  assert.ok(lstatSync(CLAUDE_LINK(proj)).isSymbolicLink());

  unlinkSync(CLAUDE_LINK(proj));
  const d2 = doctorProject(proj, CLI, { check: true });
  assert.ok(d2.checks.some((c) => c.status === 'WOULD-FIX' && /claude link/.test(c.msg)));
  assert.equal(lstatSafe(CLAUDE_LINK(proj)), null, '--check must not mutate');
  assert.equal(d2.failures, 0);
});

test('doctor updates a stale version stamp and prunes stale manifest entries', () => {
  initProject(proj, CLI);
  writeFileSync(join(STORE(proj), '.archgen-version'), '0.0.1\n');
  const mPath = join(proj, '.archgen', '.install-manifest.json');
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  m.entries.push({ kind: 'dir', path: '.agents/skills/archgen/gone', createdAt: new Date().toISOString() });
  writeFileSync(mPath, JSON.stringify(m, null, 2));

  const d = doctorProject(proj, CLI);
  assert.equal(d.failures, 0);
  assert.equal(readFileSync(join(STORE(proj), '.archgen-version'), 'utf8').trim(), VERSION);
  const after = JSON.parse(readFileSync(mPath, 'utf8')).entries;
  assert.ok(!after.some((e) => e.path === '.agents/skills/archgen/gone'));
});

test('global install/uninstall round-trip in sandbox HOME', () => {
  mkdirSync(join(home, '.claude/skills'), { recursive: true });
  mkdirSync(join(home, '.agents/skills'), { recursive: true });
  const r1 = installGlobal({ home });
  assert.equal(r1.failures, 0);
  assert.ok(existsSync(join(home, '.claude/skills/archgen/SKILL.md')));
  const r2 = installGlobal({ home });
  assert.ok(r2.rows.filter((r) => r[0] === 'SAME').length >= 2); // idempotent
  const u = uninstallGlobal(home);
  assert.ok(u.removed >= 2);
  assert.ok(!existsSync(join(home, '.claude/skills/archgen')));
  assert.equal(uninstallGlobal(home).noop, true);
});

test('block writer: upsert replaces, strip removes, orphan throws; features registry upserts', () => {
  const block = renderBlock('.agents/skills/archgen');
  assert.ok(block.includes(FEATURES_START) && block.includes(FEATURES_END));
  let doc = upsertBlock('', block);
  doc = upsertBlock(doc, renderBlock('.claude/skills/archgen')); // replace-in-place
  assert.equal(doc.split('archgen:start').length, 2);
  assert.match(doc, /\.claude\/skills\/archgen/); // replaced content took effect
  const { content, hadBlock } = stripBlock(doc);
  assert.equal(hadBlock, true);
  assert.equal(content.trim(), '');
  assert.throws(() => upsertBlock(START + ' orphan', 'B'), /one archgen marker/);

  const f = join(proj, 'FR.md');
  writeFileSync(f, renderBlock('.agents/skills/archgen') + '\n');
  upsertFeaturesRegistry(f, [['auth', 'done', '2026-08-25']]);
  let c = readFileSync(f, 'utf8');
  assert.match(c, /\| auth \| done \| 2026-08-25 \|/);
  assert.equal(c.split(FEATURES_START).length, 2);
  assert.equal(c.split(FEATURES_END).length, 2);
  upsertFeaturesRegistry(f, []);
  c = readFileSync(f, 'utf8');
  assert.ok(c.includes('| Feature | Status | Updated |\n| --- | --- | --- |\n' + FEATURES_END));
  assert.doesNotMatch(c, /auth/);
  const plain = join(proj, 'plain.md');
  writeFileSync(plain, '# no archgen here\n');
  assert.throws(() => upsertFeaturesRegistry(plain, []), /no archgen managed block/);
});
