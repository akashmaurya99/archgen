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
import { join } from 'node:path';
import { docIndex } from './doc-navigator.mjs';
import { planGraph } from './plan-grapher.mjs';

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
    docsValidation: null,
  };

  // The evidence map: every markdown artifact under the slug, with its
  // section anchors. A MAP, not a copy — the agent reads the sections it
  // needs and never re-reads the whole plan.
  try {
    if (existsSync(scope.slugDir)) {
      const digest = docIndex(scope.slugDir, { mode: 'digest', projectRoot: ctx.projectRoot });
      const files = (digest.data.files ?? []).map((f) => ({
        path: f.path,
        sections: (f.sections ?? []).map((s) => ({ slug: s.slug, title: s.title })),
      }));
      out.evidence = { files, fileCount: files.length };
    }
  } catch {
    out.evidence = null; // a missing artifact space is not a brief failure
  }

  // The dependency graph — rendered once, so the reviewer reads it instead of
  // spending a tool call to fetch it.
  try {
    if (existsSync(scope.tasksYaml)) {
      const g = planGraph(scope.tasksYaml, {
        mermaid: true,
        status: true,
        projectRoot: ctx.projectRoot,
      });
      out.graph = typeof g.data === 'string' ? g.data : null;
    }
  } catch {
    out.graph = null; // a plan that cannot be graphed is reported by the verifier
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

  return out;
}
