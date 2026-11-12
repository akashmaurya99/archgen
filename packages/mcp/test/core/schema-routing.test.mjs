// schema-routing.test.mjs — the catalog may be shortened, never blunted.
//
// WHY THIS FILE EXISTS.
//
// The catalog is injected into every request, so every tool's schema is a
// permanent cost AND a permanent instruction. The instinct when a catalog
// grows is to shorten the descriptions — and a shortened description that
// loses a fact does not get smaller, it gets WRONG.
//
// The damage is not hypothetical. Six hand-written action parentheticals in
// the schema were factually wrong: `archgen_docs.collection` claimed one
// action and belongs to six, `archgen_plan.collection` claimed four and
// belongs to eight. A model that trusted them passed arguments the handler
// never reads — and the handler IGNORES an unread argument, so the call
// succeeded and the agent believed it had done something it had not.
//
// So the schema is pinned by CONTRACT, not by wording:
//
//   - the STRUCTURE (properties, enums, required, annotations, and the
//     per-action routing tables) is pinned exactly — a change there is a
//     deliberate contract change;
//   - the FACTS are pinned semantically — each is a regex that must still
//     match the argument's description, so a description can be reworded or
//     shortened as long as the fact it carried survives;
//   - the ROUTING MAP in each tool description is GENERATED from the same
//     tables the handlers use, so it cannot drift from them.
//
// This file is what makes a compression pass safe: it fails when a fact
// disappears, and it passes when a fact is merely reworded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';

import { createServer, TOOL_NAMES } from '../../src/server.mjs';
import { getToolSpec } from '../../src/tools/_register.mjs';
import { routingSentence } from '../../src/core/protocol/routing.mjs';
import { inRepo } from '../repo-root.mjs';

createServer();

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const CONTRACT = join(REPO, 'internal', 'contracts', 'schema-contract.json');

const contract = existsSync(CONTRACT) ? JSON.parse(readFileSync(CONTRACT, 'utf8')) : null;

/**
 * The JSON Schema the CLIENT sees.
 *
 * The contract pins what a client receives, so it is compared against the
 * JSON Schema — not against the Zod shape, whose internals are not what
 * gets injected into the model's context.
 */
const jsonSchemas = new Map();
function jsonSchemaOf(name) {
  if (!jsonSchemas.has(name)) {
    jsonSchemas.set(name, z.toJSONSchema(getToolSpec(name).inputSchema, { io: 'input' }));
  }
  return jsonSchemas.get(name);
}

/** The enum values a JSON-Schema property carries, wherever they sit. */
function enumOf(prop) {
  if (!prop || typeof prop !== 'object') return null;
  if (Array.isArray(prop.enum)) return prop.enum;
  if (Array.isArray(prop.items?.enum)) return prop.items.enum;
  for (const alt of prop.anyOf ?? []) {
    if (Array.isArray(alt.enum)) return alt.enum;
    if (Array.isArray(alt.items?.enum)) return alt.items.enum;
  }
  return null;
}

test('the schema contract is present and covers every tool', () => {
  if (!inRepo()) return;
  assert.ok(contract, 'internal/contracts/schema-contract.json must exist');
  for (const name of TOOL_NAMES) {
    assert.ok(contract.tools[name], `the contract must cover '${name}'`);
  }
});

test('every tool keeps its shape: properties, enums, required, annotations', () => {
  if (!inRepo() || !contract) return;
  for (const name of TOOL_NAMES) {
    const spec = getToolSpec(name);
    const want = contract.tools[name];
    const js = jsonSchemaOf(name);
    const props = Object.keys(js.properties ?? {});

    assert.deepEqual(props, want.properties, `${name}: the property list changed`);

    const required = js.required ?? [];
    assert.deepEqual([...required].sort(), [...want.required].sort(), `${name}: the required arguments changed`);

    assert.equal(spec.readOnly === true, want.annotations.readOnly, `${name}: readOnlyHint changed`);
    assert.equal(spec.destructive === true, want.annotations.destructive, `${name}: destructiveHint changed`);
    assert.equal(spec.idempotent === true, want.annotations.idempotent, `${name}: idempotentHint changed`);
  }
});

test('every enum keeps its exact values', () => {
  if (!inRepo() || !contract) return;
  for (const name of TOOL_NAMES) {
    const want = contract.tools[name].enums;
    const js = jsonSchemaOf(name);
    for (const [prop, values] of Object.entries(want)) {
      const got = enumOf(js.properties?.[prop]);
      assert.deepEqual(got, values, `${name}.${prop}: the enum values changed`);
    }
  }
});

test('every action keeps exactly the arguments it reads', () => {
  if (!inRepo() || !contract) return;
  for (const name of TOOL_NAMES) {
    const want = contract.tools[name].actionArgs ?? {};
    const got = getToolSpec(name).actionArgs ?? {};
    assert.deepEqual(got, want, `${name}: the per-action routing table changed`);
  }
});

test('every argument keeps the facts its description carried', () => {
  if (!inRepo() || !contract) return;
  const failures = [];
  for (const name of TOOL_NAMES) {
    const facts = contract.tools[name].facts ?? {};
    const js = jsonSchemaOf(name);
    for (const [prop, patterns] of Object.entries(facts)) {
      const description = js.properties?.[prop]?.description ?? '';
      for (const p of patterns) {
        if (!new RegExp(p, 'i').test(description)) {
          failures.push(`${name}.${prop}: lost the fact /${p}/`);
        }
      }
    }
  }
  assert.deepEqual(failures, [], `\n${failures.length} schema fact(s) lost:\n  ${failures.join('\n  ')}`);
});

test('every tool description carries its GENERATED routing map', () => {
  if (!inRepo() || !contract) return;
  for (const name of TOOL_NAMES) {
    const want = routingSentence(contract.tools[name].actionArgs);
    if (!want) continue; // a tool with no action-specific argument needs no map
    const description = getToolSpec(name).description ?? '';
    assert.ok(
      description.includes(want),
      `${name}: the description must carry the generated routing map.\n  expected fragment: ${want}`,
    );
  }
});

test('the routing map agrees with the routing table it is generated from', () => {
  if (!inRepo() || !contract) return;
  // The map is rendered from the contract's tables; the live tables are
  // pinned to the contract above. So this asserts the two agree, which is
  // what makes a hand-written parenthetical that LIES unable to survive.
  for (const name of TOOL_NAMES) {
    const live = getToolSpec(name).actionArgs;
    const want = routingSentence(live);
    const description = getToolSpec(name).description ?? '';
    if (!want) continue;
    assert.ok(description.includes(want), `${name}: the description's map does not match the live routing table`);
  }
});

test('no argument description restates its own enum values', () => {
  if (!inRepo()) return;
  // An enum value that also appears in the description is the enum said
  // twice. The catalog pays for it on every request and it can only drift.
  // The action scope now lives in the tool's generated map.
  const offenders = [];
  for (const name of TOOL_NAMES) {
    const js = jsonSchemaOf(name);
    for (const [prop, v] of Object.entries(js.properties ?? {})) {
      const values = enumOf(v);
      if (!values || !values.length) continue;
      const description = String(v.description ?? '');
      if (!values.every((x) => description.includes(String(x)))) continue;
      // The description may name the enum for context ONLY if it adds a fact
      // the enum does not carry. These are the pure restatements.
      const stripped = values.map((x) => String(x)).join('|');
      const onlyEnum = description
        .replace(new RegExp(values.map((x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'), '')
        .replace(/[\s(),.·/—–-]+/g, '');
      if (onlyEnum.length === 0 || stripped === onlyEnum) offenders.push(`${name}.${prop}`);
    }
  }
  assert.deepEqual(offenders, [], `these descriptions only restate their enum: ${offenders.join(', ')}`);
});
