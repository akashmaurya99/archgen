// brief-context.mjs — what a dispatch brief carries besides its task.
//
// WHY A SEPARATE MODULE: the brief TEMPLATE holds the protocol (what to
// examine, what to return). The CONTEXT holds the facts (which files exist,
// which sections they have, what the tools already said). They change for
// different reasons and at different times, so they are assembled separately
// and composed once.
//
// THE RENDERING RULE: everything here is computed BY THE TOOL, not requested
// by the orchestrator. The old review brief said "attach the mermaid graph
// and the docs-validate result", which cost two tool calls per gate round —
// and the graph call failed on every plan, so the reviewer ran without it.
// Rendering it once, into the brief, removes the extra calls AND the
// dependency.
import { existsSync } from 'node:fs';
import { docIndex } from './doc-navigator.mjs';
import { planGraph } from '../plan/plan-grapher.mjs';
import { verifyPlan } from '../plan/verifier.mjs';

/**
 * The archgen calls each brief kind is ALLOWED to make.
 *
 * The list is exhaustive on purpose: a sub-agent that runs the archgen tool
 * suite is re-deriving facts the brief already carries, and can drift from
 * the protocol the orchestrator is following.
 */
const ALLOWED_CALLS = {
  verifier: ["archgen_plan{action:'verify'}", "archgen_docs{action:'validate'}"],
  review: [],
  survey: [],
  investigate: ["archgen_plan{action:'impact'}"],
};

/** The archgen calls each brief kind may make — the single source of truth. */
export { ALLOWED_CALLS };

/**
 * Build the context block for one brief.
 *
 * @param {string} kind the brief kind
 * @param {{slug: string, slugDir: string, plansDir: string, tasksYaml: string}} scope
 * @param {{projectRoot: string}} ctx
 * @returns {{
 *   scope: object,
 *   allowedCalls: string[],
 *   evidence: {files: Array<{path: string, sections: Array<{slug: string, title: string}>}>, fileCount: number}|null,
 *   graph: string|null,
 *   docsValidation: {valid: boolean, broken: unknown[], warnings: unknown[]}|null,
 * }}
 */
export function buildBriefContext(kind, scope, ctx) {
  const out = {
    scope,
    allowedCalls: ALLOWED_CALLS[kind] ?? [],
    evidence: null,
    graph: null,
    graphNote: null,
    docsValidation: null,
    audit: null,
  };

  // The evidence map: every markdown artifact under the slug, with its
  // section anchors. A MAP, not a copy — the agent reads the sections it
  // needs and never re-reads the whole plan.
  try {
    if (existsSync(scope.slugDir)) {
      // The brief is the agent's navigation map, so it needs the outline — but
      // bounded: the brief's own budget governs the whole message, and the
      // agent is told what was left out.
      const digest = docIndex(scope.slugDir, { mode: 'digest', sectionBudget: 120, projectRoot: ctx.projectRoot });
      const files = (digest.data.files ?? []).map((f) => ({
        path: f.path,
        sections: (f.sections ?? []).map((s) => ({ slug: s.slug, title: s.title })),
      }));
      out.evidence = {
        files,
        fileCount: files.length,
        sectionsOmitted: digest.data.sectionsOmitted === true,
      };
    }
  } catch {
    out.evidence = null; // a missing artifact space is not a brief failure
  }

  // The dependency graph — rendered once, so the reviewer reads it instead of
  // spending a tool call to fetch it.
  //
  // It used to be DROPPED SILENTLY on a plan above the whole-graph ceiling:
  // the brief then told the reviewer the graph was "rendered for you — do not
  // re-fetch", and there was none. A gate that silently judges without the
  // dependency picture is not a gate. The refusal now becomes a NOTE that
  // names the scoped call that works.
  try {
    if (existsSync(scope.tasksYaml)) {
      const g = planGraph(scope.tasksYaml, {
        mermaid: true,
        status: true,
        projectRoot: ctx.projectRoot,
      });
      out.graph = typeof g.data === 'string' ? g.data : null;
    }
  } catch (e) {
    const nodes = e?.details?.nodes ?? null;
    out.graph = null;
    out.graphNote = nodes
      ? `The whole dependency graph has ${nodes} nodes, above the whole-graph ceiling, so it is NOT rendered here. ` +
        `Fetch a scoped view instead: archgen_plan{action:'graph',node:'<task id>'}. Judge the waves from the plan and tasks.yaml.`
      : 'The dependency graph could not be rendered for this plan — read the waves from tasks.yaml.';
  }

  // The reference-integrity result — the deterministic floor's second half.
  try {
    if (existsSync(scope.slugDir)) {
      const v = docIndex(scope.slugDir, { mode: 'validate', projectRoot: ctx.projectRoot });
      out.docsValidation = {
        valid: v.data.valid === true,
        broken: v.data.broken ?? [],
        warnings: v.data.warnings ?? [],
      };
    }
  } catch {
    out.docsValidation = null;
  }

  // The mechanical floor — the checks a gate agent used to make by hand,
  // every round. Rendered here, the agent reads them instead of re-deriving
  // them (and missing some).
  //
  // It is the SAME result `archgen_plan{action:'verify'}` returns — the
  // verdict, the findings with their codes, AND the task-level codes
  // (CYCLE, NO_ACCEPTANCE, OWNERSHIP_OVERLAP, …) that only the verifier
  // produces. The brief used to recompute a SUBSET of the floor, so a gate
  // agent could be told "the floor is clean" while the floor itself had
  // findings the brief never showed.
  try {
    if (existsSync(scope.tasksYaml)) {
      const result = verifyPlan(scope.tasksYaml, scope.plansDir);
      const audit = result.audit ?? {};
      out.audit = {
        verdict: result.verdict,
        issues: result.issues,
        warnings: result.warnings,
        issuesTotal: result.issuesTotal,
        warningsTotal: result.warningsTotal,
        issueCodes: result.issueCodes,
        warningCodes: result.warningCodes,
        waivedFindings: audit.waivedFindings ?? [],
        waivedCodes: audit.waivedCodes ?? {},
        maps: audit.maps ?? {},
        waivers: audit.waivers ?? [],
        profile: audit.profile ?? null,
        snapshot: audit.snapshot ?? null,
      };
    }
  } catch {
    out.audit = null; // an unreadable plan is the verifier's finding, not a brief failure
  }

  return out;
}
