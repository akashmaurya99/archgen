#!/usr/bin/env node
// verify-plan.mjs — the VERIFIER gate as an executable check.
// Usage: node verify-plan.mjs <tasks.yaml> --plan <plans-dir>
// stdout: JSON {verdict: "APPROVE"|"ISSUES", issues:[...]}
// Exit: 0 APPROVE · 1 ISSUES. Structural checks only (the agent-side verifier
// adds judgment on top; this script is the deterministic floor).
import { readFileSync } from 'node:fs';
import { parseYaml } from './lib/yaml.mjs';
import { buildGraph, findCycle, computeWaves, findOwnershipConflict, GraphError } from './lib/graph.mjs';
import { checkPlanCoverage } from './lib/plan-coverage.mjs';

const [, , file, ...rest] = process.argv;
const planIdx = rest.indexOf('--plan');
if (!file || planIdx < 0 || !rest[planIdx + 1]) {
  console.error('usage: verify-plan.mjs <tasks.yaml> --plan <plans-dir>');
  process.exit(2);
}
const planDir = rest[planIdx + 1];
const issues = [];

let data;
try {
  ({ data } = parseYaml(readFileSync(file, 'utf8'), { filename: file }));
} catch (e) {
  console.log(JSON.stringify({ verdict: 'ISSUES', issues: [`unparseable tasks.yaml: ${e.message}`] }, null, 2));
  process.exit(1);
}
const tasks = data?.tasks;
if (!Array.isArray(tasks)) { issues.push('missing tasks: sequence'); }

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
        if (conflict) issues.push(`same-wave ownership overlap: '${conflict.glob}' on '${conflict.a}' and '${conflict.b}'`);
      }
    }

    issues.push(...checkPlanCoverage(planDir, tasks));
  } catch (e) {
    // Exotic inputs must surface as a clean ISSUES verdict, never a raw stack:
    // the verifier is a gate, and gates report findings, not crashes.
    if (e instanceof GraphError) issues.push(e.message);
    else issues.push(`internal check failure: ${e?.message ?? String(e)}`);
  }
}

const verdict = issues.length ? 'ISSUES' : 'APPROVE';
console.log(JSON.stringify({ verdict, issues }, null, 2));
process.exit(verdict === 'APPROVE' ? 0 : 1);
