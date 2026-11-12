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
import { dirname } from 'node:path';
import { computeWaves, findOwnershipConflict, graphMaps } from './graph.mjs';
import { checkPlanCoverage } from './plan-coverage.mjs';
import { auditPlan } from './plan-audit.mjs';
import { validateTasks } from './validator.mjs';
import { readPlanFile } from './plan-file.mjs';
import { formatFindings } from '../protocol/diagnostics.mjs';
import { waiverCovers } from './waivers.mjs';
import { issueCode, graphIssueCode } from '../protocol/codes.mjs';
import { invalidInput } from '../protocol/errors.mjs';
import { hint } from '../protocol/guidance.mjs';
import { toolCall } from '../protocol/call.mjs';

/**
 * The stable code for a finding.
 *
 * The audit's own findings already carry a code (`CODE: message`); the older
 * checks are classified by their message shape. A message that matches
 * nothing gets `PLAN_ISSUE` — never a silent pass.
 */
export { issueCode };

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
  let provenance = new Map();
  const read = readPlanFile(file);
  if (read.findings.length) {
    const first = read.findings[0];
    return {
      verdict: 'ISSUES',
      // The same finding the validator reports, rendered as a line: the code,
      // where it is, and the fix that clears it.
      issues: [`UNPARSEABLE: ${first.message}${first.fix ? ` — ${first.fix}` : ''}`],
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
  data = read.data;
  provenance = read.provenance;

  // The task file's own rules are the VALIDATOR's — one implementation, so
  // `validate` and `verify` cannot disagree about what a valid plan is.
  const checked = validateTasks(data, { provenance });
  const tasks = checked.tasks;
  issues.push(...formatFindings(checked.errors));
  warnings.push(...formatFindings(checked.warnings));

  // The wave-based checks need a graph. A plan whose graph does not build has
  // no waves — but it still has a coverage report, a profile, a mirror rule
  // and a decision list, and those are INDEPENDENT of the graph. Skipping
  // them meant the gate reported one defect and the agent had to fix it and
  // come back for the next: the round-trip-per-defect this validator exists
  // to remove.
  try {
    if (checked.graphOk) {
      // The tolerant construction: a dangling reference is the VALIDATOR's
      // finding, and it must not abort the gate before the coverage, the
      // mirror rule and the artifact audit have had their say.
      const { byId, prerequisites } = graphMaps(tasks);

      const { waves } = computeWaves(byId, prerequisites);
      for (const wave of waves) {
        const conflict = findOwnershipConflict(wave);
        if (conflict) {
          // The SAME glob listed twice by ONE task is the validator's
          // TASK_FIELD_DUPLICATE finding. Reporting it here as an overlap
          // too made one defect look like two, under two codes.
          if (conflict.a === conflict.b) continue;
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
    // The graph defects are already reported — by the validator, which owns
    // the task file's rules. What lands here is a failure of the CHECKS, not
    // of the plan.
    issues.push(`INTERNAL: internal check failure: ${e?.message ?? String(e)}`);
  }

  // ── the waiver ledger ────────────────────────────────────────────────────
  //
  // A waiver is an APPROVED DEVIATION, and the skill promises that "a waived
  // finding never blocks the gate". The suppression used to happen inside the
  // audit, over the audit's findings only — so a waiver naming a task-file
  // defect (NO_ACCEPTANCE, TASK_FIELD_MISSING, CYCLE) suppressed NOTHING and
  // the plan still failed. The ledger is applied here, over every finding the
  // floor reports.
  //
  // Two findings are never suppressed: a WAIVER_INVALID (a waiver cannot
  // approve its own invalidity) and a CYCLE (a dependency cycle is not a
  // deviation anyone may sign off — the plan cannot be executed at all).
  const waivedFindings = [];
  const validWaivers = lastAudit?.validWaivers ?? [];
  if (validWaivers.length && issues.length) {
    const remaining = [];
    for (const issue of issues) {
      const code = String(issue).split(':')[0];
      if (code === 'WAIVER_INVALID' || code === 'CYCLE') {
        remaining.push(issue);
        continue;
      }
      const w = validWaivers.find((v) => waiverCovers(v, issue));
      if (w) {
        waivedFindings.push({ waiver: w.id, finding: issue });
        continue;
      }
      remaining.push(issue);
    }
    issues.length = 0;
    issues.push(...remaining);
  }
  if (lastAudit) {
    lastAudit.waivedFindings = waivedFindings;
    lastAudit.waivedCodes = {};
    for (const w of waivedFindings) {
      const code = String(w.finding).split(':')[0];
      lastAudit.waivedCodes[code] = (lastAudit.waivedCodes[code] ?? 0) + 1;
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
  const collection = opts.collection === 'warnings' ? 'warnings' : 'issues';
  // BOTH collections use the SAME window. They used to differ (40 issues, 20
  // warnings), so ONE offset could not walk both: the offset that continued
  // the issues skipped past the warnings entirely, and the warnings after
  // index 20 were unreachable at any offset.
  const cappedIssues = cap(issues, limit, collection === 'issues' ? offset : 0);
  const cappedWarnings = cap(warnings, limit, collection === 'warnings' ? offset : 0);
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
    // The audit's MAPS, waivers and snapshot, so a caller that needs the
    // EVIDENCE does not have to run the audit a second time — and cannot
    // end up with a DIFFERENT set of findings than the ones reported here.
    //
    // The audit's own `issues` and `warnings` lists are NOT carried here:
    // they are the SAME findings the two lists above already carry (the
    // audit's findings are pushed into both), so shipping them again cost
    // the caller a second copy of every finding — on a broken 120-task plan
    // with 40 findings in the window, that was 40 findings twice, in one
    // payload, for nothing.
    //
    // The counts and the codes stay, because they are EXACT while the lists
    // are a sample: `issueCodes`/`warningCodes` count every finding by class.
    audit: lastAudit
      ? {
        ...lastAudit,
        issues: undefined,
        warnings: undefined,
        issuesTotal: undefined,
        warningsTotal: undefined,
        issueCodes: undefined,
        warningCodes: undefined,
      }
      : null,
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

  const read = readPlanFile(file);
  if (read.findings.length) {
    const first = read.findings[0];
    return {
      tasks: { items: [], total: 0, coveredTotal: 0, uncoveredTotal: 0, omitted: 0, offset: 0 },
      covered: { items: [], total: 0, omitted: 0, offset: 0 },
      uncovered: { items: [], total: 0, omitted: 0, offset: 0 },
      findings: { items: [`UNPARSEABLE: ${first.message}${first.fix ? ` — ${first.fix}` : ''}`], total: 1, omitted: 0, offset: 0 },
      requirements: { total: 0, covered: 0, uncovered: [], uncoveredTotal: 0, omitted: 0, offset: 0 },
      edgeCases: { total: 0, linked: 0, unlinked: [], unlinkedTotal: 0, omitted: 0, offset: 0 },
      profileRecorded: false,
    };
  }
  const data = read.data;
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
  const findingsWindow = cap(findings, limit, collection === 'findings' ? offset : 0);

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
      omitted: reqWindow.omitted,
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
      omitted: edgeWindow.omitted,
      offset: edgeWindow.offset,
    };
  } catch {
    // The coverage report must never crash: the audit's findings are the
    // verifier's business, not this action's.
  }

  // ONE TASK. The caller named a task, so the answer is about THAT task —
  // its coverage verdict and the findings that mention it. It used to
  // return the plan-wide findings list, so a caller asking about T5 got
  // findings about T2, T3 and T4 as well.
  if (opts.taskId) {
    const wanted = String(opts.taskId);
    const isCovered = covered.includes(wanted);
    const isUncovered = uncovered.includes(wanted);
    if (!isCovered && !isUncovered) {
      throw invalidInput(
        `no task '${wanted}' in ${file}`,
        { ...hint({ action: toolCall('archgen_tasks', { action: 'list', tasksYaml: '<tasks.yaml>' }), reason: "the list carries every task id." }), taskId: wanted,
        available: [...covered, ...uncovered], },
      );
    }
    // The findings must be ABOUT this task. A substring test matched
    // `T10`'s finding when the caller asked about `T1` — the answer was
    // about a task nobody asked about.
    const about = new RegExp(`(?<![A-Za-z0-9_.-])${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_.-])`);
    const mine = findings.filter((f) => about.test(String(f)));
    return {
      taskId: wanted,
      covered: isCovered,
      findings: mine,
      findingsTotal: mine.length,
    };
  }

  return {
    tasks: {
      items: taskWindow.shown,
      total: taskWindow.total,
      coveredTotal: covered.length,
      uncoveredTotal: uncovered.length,
      omitted: taskWindow.omitted,
      offset: taskWindow.offset,
    },
    covered: {
      items: coveredWindow.shown,
      total: coveredWindow.total,
      omitted: coveredWindow.omitted,
      offset: coveredWindow.offset,
    },
    uncovered: {
      items: uncoveredWindow.shown,
      total: uncoveredWindow.total,
      omitted: uncoveredWindow.omitted,
      offset: uncoveredWindow.offset,
    },
    findings: {
      items: findingsWindow.shown,
      total: findingsWindow.total,
      omitted: findingsWindow.omitted,
      offset: findingsWindow.offset,
    },
    requirements,
    edgeCases,
    profileRecorded,
  };
}
