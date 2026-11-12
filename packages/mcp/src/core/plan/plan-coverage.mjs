// plan-coverage.mjs — single shared implementation of plan<->tasks cross-checks.
// WHY: validate.mjs --plan and verify-plan.mjs must apply IDENTICAL rules
// (Metis: two implementations of one rule will drift).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isTaskMapping } from './graph.mjs';

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
  let files;
  try {
    files = readdirSync(planDir).filter((f) => f.endsWith('.md'));
  } catch (e) {
    return { findings: [`cannot read plans dir ${planDir}: ${e.message}`], referenced, mentionedInTasks };
  }
  let planText = '';
  try {
    planText = files.map((f) => readFileSync(join(planDir, f), 'utf8')).join('\n');
  } catch (e) {
    return { findings: [`cannot read a plan file under ${planDir}: ${e.message}`], referenced, mentionedInTasks };
  }

  // A task with no id has no coverage status to report: the finding would
  // name it 'undefined'.
  const taskIds = new Set(tasks.filter(isTaskMapping).map((t) => t.id).filter((id) => id !== undefined && id !== null && String(id).trim() !== ''));
  // Task ids referenced in plans: bare tokens that match an existing-or-not id pattern.
  for (const t of taskIds) {
    const re = new RegExp(`\\b${escapeRe(t)}\\b`);
    if (re.test(planText)) referenced.add(t);
  }
  // A malformed entry is the VALIDATOR's finding; the coverage pass reports
  // coverage, so it skips what it cannot read instead of crashing on it.
  const readable = tasks.filter(isTaskMapping);
  for (const t of readable) {
    if (!referenced.has(t.id)) findings.push(`task '${t.id}' is not mentioned in any plan file under ${planDir}`);
  }
  // A task may also be "covered" by ANOTHER task naming it — the dependency
  // graph documents it.
  for (const t of readable) {
    for (const other of readable) {
      if (other.id === t.id) continue;
      if (mentions(other, t.id)) mentionedInTasks.add(t.id);
    }
  }
  // Inverse: plan mentions ids like TASK-xx not present in tasks.yaml.
  //
  // THE PREFIX RULE. A bare `UPPER-123` token is NOT automatically a task
  // id. `SHA-256`, `HTTP-404`, `UTF-8`, `ISO-8601`, `RFC-2119` and
  // `CVE-2021-44228` are technical constants that look exactly like one —
  // and the gate used to fail a plan because it mentioned a hash algorithm.
  //
  // A token is a task reference when its prefix is a prefix this plan's own
  // task ids use (tasks `TASK-01..09` -> `TASK-10` is dangling), when it is a
  // generic task prefix (`TASK-`, `T-`, `STEP-`, …), or when it appears in an
  // explicit task context ("task TASK-10", "depends_on: [TASK-10]").
  // Requirement ids (`FR-<MODULE>-nn`) and technical constants are never
  // task references, whatever the context.
  const knownPrefixes = new Set();
  for (const id of taskIds) {
    const m = /^([A-Za-z][A-Za-z0-9]*)-[0-9]+$/.exec(String(id ?? ''));
    if (m) knownPrefixes.add(m[1].toUpperCase());
  }
  const contextual = new Set();
  for (const m of planText.matchAll(
    /(?:task|Task|TASK|depends_on|acceptance|wave|verifier|reviewer|owner)\s*[:=]?\s*\[?\s*([A-Z][A-Z0-9]+-[0-9]+)\b/g,
  )) {
    contextual.add(m[1]);
  }
  for (const m of planText.matchAll(/\b[A-Z][A-Z0-9]+-[0-9]+\b/g)) {
    if (taskIds.has(m[0])) continue;
    const prefix = m[0].split('-')[0].toUpperCase();
    if (REQUIREMENT_PREFIXES.has(prefix)) continue;
    if (TECHNICAL_PREFIXES.has(prefix)) continue;
    if (!knownPrefixes.has(prefix) && !TASK_PREFIXES.has(prefix) && !contextual.has(m[0])) continue;
    findings.push(`plan references unknown task id '${m[0]}' (not in tasks.yaml)`);
  }
  return { findings, referenced, mentionedInTasks };
}

/** Prefixes that mark a REQUIREMENT id, never a task id. */
const REQUIREMENT_PREFIXES = new Set(['FR', 'REQ', 'NFR']);

/** Prefixes that mark a TECHNICAL constant, never a task id. */
const TECHNICAL_PREFIXES = new Set([
  'SHA', 'MD5', 'HMAC', 'AES', 'RSA', 'ECDSA', 'CRC', 'UUID', 'ULID',
  'HTTP', 'HTTPS', 'TLS', 'SSL', 'DNS', 'TCP', 'UDP', 'IP', 'WS', 'WSS', 'GRPC',
  'UTF', 'ASCII', 'ISO', 'RFC', 'IETF', 'W3C', 'ECMA', 'IEEE', 'ANSI', 'POSIX',
  'GNU', 'MIT', 'BSD', 'GPL', 'AGPL', 'LGPL', 'MPL', 'APACHE',
  'JSON', 'XML', 'YAML', 'HTML', 'CSS', 'SQL', 'CSV', 'MIME',
  'CPU', 'GPU', 'TPU', 'RAM', 'SSD', 'HDD', 'OS', 'VM', 'K8S',
  'GPT', 'LLM', 'ONNX', 'PDF', 'PNG', 'JPEG', 'GIF', 'SVG', 'WEBP', 'ZIP',
]);

/** Prefixes that are generic TASK references even when this plan uses none. */
const TASK_PREFIXES = new Set([
  'TASK', 'T', 'STEP', 'ISSUE', 'BUG', 'CHORE', 'EPIC', 'WORK', 'JOB', 'ITEM',
  'PATCH', 'SPIKE', 'TODO', 'FIX',
]);

/** Does any task reference `id` in its artifacts / acceptance text? */
function mentions(task, id) {
  const hay = JSON.stringify([task?.artifacts ?? [], task?.acceptance ?? [], task?.title ?? '']);
  return hay.includes(id);
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
