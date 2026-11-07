// skill-tool-vocabulary.test.mjs — the skill must not name a tool or an
// action that does not exist.
//
// WHY THIS FILE EXISTS: the SKILL.md tool table said `archgen_docs` has a
// `search` action (it has `refs` and `map`) and that `archgen_registry` has
// a `read` action (it has `show`). Both are ALWAYS-ON — they are in the
// context of every session that triggers the skill — so an agent following
// the table calls an action that does not exist, gets a typed
// `INVALID_INPUT`, burns a round-trip, and has to recover by guessing.
//
// The repo already has drift gates for the references and a schema-parity
// gate for the YAML. There was nothing that said "the action names in
// SKILL.md must exist", which is exactly why those two got through.
//
// This gate reads the LIVE schemas — the same source of truth the MCP
// client sees — and holds the skill's vocabulary to them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer, TOOL_NAMES } from '../../src/server.mjs';
import { getToolSpec } from '../../src/tools/_register.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const SKILL_MD = join(REPO, 'skill', 'SKILL.md');

// Registering the tools populates the spec registry the schemas live in.
createServer();

/** The live action enum for every tool, straight from the schema. */
function liveActions() {
  const out = {};
  for (const name of TOOL_NAMES) {
    const shape = getToolSpec(name).inputSchema.shape;
    const action = shape?.action;
    out[name] = action?.options ?? action?._def?.entries ?? [];
  }
  return out;
}

const ACTIONS = liveActions();

/**
 * The values a schema accepts, if it is an enum.
 *
 * A field like `topic: z.enum([...]).optional()` is a ZodOptional wrapping
 * the enum, so the wrapper is unwrapped first — otherwise the enum's values
 * are invisible and every topic looks like a name the tool does not have.
 */
function enumValues(schema) {
  let s = schema;
  for (let i = 0; i < 5 && s; i++) {
    if (s.options) return Array.isArray(s.options) ? s.options : Object.keys(s.options);
    const entries = s._def?.entries;
    if (entries) return Array.isArray(entries) ? entries : Object.keys(entries);
    s = s._def?.innerType ?? s._def?.type ?? null;
  }
  return [];
}

/** Every enum value a tool's schema accepts, keyed by tool. */
function liveValues() {
  const out = {};
  for (const name of TOOL_NAMES) {
    const shape = getToolSpec(name).inputSchema.shape;
    const values = new Set();
    for (const schema of Object.values(shape ?? {})) {
      for (const v of enumValues(schema)) values.add(v);
    }
    out[name] = values;
  }
  return out;
}

const VALUES = liveValues();

/**
 * The values the skill's tool table claims, per tool.
 *
 * The table rows look like:
 *   | `archgen_plan` | `validate` · `verify` · ... |
 *
 * so the named values are the backticked tokens in the SECOND cell. They are
 * NOT all action names — `archgen_refs` lists TOPICS (`interview`,
 * `orchestration`, …) and `archgen_plan` lists scope classes — so a token is
 * checked against EVERY enum the tool's schema accepts, not just `action`.
 *
 * A token that appears in no enum of that tool is a name the tool does not
 * have, whatever it is called.
 */
function declaredValues(markdown) {
  const declared = new Map();
  for (const line of markdown.split('\n')) {
    const row = line.match(/^\|\s*`(archgen_[a-z]+)`\s*\|(.*)\|\s*$/);
    if (!row) continue;
    const tool = row[1];
    const cell = row[2];
    const names = [...cell.matchAll(/`([a-z][a-z_]*)`/g)].map((m) => m[1]);
    declared.set(tool, names);
  }
  return declared;
}

test('the skill declares only tools the server actually exposes', () => {
  if (!existsSync(SKILL_MD)) return; // the published package ships no skill tree
  const markdown = readFileSync(SKILL_MD, 'utf8');
  const declared = declaredValues(markdown);
  assert.ok(declared.size >= 8, `the tool table looks malformed — ${declared.size} rows parsed`);

  const unknown = [...declared.keys()].filter((tool) => !TOOL_NAMES.includes(tool));
  assert.deepEqual(unknown, [], `the skill names tools the server does not expose: ${unknown.join(', ')}`);
});

test('every value the skill names exists in that tool\'s schema', () => {
  if (!existsSync(SKILL_MD)) return;
  const markdown = readFileSync(SKILL_MD, 'utf8');
  const declared = declaredValues(markdown);

  const wrong = [];
  for (const [tool, names] of declared) {
    const live = VALUES[tool] ?? new Set();
    for (const name of names) {
      if (live.has(name)) continue;
      const actions = ACTIONS[tool] ?? [];
      wrong.push(
        `${tool}{action:'${name}'} — the real actions are: ${actions.join(', ') || '(none)'}`,
      );
    }
  }
  assert.deepEqual(wrong, [], `the skill names values the tool does not have:\n  ${wrong.join('\n  ')}`);
});

test('the read/write table names only real actions', () => {
  if (!existsSync(SKILL_MD)) return;
  const markdown = readFileSync(SKILL_MD, 'utf8');
  const wrong = [];
  // `archgen_tasks{set_status,snapshot}` — the comma form.
  for (const m of markdown.matchAll(/archgen_[a-z]+\{([a-z_,]+)\}/g)) {
    const tool = m[0].match(/archgen_[a-z]+/)[0];
    const live = ACTIONS[tool] ?? [];
    if (!live.length) continue;
    for (const action of m[1].split(',')) {
      if (!live.includes(action)) {
        wrong.push(`${tool}{${action}} — the real actions are: ${live.join(', ')}`);
      }
    }
  }
  assert.deepEqual(wrong, [], `the read/write table names actions that do not exist:\n  ${wrong.join('\n  ')}`);
});

test('every tool the server exposes is documented in the skill', () => {
  if (!existsSync(SKILL_MD)) return;
  const markdown = readFileSync(SKILL_MD, 'utf8');
  const declared = declaredValues(markdown);
  const missing = TOOL_NAMES.filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], `the server exposes tools the skill never mentions: ${missing.join(', ')}`);
});
