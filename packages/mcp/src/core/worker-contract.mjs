// worker-contract.mjs — assembles the worker prompt.
//
// This is the single most error-prone hand-assembly in the whole system. The
// skill used to spell out EIGHT rules the orchestrator had to assemble into
// every worker prompt by hand — and getting one wrong (a bare filename, a
// missing acceptance bullet, a whole-plan dump instead of two sections) makes
// the worker guess.
//
// This module assembles the contract from the SAME sources the rest of the
// system reads: tasks.yaml (verbatim paths + acceptance), the dependency graph,
// the plan's doc sections, and the capability-skill registry. One assembly,
// no assembly drift.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { buildGraph, GraphError } from './graph.mjs';
import { invalidInput, notFound } from './errors.mjs';

/**
 * Assemble the worker prompt for one task.
 *
 * @param {{
 *   tasksYaml: string,
 *   taskId: string,
 *   slugDir?: string,
 *   codeStandardsPath?: string,
 *   capability?: {slug: string, path: string|null, purpose?: string}|null,
 *   docSections?: Array<{file: string, section: string, title: string, matches?: Array<{line: number, text: string}>}>,
 * }} opts
 */
export function buildWorkerContract(opts) {
  const { tasksYaml, taskId, slugDir = null } = opts;
  if (!taskId) throw invalidInput('taskId is required to build a worker contract', {});

  let raw;
  try {
    raw = readFileSync(tasksYaml, 'utf8');
  } catch {
    throw invalidInput(`cannot read ${tasksYaml} (missing or unreadable)`, { file: tasksYaml });
  }
  let data;
  try {
    ({ data } = parseYaml(raw, { filename: tasksYaml }));
  } catch (e) {
    throw invalidInput(String(e?.message ?? e), { file: tasksYaml });
  }
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const task = tasks.find((t) => t?.id === taskId);
  if (!task) throw notFound(`task '${taskId}' not found in ${tasksYaml}`, { taskId, file: tasksYaml });

  // The dependency neighbourhood — what must exist BEFORE this task, and what
  // waits on it. Derived from depends_on, never hand-labelled.
  //
  // A broken graph (a duplicate id, a dangling depends_on) is a PLAN defect,
  // not an internal error. The agent branches on the code, so it is mapped
  // to the same typed codes the other plan tools use.
  let byId;
  let prerequisites;
  let dependents;
  try {
    ({ byId, prerequisites, dependents } = buildGraph(tasks));
  } catch (e) {
    if (e instanceof GraphError) {
      throw invalidInput(`${tasksYaml}: ${e.message}`, { file: tasksYaml });
    }
    throw e;
  }
  const upstream = (prerequisites.get(taskId) ?? []).map((id) => ({ id, title: byId.get(id)?.title ?? null }));
  const downstream = (dependents.get(taskId) ?? []).map((id) => ({ id, title: byId.get(id)?.title ?? null }));

  const acceptance = Array.isArray(task.acceptance) ? task.acceptance : [];
  const ownership = Array.isArray(task.file_ownership) ? task.file_ownership : [];
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];

  const lines = [];
  lines.push(`# Task ${task.id} — ${task.title ?? ''}`.trim());
  lines.push('');
  lines.push('## Your contract');
  lines.push('');
  lines.push(`**Acceptance criteria (VERBATIM — satisfy every one):**`);
  if (acceptance.length === 0) {
    lines.push('- (none recorded — this task is not dispatchable; the verifier requires at least one)');
  } else {
    acceptance.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  }
  lines.push('');
  lines.push(`**Files you own (edit NOTHING outside these):**`);
  if (ownership.length === 0) {
    lines.push('- (none recorded — this task is not dispatchable)');
  } else {
    for (const g of ownership) lines.push(`- ${g}`);
  }
  lines.push('');
  if (artifacts.length) {
    lines.push('**Artifacts you produce:**');
    for (const a of artifacts) lines.push(`- ${a}`);
    lines.push('');
  }

  lines.push('## Before you write code');
  lines.push('');
  if (upstream.length) {
    lines.push('**Prerequisites (must already be DONE):**');
    for (const u of upstream) lines.push(`- ${u.id}${u.title ? ` — ${u.title}` : ''}`);
  } else {
    lines.push('**Prerequisites:** none — you are a wave-1 task.');
  }
  if (downstream.length) {
    lines.push('');
    lines.push('**What depends on you (do not implement it):**');
    for (const d of downstream) lines.push(`- ${d.id}${d.title ? ` — ${d.title}` : ''}`);
  }
  lines.push('');

  if (opts.codeStandardsPath) {
    lines.push('## Code standards (contractual)');
    lines.push('');
    lines.push(`Follow ${opts.codeStandardsPath} — the verifier rejects violations.`);
    lines.push('');
  }

  if (opts.capability?.path) {
    lines.push('## Capability skill (REQUIRED)');
    lines.push('');
    lines.push(
      `<Domain> work: follow ${opts.capability.path} (installed via FETCH-SKILL) — apply its standards to every relevant decision.`,
    );
    lines.push('');
  }

  if (opts.docSections && opts.docSections.length) {
    lines.push('## Your context — read ONLY these sections');
    lines.push('');
    lines.push('Do NOT read the whole plan. These are the sections that contain your contract:');
    for (const s of opts.docSections) {
      lines.push(`- ${s.file} § ${s.section}${s.title ? ` — ${s.title}` : ''}`);
    }
    lines.push('');
  }

  lines.push('## Paths and working state');
  lines.push('');
  lines.push('- Every path above is repo-root-relative and VERBATIM from tasks.yaml — never reconstruct a path from memory.');
  lines.push(`- Your working state goes under \`${slugDir ? join(slugDir, '.agent') : '.archgen/<slug>/.agent'}/\`: notes to \`.agent/notes/${taskId}.md\`, decisions to \`.agent/decisions/\`.`);
  lines.push('- NEVER create ad-hoc note/context/decision folders at the repo root or anywhere outside `.archgen/`.');
  lines.push('');

  lines.push('## When you finish');
  lines.push('');
  lines.push('1. Call `archgen_tasks { action: \'set_status\', taskId: \'' + task.id + '\', status: \'done\' }` — or `status: \'failed\'` if you could not complete it. Do this IN THE SAME TURN you finish, before anything else.');
  lines.push('2. State whether you followed the capability skill, one auditable line: `Skill compliance: followed <skill> (<path>)` or `Skill compliance: NOT followed — <reason>`.');
  lines.push('3. Commit your work scoped to the owned files.');
  lines.push('');

  return {
    taskId: task.id,
    title: task.title ?? null,
    prompt: lines.join('\n'),
    acceptance,
    fileOwnership: ownership,
    artifacts,
    upstream,
    downstream,
    dispatchable: acceptance.length > 0 && ownership.length > 0,
    warnings: [
      ...(acceptance.length === 0 ? ['task has NO acceptance criteria — the verifier rejects it'] : []),
      ...(ownership.length === 0 ? ['task has NO file_ownership — a worker could edit anything'] : []),
    ],
  };
}
