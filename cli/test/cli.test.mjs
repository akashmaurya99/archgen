// CLI tests: init + global install/uninstall round-trips.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../lib/init.js';
import { installGlobal, uninstallGlobal } from '../lib/install.js';
import { renderBlock, upsertBlock, stripBlock, START } from '../lib/block.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..');
let proj, home;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'ag-proj-'));
  home = mkdtempSync(join(tmpdir(), 'ag-home-'));
});
afterEach(() => { rmSync(proj, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

test('init copies skill to both harness dirs and writes context pointers', () => {
  const r = initProject(proj, CLI);
  assert.equal(r.skillCopies.length, 2);
  assert.ok(existsSync(join(proj, '.agents/skills/archgen/SKILL.md')));
  assert.ok(existsSync(join(proj, '.claude/skills/archgen/SKILL.md')));
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const c = readFileSync(join(proj, f), 'utf8');
    assert.match(c, /archgen:start/);
    assert.match(c, /\.agents\/skills\/archgen\/SKILL\.md/);
  }
});

test('init preserves existing user content in AGENTS.md', () => {
  writeFileSync(join(proj, 'AGENTS.md'), '# My rules\n\nBe terse.\n');
  initProject(proj, CLI);
  const c = readFileSync(join(proj, 'AGENTS.md'), 'utf8');
  assert.ok(c.startsWith('# My rules'));
  assert.match(c, /archgen:start/);
});

test('init is idempotent (single managed block after re-run)', () => {
  initProject(proj, CLI);
  initProject(proj, CLI);
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    assert.equal(readFileSync(join(proj, f), 'utf8').split('archgen:start').length, 2);
  }
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

test('block writer: upsert replaces, strip removes, orphan throws', () => {
  const block = renderBlock('.agents/skills/archgen');
  let doc = upsertBlock('', block);
  doc = upsertBlock(doc, renderBlock('.claude/skills/archgen')); // replace-in-place
  assert.equal(doc.split('archgen:start').length, 2);
  assert.match(doc, /\.claude\/skills\/archgen/); // replaced content took effect
  const { content, hadBlock } = stripBlock(doc);
  assert.equal(hadBlock, true);
  assert.equal(content.trim(), '');
  assert.throws(() => upsertBlock(START + ' orphan', 'B'), /one archgen marker/);
});
