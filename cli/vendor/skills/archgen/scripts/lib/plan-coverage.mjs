// plan-coverage.mjs — single shared implementation of plan<->tasks cross-checks.
// WHY: validate.mjs --plan and verify-plan.mjs must apply IDENTICAL rules
// (Metis: two implementations of one rule will drift).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** @returns {string[]} error findings (empty = coverage OK) */
export function checkPlanCoverage(planDir, tasks) {
  const findings = [];
  if (!existsSync(planDir)) return [`plans dir not found: ${planDir}`];
  const files = readdirSync(planDir).filter((f) => f.endsWith('.md'));
  const planText = files.map((f) => readFileSync(join(planDir, f), 'utf8')).join('\n');

  const taskIds = new Set(tasks.map((t) => t.id));
  // Task ids referenced in plans: bare tokens that match an existing-or-not id pattern.
  const referenced = new Set();
  for (const t of taskIds) {
    const re = new RegExp(`\\b${escapeRe(t)}\\b`);
    if (re.test(planText)) referenced.add(t);
  }
  for (const t of tasks) {
    if (!referenced.has(t.id)) findings.push(`task '${t.id}' is not mentioned in any plan file under ${planDir}`);
  }
  // Inverse: plan mentions ids like TASK-xx not present in tasks.yaml.
  for (const m of planText.matchAll(/\b[A-Z][A-Z0-9]+-[0-9]+\b/g)) {
    if (!taskIds.has(m[0])) findings.push(`plan references unknown task id '${m[0]}' (not in tasks.yaml)`);
  }
  return findings;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
