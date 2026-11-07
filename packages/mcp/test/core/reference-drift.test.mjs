// reference-drift.test.mjs — the references and the MCP assets must agree.
//
// The split is: the references hold the JUDGMENT, the MCP assets hold the
// DETERMINISTIC DATA. That only works if the two do not contradict each
// other — e.g. if the depth ladder says MEDIUM needs 3 edge cases and the
// reference says 2, the agent gets two different answers.
//
// This test pins the numbers and the harness set that appear in BOTH places.
// It skips when the repo-level skill tree is absent (the published package
// ships no references/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAsset, TEMPLATES_DIR } from '../../src/context.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/mcp/test/core -> repo root (four levels up).
const REPO = join(HERE, '..', '..', '..', '..');
// The orchestrator-facing references moved into the MCP package (served by
// archgen_refs); code-standards.md stays in the skill (workers read it as a
// file — they may have no MCP tools).
const REFS = join(REPO, 'packages', 'mcp', 'assets', 'references');
const SKILL_REFS = join(REPO, 'skill', 'references');

const read = (name) => {
  const p = join(REFS, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

const ladder = loadAsset('depth-ladder.json');
const caps = loadAsset('platform-capabilities.json');

test('the five orchestrator-facing references live with the MCP server', () => {
  for (const name of ['interview.md', 'orchestration.md', 'artifact-templates.md', 'platforms.md', 'mcp-and-skills.md']) {
    assert.ok(existsSync(join(REFS, name)), `${name} must ship with the MCP server`);
  }
});

test('code-standards.md stays in the skill (workers may have no MCP tools)', () => {
  assert.ok(
    existsSync(join(SKILL_REFS, 'code-standards.md')),
    'code-standards.md must remain a plain file next to SKILL.md',
  );
  assert.ok(
    !existsSync(join(REFS, 'code-standards.md')),
    'code-standards.md must not be duplicated into the package — one copy, no drift',
  );
});

test('the depth ladder and artifact-templates.md agree on the edge-case minimum', () => {
  const ref = read('artifact-templates.md');
  if (!ref) return;
  // The pin must still carry the NUMBER, not just the phrase — that is the
  // whole point of the gate: the reference and the ladder can never disagree
  // about how many edge cases a MEDIUM task needs.
  assert.match(ref, /Edge cases[^\n]*\b3\b/, 'the reference must state the MEDIUM minimum');
  assert.equal(ladder.classes.MEDIUM.minEdgeCasesPerTask, 3);
  assert.ok(ladder.classes.LARGE.minEdgeCasesPerTask >= 3);
  assert.equal(ladder.classes.SMALL.minEdgeCasesPerTask, 0);
});

test('the depth ladder and artifact-templates.md agree on the class names', () => {
  const ref = read('artifact-templates.md');
  if (!ref) return;
  for (const cls of Object.keys(ladder.classes)) {
    assert.match(ref, new RegExp(`\\b${cls}\\b`), `the reference must mention the ${cls} class`);
  }
});

test('platforms.md points at the registry instead of restating it', () => {
  // The harness capability TABLES are tool output now (archgen_setup
  // {action:'harness_info'} serves packages/mcp/assets/platform-capabilities.json).
  // The reference keeps the narrative — detection order, the unknown-platform
  // procedure, the CodeGraph scope — and points at the tool.
  const ref = read('platforms.md');
  if (!ref) return;
  assert.match(ref, /archgen_setup\s*\{\s*action:\s*'harness_info'\s*\}/, 'the reference must point at the tool');
  assert.match(ref, /platform-capabilities\.json/, 'the reference must name the canonical registry');
  // It must NOT carry the per-harness capability rows any more.
  for (const [, h] of Object.entries(caps.harnesses)) {
    assert.ok(
      !ref.includes(`| ${h.label} |`),
      `platforms.md restates the '${h.label}' capability row — the tool owns it`,
    );
  }
});

test('the platform registry and platforms.md agree on the universal install root', () => {
  const ref = read('platforms.md');
  if (!ref) return;
  assert.ok(caps.universal.skillPaths.project.includes('.agents/skills/<name>/'));
  assert.match(ref, /\.agents\/skills/, 'the reference must state the universal install root');
});

test('the four known MCP top-level keys are the same in the registry and the reference', () => {
  const ref = read('platforms.md');
  if (!ref) return;
  const KNOWN = ['mcpServers', 'servers', 'mcp', 'context_servers'];
  const registryKeys = new Set();
  for (const h of Object.values(caps.harnesses)) {
    for (const cfg of Object.values(h.mcpConfig)) {
      // A key may be a PATH (`mcp.servers`): the top-level key is what the
      // file's shape is about.
      registryKeys.add(String(cfg.key).split('.')[0]);
    }
  }
  for (const key of KNOWN) {
    assert.ok(registryKeys.has(key), `the registry must use the '${key}' key`);
    assert.ok(ref.includes(key), `platforms.md must document the '${key}' key`);
  }
});

test('the references never point at a deleted script', () => {
  for (const name of ['artifact-templates.md', 'orchestration.md', 'platforms.md', 'interview.md', 'mcp-and-skills.md']) {
    const ref = read(name);
    if (!ref) continue;
    assert.doesNotMatch(
      ref,
      /scripts\/(validate|next-tasks|set-status|update-agents|impact|verify-plan|plan-graph|doc-index|codegraph)\.mjs/,
      `${name} still references a deleted script`,
    );
  }
});

test('the SKILL.md never points at a deleted script', () => {
  const skillMd = join(REPO, 'skill', 'SKILL.md');
  if (!existsSync(skillMd)) return;
  const text = readFileSync(skillMd, 'utf8');
  assert.doesNotMatch(
    text,
    /scripts\/(validate|next-tasks|set-status|update-agents|impact|verify-plan|plan-graph|doc-index|codegraph)\.mjs/,
    'SKILL.md still references a deleted script',
  );
});

test('the reference does NOT restate the canonical templates', () => {
  // The templates live in packages/mcp/assets/templates/ and are served by
  // archgen_plan{action:'scaffold'}. If the reference also carries them, the
  // two copies drift — and the reference's copies were never validated (three
  // of them carried YAML the parser rejects).
  const ref = read('artifact-templates.md');
  if (!ref) return;
  for (const marker of ['name: Acme Shop', 'file_ownership: ["src/config/**"', 'FR-<MODULE>-01']) {
    assert.ok(!ref.includes(marker), `artifact-templates.md restates the template (${marker}) — the tool owns it`);
  }
});

test('the reference states the YAML subset the parser actually accepts', () => {
  const ref = read('artifact-templates.md');
  if (!ref) return;
  // Flow collections ARE supported (fixtures/yaml-corpus/tasks-flow.yaml);
  // block scalars and duplicate keys are NOT.
  assert.match(ref, /block scalars/i);
  assert.match(ref, /duplicate keys/i);
  assert.doesNotMatch(ref, /Avoid flow mappings/i, 'flow mappings are supported — the old advice was wrong');
});
