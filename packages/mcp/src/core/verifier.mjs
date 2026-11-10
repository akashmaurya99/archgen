// verifier.mjs — the VERIFIER gate as an executable check.
//
// Extracted verbatim from skill/scripts/verify-plan.mjs (deleted in the
// MCP-first cutover). This is the DETERMINISTIC FLOOR of the gate: the
// agent-side verifier adds judgment on top (wave-boundary sanity, objective
// verifiability of acceptance criteria, code-standards plausibility).
//
// A gate reports findings, it never crashes: exotic inputs surface as an
// ISSUES verdict, not a raw stack trace.
//
// EVERY FINDING CARRIES A STABLE CODE. The code is what makes the floor
// usable at scale: fixes can be grouped by code, tests assert behaviour
// instead of prose, and CI can count classes ("7 MIRROR_MISSING, 4
// MATRIX_CLAIM_MISMATCH") instead of counting sentences.
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { buildGraph, findCycle, computeWaves, findOwnershipConflict, GraphError } from './graph.mjs';
import { checkPlanCoverage } from './plan-coverage.mjs';
import { auditPlan } from './plan-audit.mjs';
import { invalidInput } from './errors.mjs';

/** The codes the floor reports for the checks that predate the audit. */
const BASE_CODES = [
  [/^unparseable tasks\.yaml/, 'UNPARSEABLE'],
  [/^missing tasks: sequence/, 'NO_TASKS'],
  [/^dependency cycle:/, 'CYCLE'],
  [/^dangling depends_on reference:/, 'DANGLING_DEP'],
  [/duplicate task id:/, 'DUPLICATE_TASK_ID'],
  [/has no acceptance criteria/, 'NO_ACCEPTANCE'],
  [/has empty or whitespace-only acceptance/, 'NO_ACCEPTANCE'],
  [/has empty file_ownership/, 'EMPTY_OWNERSHIP'],
  [/^same-wave ownership overlap:/, 'OWNERSHIP_OVERLAP'],
  [/is not mentioned in any plan file/, 'PLAN_TASK_COVERAGE'],
  [/^plan references unknown task id/, 'UNKNOWN_TASK_ID'],
  [/^plans dir not found/, 'NO_PLAN_DIR'],
  [/^cannot read/, 'IO_ERROR'],
  [/^internal check failure/, 'INTERNAL'],
];

/**
 * The stable code for a finding.
 *
 * The audit's own findings already carry a code (`CODE: message`); the older
 * checks are classified by their message shape. A message that matches
 * nothing gets `PLAN_ISSUE` — never a silent pass.
 */
export function issueCode(message) {
  const text = String(message ?? '');
  const explicit = /^([A-Z][A-Z0-9_]{2,}):\s/.exec(text);
  if (explicit) return explicit[1];
  for (const [pattern, code] of BASE_CODES) if (pattern.test(text)) return code;
  return 'PLAN_ISSUE';
}

/**
 * The most findings one answer carries.
 *
 * A broken plan can produce one finding per task — 120 tasks, 120 findings,
 * 7,000 tokens of prose in the orchestrator's context, for a list it will fix
 * as ONE CLASS anyway ("every task is missing its mirrored test path").
 *
 * So the list is bounded and the COUNTS are the payload: `issueCodes` says how
 * many of each class there are, `issuesTotal` says how many there were, and
 * the next run of the floor shows the next batch. The verdict is computed
 * from the FULL count, never from the capped list.
 */
export const MAX_FINDINGS = 40;
export const MAX_WARNINGS = 20;

/** Count findings by code. */
function countByCode(list) {
  const out = {};
  for (const m of list) {
    const code = issueCode(m);
    out[code] = (out[code] ?? 0) + 1;
  }
  return out;
}

/**
 * Keep a WINDOW of the list, and report what is outside it.
 *
 * The window is CONTINUABLE: the caller passes `offset` to walk the rest.
 * A bound that hides the tail without a way to reach it is not a bound — it
 * is a loss, and the agent would have to fix a class it cannot enumerate.
 */
function cap(list, max, offset = 0) {
  const start = Math.max(0, Math.min(offset, list.length));
  const shown = list.slice(start, start + max);
  return {
    shown,
    total: list.length,
    offset: start,
    omitted: Math.max(0, list.length - (start + shown.length)),
  };
}

/**
 * Run the deterministic verifier gate.
 *
 * @param {string} file absolute path to tasks.yaml
 * @param {string} planDir absolute path to the plans directory
 * @param {{offset?: number, limit?: number, collection?: 'issues'|'warnings'}} [opts]
 *   `offset` walks the selected collection; `limit` narrows the window.
 * @returns {{verdict: 'APPROVE'|'ISSUES', issues: string[], warnings: string[],
 *            issueCodes: object, warningCodes: object, issuesTotal: number,
 *            warningsTotal: number, omitted: {issues: number, warnings: number}}}
 */
export function verifyPlan(file, planDir, opts = {}) {
  const issues = [];
  const warnings = [];
  /** The audit, kept so the caller can have its maps without a second run. */
  let lastAudit = null;

  let data;
  try {
    ({ data } = parseYaml(readFileSync(file, 'utf8'), { filename: file }));
  } catch (e) {
    return {
      verdict: 'ISSUES',
      issues: [`UNPARSEABLE: unparseable tasks.yaml: ${e.message}`],
      warnings: [],
      issueCodes: { UNPARSEABLE: 1 },
      warningCodes: {},
      issuesTotal: 1,
      warningsTotal: 0,
      issuesOffset: 0,
      warningsOffset: 0,
      omitted: { issues: 0, warnings: 0 },
    };
  }
  const tasks = data?.tasks;
  if (!Array.isArray(tasks)) issues.push('NO_TASKS: missing tasks: sequence');

  if (issues.length === 0) {
    try {
      const { byId, prerequisites } = buildGraph(tasks);
      const cycle = findCycle(prerequisites);
      if (cycle.length) issues.push(`CYCLE: dependency cycle: ${cycle.join(' -> ')}`);

      // Every task must carry acceptance criteria — the verifier refuses work
      // that cannot be objectively checked later. Entries must be non-blank
      // strings: whitespace-only or empty entries are placeholders, not criteria.
      for (const t of tasks) {
        if (!Array.isArray(t.acceptance) || t.acceptance.length === 0) {
          issues.push(`NO_ACCEPTANCE: task '${t.id}' has no acceptance criteria`);
        } else if (t.acceptance.some((a) => typeof a !== 'string' || a.trim() === '')) {
          issues.push(`NO_ACCEPTANCE: task '${t.id}' has empty or whitespace-only acceptance criteria`);
        }
        if (!Array.isArray(t.file_ownership) || t.file_ownership.length === 0) {
          issues.push(`EMPTY_OWNERSHIP: task '${t.id}' has empty file_ownership`);
        }
      }

      if (!issues.length) {
        const { waves } = computeWaves(byId, prerequisites);
        for (const wave of waves) {
          const conflict = findOwnershipConflict(wave);
          if (conflict) {
            issues.push(
              `OWNERSHIP_OVERLAP: same-wave ownership overlap: '${conflict.glob}' on '${conflict.a}' and '${conflict.b}'`,
            );
          }
        }
      }

      issues.push(...checkPlanCoverage(planDir, tasks).findings.map((m) => withCode(m)));

      // The mechanical floor: the checks a gate agent would otherwise make by
      // hand, every round. They are computed HERE so the agent is left with
      // the judgment it is actually for.
      const audit = auditPlan({ slugDir: dirname(planDir), tasks });
      lastAudit = audit;
      issues.push(...audit.issues);
      warnings.push(...audit.warnings);
    } catch (e) {
      if (e instanceof GraphError) issues.push(`CYCLE: ${e.message}`);
      else issues.push(`INTERNAL: internal check failure: ${e?.message ?? String(e)}`);
    }
  }

  // The two lists are SEPARATE collections with separate windows.
  //
  // They used to share ONE offset over two different lengths (40 issues, 20
  // warnings), so the warnings between index 20 and 39 fell into the gap
  // between the windows and were reachable at NO offset — the tail was lost,
  // not bounded. Each collection now has its own window and its own cursor.
  const offset = Number.isInteger(opts.offset) ? opts.offset : 0;
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, MAX_FINDINGS) : MAX_FINDINGS;
  const warningLimit = Math.min(limit, MAX_WARNINGS);
  const collection = opts.collection === 'warnings' ? 'warnings' : 'issues';
  const cappedIssues = cap(issues, limit, collection === 'issues' ? offset : 0);
  const cappedWarnings = cap(warnings, warningLimit, collection === 'warnings' ? offset : 0);
  return {
    verdict: issues.length ? 'ISSUES' : 'APPROVE',
    issues: cappedIssues.shown,
    warnings: cappedWarnings.shown,
    issueCodes: countByCode(issues),
    warningCodes: countByCode(warnings),
    issuesTotal: cappedIssues.total,
    warningsTotal: cappedWarnings.total,
    issuesOffset: cappedIssues.offset,
    warningsOffset: cappedWarnings.offset,
    omitted: { issues: cappedIssues.omitted, warnings: cappedWarnings.omitted },
    // The audit's maps, waivers and snapshot, so a caller that needs the
    // EVIDENCE does not have to run the audit a second time — and cannot
    // end up with a DIFFERENT set of findings than the ones reported here.
    audit: lastAudit,
  };
}

/** Prefix a finding with its stable code (idempotent). */
function withCode(message) {
  const text = String(message ?? '');
  return /^[A-Z][A-Z0-9_]{2,}:\s/.test(text) ? text : `${issueCode(text)}: ${text}`;
}

/**
 * Plan<->task coverage on its own (the `coverage` action of archgen_plan).
 *
 * It now reports the WHOLE traceability picture — the task coverage, the
 * requirement coverage and the edge-case coverage — so there is ONE coverage
 * report instead of two, one of which knew nothing about traceability.
 *
 * FOUR COLLECTIONS, FOUR WINDOWS. The report carries the task list, the
 * coverage findings, the uncovered requirements and the unlinked edge cases.
 * They used to share ONE offset over one concatenated list, so the tool
 * applied the offset a second time and the ids it called "covered" were the
 * tail of the uncovered list. Each collection now carries its own window,
 * its own total and its own cursor.
 *
 * @param {string} file absolute path to tasks.yaml
 * @param {string} planDir absolute path to the plans directory
 * @param {{offset?: number, limit?: number, collection?: string}} [opts]
 * @returns {object}
 */
export function planCoverage(file, planDir, opts = {}) {
  const offset = Number.isInteger(opts.offset) ? opts.offset : 0;
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, MAX_FINDINGS) : MAX_FINDINGS;
  const collection = String(opts.collection ?? 'tasks');

  let data;
  try {
    ({ data } = parseYaml(readFileSync(file, 'utf8'), { filename: file }));
  } catch (e) {
    return {
      tasks: { items: [], total: 0, coveredTotal: 0, uncoveredTotal: 0, offset: 0 },
      covered: { items: [], total: 0, offset: 0 },
      uncovered: { items: [], total: 0, offset: 0 },
      findings: { items: [`UNPARSEABLE: unparseable tasks.yaml: ${e.message}`], total: 1, offset: 0 },
      requirements: { total: 0, covered: 0, uncovered: [], uncoveredTotal: 0, offset: 0 },
      edgeCases: { total: 0, linked: 0, unlinked: [], unlinkedTotal: 0, offset: 0 },
      profileRecorded: false,
    };
  }
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const { findings, referenced, mentionedInTasks } = checkPlanCoverage(planDir, tasks);
  const covered = [];
  const uncovered = [];
  /** The whole task list, in task order, each entry tagged with its state. */
  const all = [];
  for (const t of tasks) {
    const id = String(t?.id ?? '');
    if (!id) continue;
    const mentioned = referenced.has(id) || mentionedInTasks.has(id);
    (mentioned ? covered : uncovered).push(id);
    all.push({ id, covered: mentioned });
  }

  // EVERY COLLECTION HAS ITS OWN WINDOW AND ITS OWN CURSOR. The `tasks`
  // collection used to have none — the offset was applied only to the two
  // halves — so the DEFAULT window could not be paged at all.
  const taskWindow = cap(all, limit, collection === 'tasks' ? offset : 0);
  const coveredWindow = cap(covered, limit, collection === 'covered' ? offset : 0);
  const uncoveredWindow = cap(uncovered, limit, collection === 'uncovered' ? offset : 0);

  let requirements = { total: 0, covered: 0, uncovered: [], uncoveredTotal: 0, offset: 0 };
  let edgeCases = { total: 0, linked: 0, unlinked: [], unlinkedTotal: 0, offset: 0 };
  let profileRecorded = false;
  try {
    const audit = auditPlan({ slugDir: dirname(planDir), tasks });
    profileRecorded = Boolean(audit.profile);
    const reqs = audit.maps.requirements ?? [];
    const reqUncovered = reqs.filter((r) => !r.covered).map((r) => r.id);
    const reqWindow = cap(reqUncovered, limit, collection === 'requirements' ? offset : 0);
    requirements = {
      total: reqs.length,
      covered: reqs.filter((r) => r.covered).length,
      uncovered: reqWindow.shown,
      uncoveredTotal: reqWindow.total,
      offset: reqWindow.offset,
    };
    const rows = audit.maps.edgeMatrix ?? [];
    const unlinked = rows.filter((r) => !r.valid || !r.claimOk).map((r) => r.row);
    const edgeWindow = cap(unlinked, limit, collection === 'edgeCases' ? offset : 0);
    edgeCases = {
      total: rows.length,
      linked: rows.filter((r) => r.valid && r.claimOk).length,
      unlinked: edgeWindow.shown,
      unlinkedTotal: edgeWindow.total,
      offset: edgeWindow.offset,
    };
  } catch {
    // The coverage report must never crash: the audit's findings are the
    // verifier's business, not this action's.
  }

  const findingsWindow = cap(findings, limit, collection === 'findings' ? offset : 0);

  // ONE TASK. The caller named a task, so the answer is about THAT task —
  // its coverage verdict and the findings that mention it. It used to
  // return the plan-wide findings list, so a caller asking about T5 got
  // findings about T2, T3 and T4 as well.
  if (opts.taskId) {
    const wanted = String(opts.taskId);
    const isCovered = covered.includes(wanted);
    const isUncovered = uncovered.includes(wanted);
    if (!isCovered && !isUncovered) {
      throw invalidInput(`no task '${wanted}' in ${file}`, {
        taskId: wanted,
        available: [...covered, ...uncovered],
      });
    }
    return {
      taskId: wanted,
      covered: isCovered,
      findings: findings.filter((f) => String(f).includes(wanted)),
      findingsTotal: findings.filter((f) => String(f).includes(wanted)).length,
    };
  }

  return {
    tasks: {
      items: taskWindow.shown,
      total: taskWindow.total,
      coveredTotal: covered.length,
      uncoveredTotal: uncovered.length,
      offset: taskWindow.offset,
    },
    covered: { items: coveredWindow.shown, total: coveredWindow.total, offset: coveredWindow.offset },
    uncovered: { items: uncoveredWindow.shown, total: uncoveredWindow.total, offset: uncoveredWindow.offset },
    findings: { items: findingsWindow.shown, total: findingsWindow.total, offset: findingsWindow.offset },
    requirements,
    edgeCases,
    profileRecorded,
  };
}
