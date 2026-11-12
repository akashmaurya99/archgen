// compat.test.mjs — the capability contract.
//
// The skill calls the server's tools. An UNDECLARED dependency is a latent
// outage: a skill at v1 driving a server at v2 whose action names changed
// fails silently. These tests pin the declaration, the comparison and the
// failure mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { satisfies, compareVersions, parseVersion, readSkillRequirements, checkCapability } from '../../src/core/protocol/compat.mjs';

function skillWith(frontmatter) {
  const dir = mkdtempSync(join(tmpdir(), 'archgen-compat-'));
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# skill\n`, 'utf8');
  return dir;
}

// ── version comparison ──────────────────────────────────────────────────────

test('compareVersions orders correctly', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.2', '1.2.3'), -1);
  assert.equal(compareVersions('1.3.0', '1.2.9'), 1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
});

test('parseVersion accepts an optional v prefix and a prerelease suffix', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseVersion('1.2.3-beta.1'), { major: 1, minor: 2, patch: 3 });
  assert.equal(parseVersion('not-a-version'), null);
});

// ── requirement satisfaction ────────────────────────────────────────────────

test('>= is inclusive and rejects an older version', () => {
  assert.equal(satisfies('1.2.3', '>=1.2.3'), true);
  assert.equal(satisfies('1.2.4', '>=1.2.3'), true);
  assert.equal(satisfies('1.2.2', '>=1.2.3'), false);
});

test('> is exclusive', () => {
  assert.equal(satisfies('1.2.3', '>1.2.3'), false);
  assert.equal(satisfies('1.2.4', '>1.2.3'), true);
});

test('an exact requirement matches only that version', () => {
  assert.equal(satisfies('1.2.3', '1.2.3'), true);
  assert.equal(satisfies('1.2.4', '1.2.3'), false);
});

test('^ stays inside the major, ~ inside the major+minor', () => {
  assert.equal(satisfies('1.9.0', '^1.2.3'), true);
  assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
});

test('an unparseable requirement is REJECTED, never vacuously satisfied', () => {
  assert.throws(() => satisfies('1.2.3', 'latest-ish'), (e) => e.code === 'INVALID_INPUT');
});

test('an empty requirement means no constraint', () => {
  assert.equal(satisfies('1.2.3', ''), true);
});

// ── reading the declaration ─────────────────────────────────────────────────

test('the requires block is read out of the frontmatter', () => {
  const dir = skillWith(
    ['name: archgen', 'metadata:', '  version: 1.2.3', '  requires:', '    archgen_mcp: ">=1.2.3"'].join('\n'),
  );
  try {
    const req = readSkillRequirements(dir);
    assert.equal(req.version, '1.2.3');
    assert.deepEqual(req.requires, { archgen_mcp: '>=1.2.3' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a skill with no requires block yields no requirement', () => {
  const dir = skillWith(['name: archgen', 'metadata:', '  version: 1.2.3'].join('\n'));
  try {
    assert.deepEqual(readSkillRequirements(dir).requires, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or malformed SKILL.md yields no requirement (never throws)', () => {
  assert.deepEqual(readSkillRequirements(null).requires, {});
  const dir = mkdtempSync(join(tmpdir(), 'archgen-compat-'));
  try {
    assert.deepEqual(readSkillRequirements(dir).requires, {});
    writeFileSync(join(dir, 'SKILL.md'), 'no frontmatter here\n', 'utf8');
    assert.deepEqual(readSkillRequirements(dir).requires, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the check ───────────────────────────────────────────────────────────────

test('a compatible skill passes', () => {
  const dir = skillWith(['metadata:', '  requires:', '    archgen_mcp: ">=1.2.3"'].join('\n'));
  try {
    const r = checkCapability({ skillDir: dir, serverVersion: '1.2.3' });
    assert.equal(r.compatible, true);
    assert.equal(r.required, '>=1.2.3');
    assert.equal(r.reason, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an incompatible skill is reported WITH the reason', () => {
  const dir = skillWith(['metadata:', '  requires:', '    archgen_mcp: ">=1.3.0"'].join('\n'));
  try {
    const r = checkCapability({ skillDir: dir, serverVersion: '1.2.3' });
    assert.equal(r.compatible, false);
    assert.match(r.reason, /requires archgen-mcp >=1\.3\.0/);
    assert.match(r.reason, /this server is 1\.2\.3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no skill means no contract to check', () => {
  const r = checkCapability({ skillDir: null, serverVersion: '1.2.3' });
  assert.equal(r.compatible, true);
  assert.equal(r.required, null);
});
