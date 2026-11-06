// platform-caps + briefs — the capability registry and the dispatch briefs.
//
// These are the two data sets the references used to carry as markdown tables
// and prose blocks. The references point at the tools; these tests pin the data
// so the tables and the tool can never disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAsset, BRIEFS_DIR } from '../../src/context.mjs';
import { platformCapabilities, detectHarness } from '../../src/core/platform-caps.mjs';
import { loadBrief, loadAllBriefs, BRIEF_KINDS } from '../../src/core/briefs.mjs';

const caps = loadAsset('platform-capabilities.json');

test('every registered harness declares the four capability groups', () => {
  for (const [id, h] of Object.entries(caps.harnesses)) {
    assert.ok(h.label, `${id} needs a label`);
    assert.ok(h.skillPaths?.project?.length, `${id} needs a project skill path`);
    assert.ok(h.skillPaths?.global?.length, `${id} needs a global skill path`);
    assert.ok(h.mcpConfig && Object.keys(h.mcpConfig).length, `${id} needs an MCP config shape`);
    assert.ok(h.restart, `${id} needs its restart semantics`);
  }
});

test('the MCP config shapes use only the four known top-level keys', () => {
  const KNOWN = new Set(['mcpServers', 'servers', 'mcp', 'context_servers']);
  for (const [id, h] of Object.entries(caps.harnesses)) {
    for (const [loc, cfg] of Object.entries(h.mcpConfig)) {
      assert.ok(
        KNOWN.has(cfg.key) || cfg.key.startsWith('mcp_servers.'),
        `${id}.${loc} uses an unknown top-level key '${cfg.key}'`,
      );
    }
  }
});

test('the detection order names real harnesses', () => {
  assert.ok(caps.detectionOrder.length > 0);
  for (const marker of caps.detectionOrder) assert.ok(typeof marker === 'string' && marker.length > 0);
});

test('platformCapabilities returns one row, or every row', () => {
  const one = platformCapabilities(caps, 'claude');
  assert.equal(one.id, 'claude');
  assert.ok(one.mcpConfig.project);
  const all = platformCapabilities(caps, null);
  assert.ok(all.harnesses.length >= 9);
  assert.ok(all.universal);
});

test('an unknown harness is a typed NOT_FOUND', () => {
  assert.throws(
    () => platformCapabilities(caps, 'not-a-harness'),
    (e) => e.code === 'NOT_FOUND',
  );
});

test('detection finds the harness whose markers exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archgen-harness-'));
  try {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const project = join(dir, 'project');
    mkdirSync(join(project, '.claude'), { recursive: true });
    const found = detectHarness(caps, { projectRoot: project, home });
    assert.equal(found.primary.id, 'claude');
    assert.ok(found.capabilities.skillPaths.project.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an undetectable platform is a typed INVALID_INPUT with the procedure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archgen-harness-'));
  try {
    assert.throws(
      () => detectHarness(caps, { projectRoot: dir, home: dir }),
      (e) => e.code === 'INVALID_INPUT' && /unknown-platform/i.test(e.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every dispatch brief loads and is non-empty', () => {
  for (const kind of BRIEF_KINDS) {
    const { brief, kind: k } = loadBrief(BRIEFS_DIR, kind);
    assert.equal(k, kind);
    assert.ok(brief.length > 200, `the ${kind} brief is suspiciously short`);
    assert.match(brief, /TASK:/);
  }
});

test('the briefs reference the tools they depend on', () => {
  const all = loadAllBriefs(BRIEFS_DIR);
  assert.match(all.verifier, /archgen_plan/);
  assert.match(all.verifier, /archgen_docs/);
  assert.match(all.review, /archgen_plan/);
  assert.match(all.survey, /CodeGraph/);
  assert.match(all.investigate, /archgen_plan/);
});

test('brief placeholders are substituted', () => {
  const { brief } = loadBrief(BRIEFS_DIR, 'survey', { 'feature request': 'rate limiting' });
  assert.match(brief, /rate limiting/);
  assert.ok(!brief.includes('<feature request>'));
});

test('an unknown brief kind is a typed INVALID_INPUT', () => {
  assert.throws(
    () => loadBrief(BRIEFS_DIR, 'not-a-brief'),
    (e) => e.code === 'INVALID_INPUT',
  );
});
