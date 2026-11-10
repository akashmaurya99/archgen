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
 * @param {{offset?: number}} [opts] `offset` walks the findings list
 * @returns {{verdict: 'APPROVE'|'ISSUES', issues: string[], warnings: string[],
 *            issueCodes: object, warningCodes: object, issuesTotal: number,
 *            warningsTotal: number, omitted: {issues: number, warnings: number}}}
 */
export function verifyPlan(file, planDir, opts = {}) {
  const issues = [];
  const warnings = [];

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
      issues.push(...audit.issues);
      warnings.push(...audit.warnings);
    } catch (e) {
      if (e instanceof GraphError) issues.push(`CYCLE: ${e.message}`);
      else issues.push(`INTERNAL: internal check failure: ${e?.message ?? String(e)}`);
    }
  }

  const offset = Number.isInteger(opts.offset) ? opts.offset : 0;
  const cappedIssues = cap(issues, MAX_FINDINGS, offset);
  const cappedWarnings = cap(warnings, MAX_WARNINGS, offset);
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
 * @param {string} file absolute path to tasks.yaml
 * @param {string} planDir absolute path to the plans directory
 * @returns {{covered: string[], uncovered: string[], findings: string[],
 *            requirements: object, edgeCases: object, profileRecorded: boolean}}
 */
export function planCoverage(file, planDir, opts = {}) {
  let data;
  try {
    ({ data } = parseYaml(readFileSync(file, 'utf8'), { filename: file }));
  } catch (e) {
    return {
      covered: [],
      uncovered: [],
      findings: [`UNPARSEABLE: unparseable tasks.yaml: ${e.message}`],
      requirements: { total: 0, covered: 0, uncovered: [] },
      edgeCases: { total: 0, linked: 0, unlinked: [] },
      profileRecorded: false,
    };
  }
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const { findings, referenced, mentionedInTasks } = checkPlanCoverage(planDir, tasks);
  const covered = [];
  const uncovered = [];
  for (const t of tasks) {
    const id = String(t?.id ?? '');
    if (!id) continue;
    const mentioned = referenced.has(id) || mentionedInTasks.has(id);
    (mentioned ? covered : uncovered).push(id);
  }
  // The uncovered list is bounded too — and CONTINUABLE: `offset` walks it.
  // 120 uncovered tasks is 120 ids the caller cannot act on one by one, but it
  // CAN reach them all.
  const offset = Number.isInteger(opts.offset) ? opts.offset : 0;
  const uncoveredStart = Math.max(0, Math.min(offset, uncovered.length));
  const uncoveredShown = uncovered.slice(uncoveredStart, uncoveredStart + MAX_FINDINGS);

  let requirements = { total: 0, covered: 0, uncovered: [] };
  let edgeCases = { total: 0, linked: 0, unlinked: [] };
  let profileRecorded = false;
  try {
    const audit = auditPlan({ slugDir: dirname(planDir), tasks });
    profileRecorded = Boolean(audit.profile);
    const reqs = audit.maps.requirements ?? [];
    const reqUncovered = reqs.filter((r) => !r.covered).map((r) => r.id);
    requirements = {
      total: reqs.length,
      covered: reqs.filter((r) => r.covered).length,
      uncovered: reqUncovered.slice(0, MAX_FINDINGS),
      uncoveredTotal: reqUncovered.length,
    };
    const rows = audit.maps.edgeMatrix ?? [];
    const unlinked = rows.filter((r) => !r.valid || !r.claimOk).map((r) => r.row);
    edgeCases = {
      total: rows.length,
      linked: rows.filter((r) => r.valid && r.claimOk).length,
      unlinked: unlinked.slice(0, MAX_FINDINGS),
      unlinkedTotal: unlinked.length,
    };
  } catch {
    // The coverage report must never crash: the audit's findings are the
    // verifier's business, not this action's.
  }

  // The findings list is bounded like the gate's, and walkable with `offset`.
  const cappedFindings = cap(findings, MAX_FINDINGS, offset);
  return {
    covered,
    uncovered: uncoveredShown,
    uncoveredTotal: uncovered.length,
    uncoveredOffset: uncoveredStart,
    findings: cappedFindings.shown,
    findingsTotal: cappedFindings.total,
    findingsOffset: cappedFindings.offset,
    omitted: { findings: cappedFindings.omitted },
    requirements,
    edgeCases,
    profileRecorded,
  };
}
