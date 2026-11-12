// action-args.test.mjs — the action tables must match the tools' schemas.
//
// WHY THIS FILE EXISTS. The schema is flat — one shape for every action — so
// the model sees every argument of a tool on every call and must pick the
// ones its action uses. A table says which action owns which argument, and
// the table decides what the CONTINUATION carries: a continuation that carried
// the whole argument set put the dead ones back in front of the agent, and
// the agent kept passing them.
//
// The table therefore has two failure modes worth pinning: an argument no
// action owns (it would be dead everywhere), and an action claiming an
// argument the schema does not have (the continuation would carry a name the
// tool refuses).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createServer, TOOL_NAMES } from '../../src/server.mjs';
import { getToolSpec } from '../../src/tools/_register.mjs';

createServer();

/** The actions a tool offers, or [] for a tool with no action enum. */
function actionsOf(spec) {
  return spec.inputSchema.shape?.action?._def?.values ?? spec.inputSchema.shape?.action?.options ?? [];
}

/**
 * Every argument a tool's schema declares, minus the two every tool takes.
 *
 * A tool with no action enum (archgen_help, whose only argument IS the
 * selector) has no per-action table to check.
 */
function schemaArgs(spec) {
  if (!actionsOf(spec).length) return [];
  return Object.keys(spec.inputSchema.shape ?? {}).filter(
    (k) => k !== 'action' && k !== 'projectRoot',
  );
}

test('every argument of every tool is claimed by some action', () => {
  const missing = [];
  for (const name of TOOL_NAMES) {
    const spec = getToolSpec(name);
    const claimed = new Set(Object.values(spec.actionArgs ?? {}).flat());
    for (const arg of schemaArgs(spec)) {
      if (!claimed.has(arg)) missing.push(`${name}: '${arg}' is in the schema but no action claims it`);
    }
  }
  assert.deepEqual(missing, [], `an argument no action owns:\n  ${missing.join('\n  ')}`);
});

test('every claimed argument exists in the schema', () => {
  const missing = [];
  for (const name of TOOL_NAMES) {
    const spec = getToolSpec(name);
    const shape = spec.inputSchema.shape ?? {};
    for (const [action, keys] of Object.entries(spec.actionArgs ?? {})) {
      for (const key of keys) {
        if (!shape[key]) missing.push(`${name}{action:'${action}'} claims '${key}', which the schema does not declare`);
      }
    }
  }
  assert.deepEqual(missing, [], `a claimed argument that does not exist:\n  ${missing.join('\n  ')}`);
});

test('every action of every tool has a table', () => {
  const missing = [];
  for (const name of TOOL_NAMES) {
    const spec = getToolSpec(name);
    const actions = actionsOf(spec);
    const table = spec.actionArgs ?? {};
    for (const action of actions) {
      if (!table[action]) missing.push(`${name}{action:'${action}'} has no table`);
    }
  }
  assert.deepEqual(missing, [], `an action with no table:\n  ${missing.join('\n  ')}`);
});

test('the table and the schema agree on the actions', () => {
  const wrong = [];
  for (const name of TOOL_NAMES) {
    const spec = getToolSpec(name);
    const actions = new Set(actionsOf(spec));
    for (const action of Object.keys(spec.actionArgs ?? {})) {
      if (!actions.has(action)) wrong.push(`${name}: the table names '${action}', which the schema does not offer`);
    }
  }
  assert.deepEqual(wrong, [], `a table entry the schema does not offer:\n  ${wrong.join('\n  ')}`);
});
