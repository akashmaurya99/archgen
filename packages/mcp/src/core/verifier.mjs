// verifier.mjs — the VERIFIER gate as an executable check.
//
// Extracted verbatim from skill/scripts/verify-plan.mjs (deleted in the
// MCP-first cutover). This is the DETERMINISTIC FLOOR of the gate: the
// agent-side verifier adds judgment on top (wave-boundary sanity, objective
// verifiability of acceptance criteria, code-standards plausibility).
//
// A gate reports findings, it never crashes: exotic inputs surface as an
// ISSUES verdict, not a raw stack trace.
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { buildGraph, findCycle, computeWaves, findOwnershipConflict, GraphError } from './graph.mjs';
import { checkPlanCoverage } from './plan-coverage.mjs';
import { auditPlan } from './plan-audit.mjs';

/**
 * Run the deterministic verifier gate.
 *
 * @param {string} file absolute path to tasks.yaml
 * @param {string} planDir absolute path to the plans directory
 * @returns {{verdict: 'APPROVE'|'ISSUES', issues: string[], warnings: string[]}}
 */
export function verifyPlan(file, planDir) {
  const issues = [];
  const warnings = [];

  let data;
  try {
    ({ data } = parseYaml(readFileSync(file, 'utf8'), { filename: file }));
  } catch (e) {
    return { verdict: 'ISSUES', issues: [`unparseable tasks.yaml: ${e.message}`] };
  }
  const tasks = data?.tasks;
  if (!Array.isArray(tasks)) issues.push('missing tasks: sequence');

  if (issues.length === 0) {
    try {
      const { byId, prerequisites } = buildGraph(tasks);
      const cycle = findCycle(prerequisites);
      if (cycle.length) issues.push(`dependency cycle: ${cycle.join(' -> ')}`);

      // Every task must carry acceptance criteria — the verifier refuses work
      // that cannot be objectively checked later. Entries must be non-blank
      // strings: whitespace-only or empty entries are placeholders, not criteria.
      for (const t of tasks) {
        if (!Array.isArray(t.acceptance) || t.acceptance.length === 0) {
          issues.push(`task '${t.id}' has no acceptance criteria`);
        } else if (t.acceptance.some((a) => typeof a !== 'string' || a.trim() === '')) {
          issues.push(`task '${t.id}' has empty or whitespace-only acceptance criteria`);
        }
        if (!Array.isArray(t.file_ownership) || t.file_ownership.length === 0) {
          issues.push(`task '${t.id}' has empty file_ownership`);
        }
      }

      if (!issues.length) {
        const { waves } = computeWaves(byId, prerequisites);
        for (const wave of waves) {
          const conflict = findOwnershipConflict(wave);
          if (conflict) {
            issues.push(`same-wave ownership overlap: '${conflict.glob}' on '${conflict.a}' and '${conflict.b}'`);
          }
        }
      }

      issues.push(...checkPlanCoverage(planDir, tasks).findings);

      // The mechanical floor: the checks a gate agent would otherwise make by
      // hand, every round. They are computed HERE so the agent is left with
      // the judgment it is actually for.
      const audit = auditPlan({ slugDir: dirname(planDir), tasks });
      issues.push(...audit.issues);
      warnings.push(...audit.warnings);
    } catch (e) {
      if (e instanceof GraphError) issues.push(e.message);
      else issues.push(`internal check failure: ${e?.message ?? String(e)}`);
    }
  }

  return { verdict: issues.length ? 'ISSUES' : 'APPROVE', issues, warnings };
}

/**
 * Plan<->task coverage on its own (the `coverage` action of archgen_plan).
 *
 * @param {string} file absolute path to tasks.yaml
 * @param {string} planDir absolute path to the plans directory
 * @returns {{covered: string[], uncovered: string[], findings: string[]}}
 */
export function planCoverage(file, planDir) {
  let data;
  try {
    ({ data } = parseYaml(readFileSync(file, 'utf8'), { filename: file }));
  } catch (e) {
    return { covered: [], uncovered: [], findings: [`unparseable tasks.yaml: ${e.message}`] };
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
  return { covered, uncovered, findings };
}
