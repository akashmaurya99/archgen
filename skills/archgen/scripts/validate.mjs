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

const [, , file, ...rest] = process.argv;
if (!file) { console.error('usage: validate.mjs <tasks.yaml> [--plan <dir>]'); process.exit(1); }
const planDirIdx = rest.indexOf('--plan');
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
  for (const r of REQUIRED) if (t[r] === undefined) errors.push(`${where}: missing required field '${r}'`);
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
