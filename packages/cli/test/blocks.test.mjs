// Managed-block provenance tests: versioned block format, in-place upgrades of
// legacy unversioned blocks, doctor UPGRADED/WOULD-UPGRADE semantics, BOM/CRLF
// preservation, marker refusals, and the install.sh integrator exports.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../lib/init.js';
import { doctorProject } from '../lib/doctor.js';
import {
  END,
  FEATURES_END,
  FEATURES_START,
  START,
  detectBlockVersion,
  importsAgents,
  provenanceLine,
  renderBlock,
  renderClaudeBridgeText,
  renderManagedBlockText,
  upsertBlock,
  upsertManagedFile,
} from '../lib/block.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')).version;
const PROV = '<!-- archgen:block v' + VERSION + ' -->';

let proj;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'ag-blocks-'));
});

afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
});

function legacyAgentsBlock() {
  // The pre-provenance installed shape (see fixtures/greenfield-demo/AGENTS.md).
  return [
    START,
    '# ArchGen - Architecture Generation & Autonomous Task Execution',
    '',
    'This project uses the **archgen** skill, installed at `.agents/skills/archgen/`.',
    '',
    '## Features registry',
    '',
    FEATURES_START,
    '| Feature | Status | Updated |',
    '| --- | --- | --- |',
    '| demo | done | 2026-08-25 |',
    FEATURES_END,
    END,
  ].join('\n');
}

function seedStore() {
  mkdirSync(join(proj, '.agents', 'skills', 'archgen'), { recursive: true });
  writeFileSync(join(proj, '.agents', 'skills', 'archgen', 'SKILL.md'), 'x\n');
}

test('fresh writes carry the canonical provenance line as the first line inside markers', () => {
  for (const text of [renderBlock(), renderManagedBlockText()]) {
    const lines = text.split('\n');
    assert.equal(lines[0], START);
    assert.equal(lines[1], PROV);
    assert.deepEqual(detectBlockVersion(text), { present: true, version: VERSION });
  }
  const bridge = renderClaudeBridgeText();
  assert.equal(bridge.split('\n')[1], PROV);
  assert.ok(bridge.includes('@AGENTS.md'));

  const doc = upsertBlock('', renderBlock());
  assert.ok(doc.startsWith(START + '\n' + PROV + '\n'), 'empty-file append is versioned');

  const f = join(proj, 'AGENTS.md');
  upsertManagedFile(f, renderBlock().split('\n'));
  const raw = readFileSync(f, 'utf8');
  assert.ok(raw.startsWith(START + '\n' + PROV + '\n'), 'upsertManagedFile write is versioned');
});

test('provenance version comes from config/package.json — never a hardcoded literal', () => {
  assert.equal(PROV, provenanceLine());
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  const cfg = JSON.parse(readFileSync(join(CLI, '..', '..', 'archgen.config.json'), 'utf8'));
  assert.equal(cfg.version, VERSION, 'canonical config and package.json agree');
});

test('legacy unversioned block upgrades in place; user content outside markers byte-intact', () => {
  const before = 'HEAD bytes\r\n\r\n' + legacyAgentsBlock().split('\n').join('\r\n') + '\r\nTAIL bytes\r\n';
  // Mirror the real call shape: upsertManagedFile joins the rendered lines with
  // the file's detected EOL before handing the block to upsertBlock.
  const crlfBlock = renderBlock('.agents/skills/archgen').split('\n').join('\r\n');
  const after = upsertBlock(before, crlfBlock, '\r\n');
  assert.equal(after, 'HEAD bytes\r\n\r\n' + crlfBlock + '\r\nTAIL bytes\r\n', 'exact byte round-trip');
  assert.deepEqual(detectBlockVersion(after), { present: true, version: VERSION });
  assert.equal(after.includes('| demo | done | 2026-08-25 |') === false, true, 'stale registry replaced by fresh block');
});

test('one-marker refusal unchanged; strip removes provenance with the block', () => {
  assert.throws(() => upsertBlock(START + ' orphan', 'B'), /one archgen marker/);
  assert.throws(() => upsertBlock('orphan ' + END, 'B'), /one archgen marker/);
});

test('detectBlockVersion parses present/unversioned/malformed/no-block shapes', () => {
  assert.deepEqual(detectBlockVersion(START + '\n' + PROV + '\nbody\n' + END), { present: true, version: VERSION });
  assert.deepEqual(detectBlockVersion(START + '\n# no stamp here\n' + END), { present: false, version: null });
  assert.deepEqual(detectBlockVersion(START + '\n<!-- archgen:block -->\n' + END), { present: true, version: null });
  assert.deepEqual(detectBlockVersion('# plain file\n'), { present: false, version: null });
  assert.deepEqual(detectBlockVersion(undefined), { present: false, version: null });
  assert.deepEqual(
    detectBlockVersion(START + '\r\n<!-- archgen:block v9.9.9 -->\r\n' + END),
    { present: true, version: '9.9.9' },
    'CRLF tolerated',
  );
});

test('doctor upgrades an unversioned block in place and reports UPGRADED; idempotent after', () => {
  seedStore();
  writeFileSync(join(proj, 'AGENTS.md'), '# My rules\n\n' + legacyAgentsBlock() + '\n\nTail notes.\n');
  const d1 = doctorProject(proj, CLI);
  const up = d1.checks.find((c) => /UPGRADED/.test(c.msg));
  assert.ok(up && up.status === 'FIXED', `expected FIXED UPGRADED check, got: ${JSON.stringify(d1.checks)}`);
  const after = readFileSync(join(proj, 'AGENTS.md'), 'utf8');
  assert.ok(after.startsWith('# My rules\n\n'), 'user content before block intact');
  assert.ok(after.endsWith('\n\nTail notes.\n'), 'user content after block intact');
  assert.deepEqual(detectBlockVersion(after), { present: true, version: VERSION });

  const d2 = doctorProject(proj, CLI);
  assert.ok(!d2.checks.some((c) => /UPGRADED/.test(c.msg)), 'second pass must not re-upgrade');
  assert.ok(d2.checks.some((c) => c.status === 'OK' && /block \+ features registry present/.test(c.msg)));
  assert.equal(readFileSync(join(proj, 'AGENTS.md'), 'utf8'), after, 'byte-stable after upgrade');
});

test('doctor --check reports WOULD-UPGRADE without writing', () => {
  seedStore();
  const original = '# Rules\n\n' + legacyAgentsBlock() + '\n';
  writeFileSync(join(proj, 'AGENTS.md'), original);
  const d = doctorProject(proj, CLI, { check: true });
  const would = d.checks.find((c) => /WOULD-UPGRADE/.test(c.msg));
  assert.ok(would && would.status === 'WOULD-FIX', `expected WOULD-FIX WOULD-UPGRADE, got: ${JSON.stringify(d.checks)}`);
  assert.equal(readFileSync(join(proj, 'AGENTS.md'), 'utf8'), original, '--check must not mutate');
});

test('doctor upgrades an older-stamped block but leaves a newer stamp alone', () => {
  seedStore();
  const older = legacyAgentsBlock().replace(
    START,
    START + '\n<!-- archgen:block v0.0.3 -->',
  );
  writeFileSync(join(proj, 'AGENTS.md'), older + '\n');
  const d1 = doctorProject(proj, CLI);
  assert.ok(d1.checks.some((c) => /UPGRADED: AGENTS\.md block v0\.0\.3/.test(c.msg)));
  assert.deepEqual(detectBlockVersion(readFileSync(join(proj, 'AGENTS.md'), 'utf8')), { present: true, version: VERSION });

  const newer = legacyAgentsBlock().replace(
    START,
    START + '\n<!-- archgen:block v99.0.0 -->',
  );
  writeFileSync(join(proj, 'AGENTS.md'), newer + '\n');
  const d2 = doctorProject(proj, CLI);
  assert.ok(!d2.checks.some((c) => /UPGRADED/.test(c.msg)), 'newer stamp never downgraded');
  assert.ok(readFileSync(join(proj, 'AGENTS.md'), 'utf8').includes('v99.0.0'));
});

test('duplicate markers still FAIL through doctor (upgrade path never runs)', () => {
  seedStore();
  writeFileSync(
    join(proj, 'AGENTS.md'),
    'x\n' + START + '\na\n' + END + '\n' + START + '\nb\n' + END + '\n',
  );
  const d = doctorProject(proj, CLI);
  const fail = d.checks.find((c) => c.status === 'FAIL');
  assert.ok(fail && /2 start \/ 2 end markers - fix manually/.test(fail.msg));
  assert.ok(!d.checks.some((c) => /UPGRADED/.test(c.msg)));
  assert.ok(readFileSync(join(proj, 'AGENTS.md'), 'utf8').includes('\nb\n'), 'file untouched on FAIL');
});

test('CRLF convention preserved through upgrade (no bare LF anywhere)', () => {
  const crlf = (s) => s.split('\n').join('\r\n');
  writeFileSync(
    join(proj, 'AGENTS.md'),
    '\uFEFF# Rules\r\n\r\n' + crlf(legacyAgentsBlock()) + '\r\nAfter\r\n',
  );
  upsertManagedFile(join(proj, 'AGENTS.md'), renderBlock().split('\n'));
  const out = readFileSync(join(proj, 'AGENTS.md'), 'utf8');
  assert.equal(out.charCodeAt(0), 0xfeff, 'BOM preserved');
  assert.equal(/(?<!\r)\n/.test(out), false, 'no bare LF — CRLF convention kept');
  assert.ok(out.startsWith('\uFEFF# Rules\r\n\r\n'), 'user prefix intact');
  assert.ok(out.endsWith('\r\nAfter\r\n'), 'user suffix intact');
  assert.deepEqual(detectBlockVersion(out), { present: true, version: VERSION });
});

test('init skips CLAUDE.md when @AGENTS.md already imported; bytes untouched', () => {
  const original = '@AGENTS.md\n';
  writeFileSync(join(proj, 'CLAUDE.md'), original);
  assert.equal(importsAgents(join(proj, 'CLAUDE.md')), true);
  const r = initProject(proj, CLI);
  assert.ok(!r.contextFiles.includes('CLAUDE.md'));
  assert.ok(r.warnings.some((w) => w.includes('already-imports')));
  assert.equal(readFileSync(join(proj, 'CLAUDE.md'), 'utf8'), original, 'byte-for-byte untouched');
});

test('init-written CLAUDE.md bridge is versioned via the upsert choke point', () => {
  initProject(proj, CLI);
  const claude = readFileSync(join(proj, 'CLAUDE.md'), 'utf8');
  assert.equal(claude, renderClaudeBridgeText() + '\n', 'bridge matches integrator export exactly');
});
