#!/usr/bin/env node
// validate.mjs — schema/link/cycle validator for tasks.yaml.
// Usage: node validate.mjs <tasks.yaml> [--plan <plans-dir>]
// Semantics: warnings -> stderr, exit 0. Errors -> stderr, exit 1 (itemized).
// --plan delegates cross-checking to verify-plan.mjs internals (single impl).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './lib/yaml.mjs';
import { buildGraph, findCycle, GraphError } from './lib/graph.mjs';

const STATUSES = ['pending', 'ready', 'running', 'blocked', 'done', 'failed'];
const REQUIRED = ['id', 'title', 'file_ownership'];
const KNOWN_KEYS = new Set(['id', 'title', 'status', 'depends_on', 'parallel_group', 'file_ownership', 'artifacts', 'acceptance']);
// Mirrors schemas/tasks.schema.json `id.pattern` — ids are strings, never
// numeric-coerced scalars, or set-status/next-tasks cannot address the task.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const [, , file, ...rest] = process.argv;
if (!file) { console.error('usage: validate.mjs <tasks.yaml> [--plan <dir>]'); process.exit(1); }
const planDirIdx = rest.indexOf('--plan');
if (planDirIdx >= 0 && rest[planDirIdx + 1] === undefined) {
  // '--plan' with no value must never silently skip coverage checks.
  console.error('usage: validate.mjs <tasks.yaml> [--plan <dir>] (--plan requires a directory value)');
  process.exit(2);
}
const planDir = planDirIdx >= 0 ? rest[planDirIdx + 1] : null;

/** @type {string[]} errors */ const errors = [];
/** @type {string[]} warnings */ const warnings = [];

let data;
try {
  ({ data } = parseYaml(readFileSync(file, 'utf8'), { filename: file }));
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
const tasks = data?.tasks;
if (!Array.isArray(tasks) || tasks.length === 0) {
  console.error('error: missing or empty `tasks:` sequence');
  process.exit(1);
}
// Root-level typo guard: e.g. `task:` instead of `tasks:` would otherwise
// silently produce the missing-tasks error with no hint as to why.
for (const k of Object.keys(data ?? {})) {
  if (k !== 'tasks') warnings.push(`unknown root key '${k}' (expected only 'tasks')`);
}

for (const [i, t] of tasks.entries()) {
  const where = `tasks[${i}] (${t?.id ?? '<no-id>'})`;
  if (t === null || typeof t !== 'object' || Array.isArray(t)) { errors.push(`${where}: not a mapping`); continue; }
  for (const k of Object.keys(t)) if (!KNOWN_KEYS.has(k)) warnings.push(`${where}: unknown key '${k}' (ignored)`);
  // Required means present AND non-empty: `id:` parses to null, which is not
  // undefined — an explicit empty value must fail, not bypass the check.
  for (const r of REQUIRED) {
    const v = t[r];
    if (v === undefined) errors.push(`${where}: missing required field '${r}'`);
    else if (v === null || (typeof v === 'string' && v.trim() === '')) errors.push(`${where}: required field '${r}' is empty`);
  }
  if (t.id !== undefined && t.id !== null && (typeof t.id !== 'string' || !ID_PATTERN.test(t.id))) {
    errors.push(`${where}: invalid id '${t.id}' (must be a string matching ^[A-Za-z0-9][A-Za-z0-9._-]*$)`);
  }
  if (t.status !== undefined && !STATUSES.includes(t.status)) errors.push(`${where}: invalid status '${t.status}' (allowed: ${STATUSES.join('|')})`);
  if (Array.isArray(t.file_ownership) && t.file_ownership.length === 0) errors.push(`${where}: file_ownership must be non-empty`);
  if (t.depends_on !== undefined && !Array.isArray(t.depends_on)) errors.push(`${where}: depends_on must be a list`);
}

try {
  const { prerequisites } = buildGraph(tasks);
  const cycle = findCycle(prerequisites);
  if (cycle.length) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
} catch (e) {
  if (e instanceof GraphError) errors.push(e.message);
  else throw e;
}

if (planDir) {
  // Delegate plan<->task coverage checks to the single shared implementation.
  const { checkPlanCoverage } = await import('./lib/plan-coverage.mjs');
  const findings = checkPlanCoverage(planDir, tasks);
  for (const f of findings) errors.push(f);
}

for (const w of warnings) console.error(`warn: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
if (errors.length) process.exit(1);
console.error(`ok: ${tasks.length} tasks valid${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
