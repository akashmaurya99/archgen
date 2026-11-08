// skill-call-audit.test.mjs — EVERY call the skill makes must be REAL.
//
// WHY THIS FILE EXISTS.
//
// The skill is the agent's contract, and it is read by an agent that will
// follow it literally. Every `archgen_tool { action: 'x', arg: y }` in it is
// an instruction the agent will COPY — so a call that names a tool that does
// not exist, an action that does not exist, or an argument the schema does
// not accept is a bug that costs a round-trip every single time.
//
// Two real defects were found this way:
//
//   - the skill taught `§artifact-templates/plan-depth`, and the section's
//     real slug was `plan-depth-by-scope-class` — the shorthand the skill
//     taught did not resolve;
//   - the skill never said that `scaffold` RETURNS CONTENT and writes
//     nothing, so an agent assumed files had appeared.
//
// The table check (skill-tool-vocabulary.test.mjs) covers the tool TABLE.
// This one covers the whole file, including the code blocks and the prose —
// every call, anywhere.
//
// It also checks the REVERSE direction: every action the server exposes
// should be reachable from the skill, so a new capability cannot ship
// undocumented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer, TOOL_NAMES } from '../../src/server.mjs';
import { getToolSpec } from '../../src/tools/_register.mjs';

createServer();

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SKILL = join(REPO, 'skill', 'SKILL.md');

/** Every argument a tool's schema accepts, plus `action`. */
function schemaFields(tool) {
  const shape = getToolSpec(tool).inputSchema.shape ?? {};
  return new Set(Object.keys(shape));
}

/** Every action a tool accepts. */
function schemaActions(tool) {
  const shape = getToolSpec(tool).inputSchema.shape ?? {};
  const action = shape.action;
  const values = action?.options ?? action?._def?.entries;
  return new Set(Array.isArray(values) ? values : Object.keys(values ?? {}));
}

/**
 * Every `archgen_tool { … }` mention in the text.
 *
 * The skill writes two shapes, and they mean DIFFERENT things:
 *
 *   archgen_plan { action: 'scaffold', scope, slug }   — a CALL: `action` is
 *       the action and the remaining names are ARGUMENTS.
 *   archgen_tasks { next, list, contract }               — an ACTION LIST: the
 *       read/write table shorthand, where every name is an ACTION.
 *
 * The presence of an `action:` key tells them apart. Getting that wrong
 * makes the audit report the action names as arguments, which is noise.
 */
function parseCalls(markdown) {
  const calls = [];
  for (const m of markdown.matchAll(/archgen_([a-z]+)\s*\{([^}]*)\}/g)) {
    const tool = `archgen_${m[1]}`;
    const body = m[2];
    const isCall = /action\s*:/.test(body);
    const action = /action\s*:\s*'([a-z_]+)'/.exec(body)?.[1] ?? null;
    const args = new Set();
    const actions = new Set();
    if (action) actions.add(action);

    // Split on commas that are not inside quotes or angle brackets.
    let depth = 0;
    let quote = null;
    let part = '';
    const parts = [];
    for (const ch of body) {
      if (quote) {
        part += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        part += ch;
        continue;
      }
      if (ch === '<') depth++;
      if (ch === '>') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(part);
        part = '';
        continue;
      }
      part += ch;
    }
    parts.push(part);

    for (const raw of parts) {
      const p = raw.trim();
      if (!p) continue;
      const keyed = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/.exec(p);
      if (keyed) {
        if (keyed[1] !== 'action') args.add(keyed[1]);
        continue;
      }
      const bare = /^([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(p);
      if (!bare) continue;
      // A bare word is an ARGUMENT in a call and an ACTION in an action list.
      if (isCall) args.add(bare[1]);
      else actions.add(bare[1]);
    }
    calls.push({ tool, action, actions, args, raw: m[0] });
  }
  return calls;
}

/**
 * The actions named in the skill's TOOL TABLE.
 *
 * The table is the agent's index — `| \`archgen_plan\` | \`validate\` · \`verify\` … |`
 * — so the actions it lists count as documented.
 */
function parseTableActions(markdown) {
  const out = new Map();
  for (const line of markdown.split('\n')) {
    const row = line.match(/^\|\s*`(archgen_[a-z]+)`\s*\|(.*)\|\s*$/);
    if (!row) continue;
    const tool = row[1];
    const names = [...row[2].matchAll(/`([a-z][a-z_]*)`/g)].map((m) => m[1]);
    out.set(tool, new Set([...(out.get(tool) ?? []), ...names]));
  }
  return out;
}

test('every tool the skill calls EXISTS', () => {
  if (!existsSync(SKILL)) return; // the published package ships no skill tree
  const markdown = readFileSync(SKILL, 'utf8');
  const unknown = [...new Set(parseCalls(markdown).map((c) => c.tool))].filter((t) => !TOOL_NAMES.includes(t));
  assert.deepEqual(unknown, [], `the skill calls tools the server does not expose: ${unknown.join(', ')}`);
});

test('every action the skill calls EXISTS', () => {
  if (!existsSync(SKILL)) return;
  const markdown = readFileSync(SKILL, 'utf8');
  const wrong = [];
  for (const call of parseCalls(markdown)) {
    if (!call.action) continue;
    const actions = schemaActions(call.tool);
    if (!actions.size) continue;
    if (!actions.has(call.action)) {
      wrong.push(`${call.tool}{action:'${call.action}'} — real actions: ${[...actions].join(', ')}`);
    }
  }
  assert.deepEqual([...new Set(wrong)], [], `the skill calls actions that do not exist:\n  ${wrong.join('\n  ')}`);
});

test('every argument the skill passes EXISTS', () => {
  if (!existsSync(SKILL)) return;
  const markdown = readFileSync(SKILL, 'utf8');
  const wrong = [];
  for (const call of parseCalls(markdown)) {
    if (!TOOL_NAMES.includes(call.tool)) continue;
    const fields = schemaFields(call.tool);
    for (const arg of call.args) {
      if (!fields.has(arg)) {
        wrong.push(`${call.tool}{...${arg}...} — the schema accepts: ${[...fields].join(', ')}`);
      }
    }
  }
  assert.deepEqual([...new Set(wrong)], [], `the skill passes arguments the schema does not accept:\n  ${wrong.join('\n  ')}`);
});

test('every action the server exposes is reachable from the skill', () => {
  if (!existsSync(SKILL)) return;
  const markdown = readFileSync(SKILL, 'utf8');
  const calls = parseCalls(markdown);
  const table = parseTableActions(markdown);
  const undocumented = [];
  for (const tool of TOOL_NAMES) {
    const actions = schemaActions(tool);
    if (!actions.size) continue; // archgen_help is keyed by `topic`
    const used = new Set([
      ...calls.filter((c) => c.tool === tool).flatMap((c) => [...c.actions]),
      ...(table.get(tool) ?? []),
    ]);
    for (const action of actions) {
      if (!used.has(action)) undocumented.push(`${tool}{action:'${action}'}`);
    }
  }
  assert.deepEqual(
    undocumented,
    [],
    `the server exposes actions the skill never mentions — an agent will never find them:\n  ${undocumented.join('\n  ')}`,
  );
});

test('the skill says scaffold WRITES NOTHING', () => {
  if (!existsSync(SKILL)) return;
  const markdown = readFileSync(SKILL, 'utf8');
  // The agent read this and still assumed the files existed. It must be
  // stated wherever the scaffold call is described — and it must be stated
  // where the call FIRST appears, because that is where an agent reads it.
  const lines = markdown.split('\n');
  const firstMention = lines.findIndex((l) => l.includes("archgen_plan{action:'scaffold'"));
  assert.ok(firstMention >= 0, 'the skill must describe the scaffold call');
  // The note must be on the first mention, or within the bullet it starts.
  const paragraph = lines.slice(firstMention, firstMention + 2).join(' ');
  assert.match(paragraph, /writes nothing|CONTENT/i, 'the scaffold line must say it writes nothing');
});

test('the skill teaches the § shorthand as a slug PREFIX', () => {
  if (!existsSync(SKILL)) return;
  const markdown = readFileSync(SKILL, 'utf8');
  assert.match(
    markdown,
    /prefix/i,
    'the skill must say that a § name is a slug prefix, or an agent cannot pass what it was told',
  );
});

test('the skill says the archgen artifacts are COMMITTED, never ignored', () => {
  if (!existsSync(SKILL)) return;
  const markdown = readFileSync(SKILL, 'utf8');
  // The plan of record is invisible if it is never committed, and an agent
  // that assumes "generated files are not source" quietly gitignores it. The
  // rule has to be in the ALWAYS-ON contract, not only in a reference.
  assert.match(markdown, /committed/i, 'the skill must say the artifacts are committed');
  assert.match(markdown, /gitignore/i, 'the skill must say they are never ignored');
  assert.match(
    markdown,
    /artifact-tracking/,
    'the skill must point at the section that lists the tracked paths',
  );
});

test('the skill keeps the source tree and the test tree apart', () => {
  if (!existsSync(SKILL)) return;
  const markdown = readFileSync(SKILL, 'utf8');
  assert.match(markdown, /separate trees/i, 'the skill must state the separation');
  assert.doesNotMatch(
    markdown,
    /colocat/i,
    'the skill still teaches colocated tests — that is the opposite of the standard',
  );
});
