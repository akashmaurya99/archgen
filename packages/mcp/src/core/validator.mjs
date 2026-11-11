// validator.mjs — schema / link / cycle validation for tasks.yaml.
//
// Extracted verbatim from skill/scripts/validate.mjs (which is deleted in the
// MCP-first cutover). The logic is unchanged; only the I/O shell differs:
// argv parsing and process.exit become arguments and a returned report.
//
// Semantics preserved:
//   - warnings are non-fatal
//   - an unparseable file is a hard INVALID_INPUT
//   - `--plan` with no value is a usage error, never a silent skip
import { readFileSync } from 'node:fs';
import { parseYaml } from './yaml.mjs';
import { buildGraph, findCycle, GraphError } from './graph.mjs';
import { checkPlanCoverage } from './plan-coverage.mjs';
import { invalidInput, ArchgenError } from './errors.mjs';
import { project } from '../envelope.mjs';

export const STATUSES = ['pending', 'ready', 'running', 'blocked', 'done', 'failed'];
export const REQUIRED = ['id', 'title', 'file_ownership'];
export const KNOWN_KEYS = new Set([
  'id', 'title', 'status', 'depends_on', 'parallel_group', 'file_ownership', 'artifacts', 'acceptance',
]);

// Mirrors schemas/tasks.schema.json `id.pattern` — ids are strings, never
// numeric-coerced scalars, or the task tools cannot address the task.
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;


/**
 * Validate a tasks.yaml file.
 *
 * The errors and the warnings are SEPARATE collections, each with its own
 * window. A 200-task broken plan produced 400 errors and 200 warnings in one
 * answer — 16k tokens — and the caller's `limit` changed nothing.
 *
 * @param {string} file absolute path to tasks.yaml
 * @param {{planDir?: string|null, limit?: number, offset?: number, collection?: string}} [opts]
 * @returns {{valid: boolean, errors: string[], warnings: string[],
 *            errorsTotal: number, warningsTotal: number,
 *            counts: {tasks: number, errors: number, warnings: number}}}
 */
export function validateTasksYaml(file, opts = {}) {
  const planDir = opts.planDir ?? null;
  const errors = [];
  const warnings = [];
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50;
  const offset = Number.isInteger(opts.offset) ? opts.offset : 0;
  const collection = String(opts.collection ?? 'errors');

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    // A missing or unreadable file is NOT an internal error. The agent is
    // told to branch on the code, and "the file is not there" is a fact it
    // can act on — an INTERNAL tells it nothing and hides which path failed.
    const code = e?.code === 'ENOENT' ? 'NOT_FOUND' : 'INVALID_INPUT';
    throw new ArchgenError(
      code,
      `${code === 'NOT_FOUND' ? 'tasks file not found' : `cannot read tasks file`}: ${file}`,
      { file },
    );
  }
  let data;
  try {
    ({ data } = parseYaml(raw, { filename: file }));
  } catch (e) {
    throw invalidInput(String(e?.message ?? e), { file });
  }
  const tasks = data?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw invalidInput('missing or empty `tasks:` sequence', { file });
  }

  // Root-level typo guard: e.g. `task:` instead of `tasks:` would otherwise
  // silently produce the missing-tasks error with no hint as to why.
  for (const k of Object.keys(data ?? {})) {
    if (k !== 'tasks') warnings.push(`unknown root key '${k}' (expected only 'tasks')`);
  }

  for (const [i, t] of tasks.entries()) {
    const where = `tasks[${i}] (${t?.id ?? '<no-id>'})`;
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      errors.push(`${where}: not a mapping`);
      continue;
    }
    for (const k of Object.keys(t)) if (!KNOWN_KEYS.has(k)) warnings.push(`${where}: unknown key '${k}' (ignored)`);
    // Required means present AND non-empty: `id:` parses to null, which is not
    // undefined — an explicit empty value must fail, not bypass the check.
    for (const r of REQUIRED) {
      const v = t[r];
      if (v === undefined) errors.push(`${where}: missing required field '${r}'`);
      else if (v === null || (typeof v === 'string' && v.trim() === '')) {
        errors.push(`${where}: required field '${r}' is empty`);
      }
    }
    if (t.id !== undefined && t.id !== null && (typeof t.id !== 'string' || !ID_PATTERN.test(t.id))) {
      errors.push(`${where}: invalid id '${t.id}' (must be a string matching ^[A-Za-z0-9][A-Za-z0-9._-]*$)`);
    }
    if (t.status !== undefined && !STATUSES.includes(t.status)) {
      errors.push(`${where}: invalid status '${t.status}' (allowed: ${STATUSES.join('|')})`);
    }
    if (Array.isArray(t.file_ownership) && t.file_ownership.length === 0) {
      errors.push(`${where}: file_ownership must be non-empty`);
    }
    if (t.depends_on !== undefined && !Array.isArray(t.depends_on)) {
      errors.push(`${where}: depends_on must be a list`);
    }
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
    for (const f of checkPlanCoverage(planDir, tasks).findings) errors.push(f);
  }

  const errWindow = project(errors, { limit, offset: collection === 'errors' ? offset : 0 });
  const warnWindow = project(warnings, { limit, offset: collection === 'warnings' ? offset : 0 });
  return {
    valid: errors.length === 0,
    errors: errWindow.items,
    warnings: warnWindow.items,
    errorsTotal: errWindow.total,
    warningsTotal: warnWindow.total,
    errorsOffset: errWindow.offset,
    warningsOffset: warnWindow.offset,
    // How much is LEFT — offset-aware. The tool used to compare the page
    // length with the total, which is true at the tail too, so it published
    // a continuation pointing at the SAME offset: an agent following it
    // spun on an empty page forever.
    errorsOmitted: Math.max(0, errWindow.total - (errWindow.offset + errWindow.items.length)),
    warningsOmitted: Math.max(0, warnWindow.total - (warnWindow.offset + warnWindow.items.length)),
    counts: { tasks: tasks.length, errors: errWindow.total, warnings: warnWindow.total },
  };
}
