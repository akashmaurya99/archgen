// validator.mjs — schema, link and cycle validation for tasks.yaml.
//
// WHY EVERY DEFECT IS A FINDING AND NOT AN EXCEPTION. A broken plan is DATA.
// The agent needs every defect at once, each with the field it sits in and
// the fix that clears it. Throwing on the first defect made the agent fix one
// line, re-run, and find the next — a round-trip per task in a twelve-task
// plan.
//
// WHY IT IS THE ONE IMPLEMENTATION. The floor used to check the task file
// separately, with its own codes for the same defects, so `validate` and
// `verify` could disagree about what a valid plan is. The floor now calls
// this module, so "valid" means exactly one thing.
//
// The rules enforced here are the rules `schemas/tasks.schema.json`
// publishes — and the schema SHIPS with this package, so the published
// server carries the contract it enforces. The parity test pins the two
// together, so the contract and the enforcement cannot drift.
import { findCycle, graphMaps, isTaskMapping } from './graph.mjs';
import { checkPlanCoverage } from './plan-coverage.mjs';
import { readPlanFile } from './plan-file.mjs';
import { project } from '../envelope.mjs';
import { finding, countByCode } from './diagnostics.mjs';
import { issueCode } from './codes.mjs';

export const STATUSES = ['pending', 'ready', 'running', 'blocked', 'done', 'failed'];
export const REQUIRED = ['id', 'title', 'file_ownership'];
export const KNOWN_KEYS = new Set([
  'id', 'title', 'status', 'depends_on', 'parallel_group', 'file_ownership', 'artifacts', 'acceptance',
]);

// Mirrors schemas/tasks.schema.json `id.pattern` — ids are strings, never
// numeric-coerced scalars, or the task tools cannot address the task.
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The fix for each coverage defect.
 *
 * The coverage pass reports four different things — a task nobody mentions,
 * a plan citing a task that does not exist, a missing plans directory and an
 * unreadable file. One fix for all four sent the agent to the wrong place
 * for three of them.
 */
const COVERAGE_FIXES = {
  PLAN_TASK_COVERAGE: 'mention the task in a plan file under plans/ — the floor proves the plan covers the tasks',
  UNKNOWN_TASK_ID: 'the plan cites a task that is not in tasks.yaml — add the task, or correct the reference',
  NO_PLAN_DIR: 'create the plans directory under .archgen/<slug>/ and write the plan of record there',
  IO_ERROR: 'the plan file could not be read — check its permissions and its path',
};

/**
 * Validate a tasks.yaml file.
 *
 * @param {string} file absolute path to tasks.yaml
 * @param {{planDir?: string|null, limit?: number, offset?: number, collection?: string}} [opts]
 * @returns {{valid: boolean, errors: object[], warnings: object[],
 *            errorsTotal: number, warningsTotal: number,
 *            errorsOffset: number, warningsOffset: number,
 *            errorsOmitted: number, warningsOmitted: number,
 *            errorCodes: Record<string, number>, warningCodes: Record<string, number>,
 *            counts: {tasks: number, errors: number, warnings: number}}}
 */
export function validateTasksYaml(file, opts = {}) {
  const planDir = opts.planDir ?? null;
  const read = readPlanFile(file);
  const errors = read.findings.slice();
  const warnings = [];
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50;
  const offset = Number.isInteger(opts.offset) ? opts.offset : 0;
  const collection = String(opts.collection ?? 'errors');

  if (read.findings.length) {
    // A file that cannot be parsed is a broken plan, not a broken call. It is
    // reported as a finding so the agent sees it alongside every other
    // defect, with the line it has to fix.
    return report(errors, warnings, 0, limit, offset, collection);
  }

  const data = read.data;
  const provenance = read.provenance;
  const checked = validateTasks(data, { provenance });
  errors.push(...checked.errors);
  warnings.push(...checked.warnings);
  const taskCount = checked.tasks.length;

  if (planDir) {
    // Delegate plan<->task coverage checks to the single shared implementation.
    // The finding is CLASSIFIED, not stamped: the coverage pass reports four
    // different defects, and one code for all of them left NO_PLAN_DIR,
    // UNKNOWN_TASK_ID and IO_ERROR unreachable from `validate` — and paired
    // every one of them with a fix about mentioning a task in a plan.
    for (const f of checkPlanCoverage(planDir, checked.tasks).findings) {
      const code = issueCode(f);
      errors.push(finding(code, f, { fix: COVERAGE_FIXES[code] ?? COVERAGE_FIXES.PLAN_TASK_COVERAGE }));
    }
  }

  return report(errors, warnings, taskCount, limit, offset, collection);
}

/**
 * Validate an ALREADY PARSED task file.
 *
 * The pure core: the floor parses the file itself (it reports the parse
 * error its own way), so both surfaces enforce the same rules.
 *
 * @param {any} data the parsed document
 * @param {{provenance?: Map<string, number>}} [opts]
 * @returns {{errors: object[], warnings: object[], tasks: any[]}}
 */
export function validateTasks(data, opts = {}) {
  const errors = [];
  const warnings = [];
  const provenance = opts.provenance ?? new Map();
  // The most precise line available: the exact path when the parser recorded
  // it, otherwise the nearest enclosing one.
  const lineOf = (path) => {
    let p = path;
    for (;;) {
      const line = provenance.get(p);
      if (line) return ` (line ${line})`;
      const item = p.match(/^(.*)\[\d+\]$/);
      if (item) { p = item[1]; continue; }
      const dot = p.lastIndexOf('.');
      if (dot > 0) { p = p.slice(0, dot); continue; }
      return '';
    }
  };

  const tasks = data?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    errors.push(
      finding('NO_TASKS', 'the file carries no `tasks:` sequence', {
        fix: 'add a `tasks:` sequence with at least one task',
      }),
    );
    return { errors, warnings, tasks: [], graphOk: false };
  }

  // Root-level typo guard: e.g. `task:` instead of `tasks:` would otherwise
  // silently produce the missing-tasks error with no hint as to why.
  for (const k of Object.keys(data ?? {})) {
    if (k !== 'tasks') {
      warnings.push(
        finding('TASK_FIELD_UNKNOWN', `unknown root key '${k}'${lineOf(k)}`, {
          fix: 'the contract defines only `tasks` at the root',
        }),
      );
    }
  }

  const seenIds = new Map();
  // The graph can only be built when every entry is a mapping with a usable
  // id. A file that fails that cannot produce waves, and the gate must know
  // so — otherwise it asks for waves the file cannot yield.
  let entriesOk = true;
  tasks.forEach((t, i) => {
    const path = `tasks[${i}]`;
    if (!isTaskMapping(t)) {
      entriesOk = false;
      errors.push(
        finding('TASK_FIELD_TYPE', `${path} is not a task mapping${lineOf(path)}`, {
          fix: 'each entry under `tasks:` is a mapping carrying at least id, title and file_ownership',
        }),
      );
      return;
    }

    const label = typeof t.id === 'string' && t.id ? `task '${t.id}'` : path;
    const where = label === path ? path : `${label} (${path})`;

    for (const k of Object.keys(t)) {
      if (!KNOWN_KEYS.has(k)) {
        warnings.push(
          finding('TASK_FIELD_UNKNOWN', `${where} carries the unknown key '${k}'${lineOf(`${path}.${k}`)}`, {
            fix: 'remove it, or record it where the contract defines it',
          }),
        );
      }
    }

    // Required means present AND non-empty: `id:` parses to null, which is not
    // undefined — an explicit empty value must fail, not bypass the check.
    for (const r of REQUIRED) {
      const v = t[r];
      if (v === undefined) {
        errors.push(finding('TASK_FIELD_MISSING', `${where} has no '${r}'${lineOf(`${path}.${r}`)}`, { fix: `add '${r}'` }));
      } else if (v === null || (typeof v === 'string' && v.trim() === '')) {
        errors.push(finding('TASK_FIELD_EMPTY', `${where} has an empty '${r}'${lineOf(`${path}.${r}`)}`, { fix: `give '${r}' a value` }));
      }
    }

    if (t.id !== undefined && t.id !== null) {
      if (typeof t.id !== 'string' || !ID_PATTERN.test(t.id)) {
        entriesOk = false;
        errors.push(
          finding('TASK_ID_INVALID', `${where} has an invalid id '${t.id}'${lineOf(`${path}.id`)}`, {
            fix: `use an id matching ${ID_PATTERN.source}`,
          }),
        );
      } else if (seenIds.has(t.id)) {
        entriesOk = false;
        errors.push(
          finding('DUPLICATE_TASK_ID', `${where} repeats the id of ${seenIds.get(t.id)}${lineOf(`${path}.id`)}`, {
            fix: 'give every task a unique id — the tools address tasks by id',
          }),
        );
      } else {
        seenIds.set(t.id, label);
      }
    }

    // The id must be a string. A NUMBER id is not merely a different shape:
    // YAML reads `id: 007` as 7, so the id the agent holds ("007") and the id
    // the file holds (7) are different strings for the same task.
    if (typeof t.title !== 'string') {
      errors.push(
        finding('TASK_FIELD_TYPE', `${where} has a title that is not a string${lineOf(`${path}.title`)}`, {
          fix: 'title is a one-line string — quote it',
        }),
      );
    }

    if (t.status !== undefined && !STATUSES.includes(t.status)) {
      errors.push(
        finding('TASK_STATUS_INVALID', `${where} has the status '${t.status}'${lineOf(`${path}.status`)}`, {
          fix: `use one of ${STATUSES.join('|')} — or leave the field out entirely`,
        }),
      );
    }

    if (t.parallel_group !== undefined && t.parallel_group !== null && typeof t.parallel_group !== 'string') {
      errors.push(
        finding('TASK_FIELD_TYPE', `${where} has a parallel_group that is not a string${lineOf(`${path}.parallel_group`)}`, {
          fix: 'parallel_group is a label (a string) or null',
        }),
      );
    }

    checkStringList(errors, where, path, 'depends_on', t.depends_on, lineOf, { unique: true });
    checkStringList(errors, where, path, 'file_ownership', t.file_ownership, lineOf, { minItems: 1, unique: true });
    checkStringList(errors, where, path, 'artifacts', t.artifacts, lineOf, {});
    checkStringList(errors, where, path, 'acceptance', t.acceptance, lineOf, { minItems: 1 });

    checkArtifactsOwned(warnings, where, path, t, lineOf);
  });

  // ── the graph ─────────────────────────────────────────────────────────────
  //
  // The dangling references are computed HERE, not by buildGraph, because
  // buildGraph stops at the FIRST bad entry: one typo then hid every other
  // defect in the file, and the agent needed a round-trip per defect — the
  // exact cost this validator exists to remove.
  const knownIds = new Set(
    tasks.filter(isTaskMapping).map((t) => t.id).filter((id) => typeof id === 'string'),
  );
  for (const t of tasks.filter(isTaskMapping)) {
    for (const dep of Array.isArray(t.depends_on) ? t.depends_on : []) {
      if (knownIds.has(dep)) continue;
      errors.push(
        finding('DANGLING_DEP', `dangling depends_on reference: '${t.id}' depends on unknown task '${dep}'`, {
          fix: 'the referenced task must exist, or the dependency must be removed',
        }),
      );
    }
  }

  // The cycle is found on a prerequisites map built HERE, not through
  // buildGraph: buildGraph refuses a dangling reference before it can look
  // for a cycle, so a file with both reported only the dangling one. The
  // map is what findCycle needs, and findCycle already skips an edge to a
  // task it has never seen.
  const cycle = findCycle(graphMaps(tasks).prerequisites);
  if (cycle.length) {
    errors.push(
      finding('CYCLE', `dependency cycle: ${cycle.join(' -> ')}`, {
        fix: 'break the cycle — one of these tasks must not depend on the next',
      }),
    );
  }

  return { errors, warnings, tasks, graphOk: entriesOk };
}

/**
 * The code a list field reports when it carries no entry.
 *
 * `file_ownership` and `acceptance` are not merely empty — an empty one means
 * a task with no owned files, or no way to verify it — so they carry their
 * own codes.
 */
const EMPTY_LIST_CODES = { file_ownership: 'EMPTY_OWNERSHIP', acceptance: 'NO_ACCEPTANCE' };

/** The code a list field reports when one of its entries is blank. */
const EMPTY_ITEM_CODES = { acceptance: 'NO_ACCEPTANCE' };

/**
 * Check one list-of-strings field against the contract.
 *
 * @param {object[]} errors the findings to append to
 * @param {string} where the task, named
 * @param {string} path the structural path of the task
 * @param {string} key the field name
 * @param {unknown} value the field value
 * @param {(p: string) => string} lineOf the line lookup
 * @param {{minItems?: number, unique?: boolean}} spec the contract rules
 */
function checkStringList(errors, where, path, key, value, lineOf, spec) {
  const { minItems = 0, unique = false } = spec;
  const field = `${path}.${key}`;
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    errors.push(
      finding('TASK_FIELD_TYPE', `${where} has '${key}' that is not a list${lineOf(field)}`, {
        fix: `'${key}' is a list of strings`,
      }),
    );
    return;
  }
  if (value.length < minItems) {
    errors.push(
      finding(EMPTY_LIST_CODES[key] ?? 'TASK_FIELD_EMPTY', `${where} has an empty '${key}'${lineOf(field)}`, {
        fix: `give '${key}' at least one entry`,
      }),
    );
    return;
  }
  value.forEach((v, i) => {
    const item = `${field}[${i}]`;
    if (typeof v !== 'string') {
      errors.push(
        finding('TASK_FIELD_TYPE', `${where} has ${key}[${i}] that is not a string${lineOf(item)}`, {
          fix: `quote it so it reads as a string: "${scalarText(v)}"`,
        }),
      );
      return;
    }
    if (v.trim() === '') {
      errors.push(
        finding(EMPTY_ITEM_CODES[key] ?? 'TASK_FIELD_EMPTY', `${where} has an empty ${key}[${i}]${lineOf(item)}`, {
          fix: `give ${key}[${i}] a value`,
        }),
      );
    }
  });
  if (!unique) return;
  const seen = new Set();
  for (const v of value) {
    if (seen.has(v)) {
      errors.push(
        finding('TASK_FIELD_DUPLICATE', `${where} repeats '${v}' in '${key}'${lineOf(field)}`, {
          fix: `'${key}' must not repeat an entry`,
        }),
      );
      return;
    }
    seen.add(v);
  }
}

/**
 * Check that every declared artifact is covered by the task's own paths.
 *
 * The contract says `artifacts` is a subset of `file_ownership`; nothing
 * enforced it, so a task could declare a file it does not own and the floor
 * said nothing.
 *
 * It is a WARNING, not a blocker. The rule was documented but never
 * enforced, and every plan in the repo that declares artifacts breaks it —
 * so making it block would fail plans that were accepted yesterday. It is
 * reported instead, and the agent can close it.
 */
function checkArtifactsOwned(warnings, where, path, t, lineOf) {
  if (!Array.isArray(t.artifacts) || !Array.isArray(t.file_ownership)) return;
  const owned = t.file_ownership.filter((g) => typeof g === 'string');
  for (const a of t.artifacts) {
    if (typeof a !== 'string' || a.trim() === '') continue;
    if (owned.some((g) => globCovers(g, a))) continue;
    warnings.push(
      finding('ARTIFACT_NOT_OWNED', `${where} declares the artifact '${a}' but no owned path covers it${lineOf(`${path}.artifacts`)}`, {
        fix: "add the artifact to file_ownership, or drop it — a task may not write a file it does not own",
      }),
    );
  }
}

/**
 * Whether an ownership glob covers a concrete path.
 *
 * `**` spans directories; `*` and `?` do not. A glob that still carries a
 * `<placeholder>` covers nothing concrete — the plan has not filled it in.
 *
 * @param {string} glob
 * @param {string} path
 * @returns {boolean}
 */
export function globCovers(glob, path) {
  if (typeof glob !== 'string' || typeof path !== 'string') return false;
  if (!glob || !path) return false;
  if (/[<>]/.test(glob)) return false;
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  try {
    return new RegExp(`^${source}$`).test(path);
  } catch {
    return false;
  }
}

/**
 * The text a value would have had, had it been written as a scalar.
 *
 * @param {unknown} value
 * @returns {string}
 */
function scalarText(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(scalarText).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => `${k}: ${scalarText(v)}`).join(', ');
  }
  return String(value);
}

/**
 * Assemble the report, with each collection on its own window.
 *
 * @param {object[]} errors
 * @param {object[]} warnings
 * @param {number} taskCount
 * @param {number} limit
 * @param {number} offset
 * @param {string} collection
 */
function report(errors, warnings, taskCount, limit, offset, collection) {
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
    errorCodes: countByCode(errors),
    warningCodes: countByCode(warnings),
    counts: { tasks: taskCount, errors: errWindow.total, warnings: warnWindow.total },
  };
}
