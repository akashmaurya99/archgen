// plan-coverage.mjs — single shared implementation of plan<->tasks cross-checks.
// WHY: validate.mjs --plan and verify-plan.mjs must apply IDENTICAL rules
// (Metis: two implementations of one rule will drift).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} planDir
 * @param {any[]} tasks
 * @returns {{findings: string[], referenced: Set<string>, mentionedInTasks: Set<string>}}
 *   `findings`     error findings (empty = coverage OK)
 *   `referenced`   task ids that a plan file mentions
 *   `mentionedInTasks` task ids another task's text mentions
 *
 * The sets are RETURNED, not just used internally. A consumer that needs to
 * know which tasks are covered must read them from here: re-deriving the
 * answer from `findings` — which are NEGATIVE — inverts it, because an
 * uncovered task's finding names the task.
 */
export function checkPlanCoverage(planDir, tasks) {
  const findings = [];
  const referenced = new Set();
  const mentionedInTasks = new Set();
  if (!existsSync(planDir)) return { findings: [`plans dir not found: ${planDir}`], referenced, mentionedInTasks };
  const files = readdirSync(planDir).filter((f) => f.endsWith('.md'));
  const planText = files.map((f) => readFileSync(join(planDir, f), 'utf8')).join('\n');

  const taskIds = new Set(tasks.map((t) => t.id));
  // Task ids referenced in plans: bare tokens that match an existing-or-not id pattern.
  for (const t of taskIds) {
    const re = new RegExp(`\\b${escapeRe(t)}\\b`);
    if (re.test(planText)) referenced.add(t);
  }
  for (const t of tasks) {
    if (!referenced.has(t.id)) findings.push(`task '${t.id}' is not mentioned in any plan file under ${planDir}`);
  }
  // A task may also be "covered" by ANOTHER task naming it — the dependency
  // graph documents it.
  for (const t of tasks) {
    for (const other of tasks) {
      if (other?.id === t.id) continue;
      if (mentions(other, t.id)) mentionedInTasks.add(t.id);
    }
  }
  // Inverse: plan mentions ids like TASK-xx not present in tasks.yaml.
  for (const m of planText.matchAll(/\b[A-Z][A-Z0-9]+-[0-9]+\b/g)) {
    if (!taskIds.has(m[0])) findings.push(`plan references unknown task id '${m[0]}' (not in tasks.yaml)`);
  }
  return { findings, referenced, mentionedInTasks };
}

/** Does any task reference `id` in its artifacts / acceptance text? */
function mentions(task, id) {
  const hay = JSON.stringify([task?.artifacts ?? [], task?.acceptance ?? [], task?.title ?? '']);
  return hay.includes(id);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
