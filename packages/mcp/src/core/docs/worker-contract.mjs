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
//
// WHY THE FIRST GENERATION MUST BE COMPLETE: a worker that comes back with
// "I could not find the design skill" or "the acceptance criteria did not say
// which components to use" costs a whole second dispatch — the prompt, the
// agent, its exploration and its output, all again. So the contract carries
// everything the worker needs to produce a correct first answer: the rules of
// the capability skill (embedded, so it need not open the file — but it MAY
// open it, and it is told where it is), the exact sections to read, and an
// explicit statement of what it must NOT do.
//
// NOTE ON SIZE: there is deliberately NO token count in the prompt or the
// returned payload. A number the model can see becomes a number it tries to
// shrink — and an agent optimizing for a byte count produces a smaller,
// weaker contract and then needs another round to fix what it dropped. The
// cost of a dispatch is measured where it belongs (the server, the CI gate,
// the report to the user), and paid for by making the first answer complete.
import { dirname, join } from 'node:path';
import { buildGraph, GraphError, ownedPaths } from '../plan/graph.mjs';
import { readParsedPlanFile } from '../plan/plan-file.mjs';
import { toolCall } from '../protocol/call.mjs';
import { skillDirective } from '../skill/skill-manager.mjs';
import { parseEdgeMatrix, readPlans } from '../fs/artifact-space.mjs';
import { invalidInput } from '../protocol/errors.mjs';
import { noSuchTask, hint } from '../protocol/guidance.mjs';

/**
 * The read-only archgen actions.
 *
 * The complete list, because a partial one reads as "these are the only ones
 * you may use" — and a worker that reads that as a ban stops asking the
 * tools it was given.
 */
const READONLY_ACTIONS = "archgen_plan{validate,verify,graph,impact,coverage,profile,scaffold,brief}, archgen_docs, archgen_refs, archgen_help, archgen_tasks{next,list,contract}, archgen_codegraph{status}, archgen_setup{doctor,harnesses,harness_info}, archgen_skills{match,installed,load,digest,list}, archgen_registry{show}";

/**
 * Assemble the worker prompt for one task.
 *
 * @param {{
 *   tasksYaml: string,
 *   taskId: string,
 *   slugDir?: string|null,
 *   projectRoot?: string|null,
 *   codeStandardsPath?: string|null,
 *   capabilities?: Array<{slug: string, path: string|null, purpose?: string, domain?: string, installed?: boolean, rules?: string, sections?: Array<{slug: string, title: string, normative?: boolean}>}>,
 *   docSections?: Array<{file: string, section: string, title: string, matches?: Array<{line: number, text: string}>}>,
 *   codegraph?: boolean,
 * }} opts
 */
/**
 * The edge-case rows THIS task's acceptances claim.
 *
 * The acceptance says "(covers E4)" — that is the link, and the plan's matrix
 * holds the case. The worker gets the CASE, not just the link: a worker told
 * "E4" and nothing else has to go hunting for what E4 means.
 *
 * @param {{acceptance: string[], taskId: string, slugDir: string|null, tasksYaml: string}} input
 * @returns {Array<{row: string, case: string}>}
 */
function claimedCases({ acceptance, taskId, slugDir, tasksYaml }) {
  const claimed = new Set();
  for (const a of acceptance ?? []) {
    for (const m of String(a).matchAll(/\bcovers\s+([A-Z][A-Z0-9-]*(?:\s*,\s*[A-Z][A-Z0-9-]*)*)/gi)) {
      for (const raw of m[1].split(',')) claimed.add(raw.trim().toUpperCase());
    }
  }
  if (!claimed.size) return [];
  const planDir = slugDir ? join(slugDir, 'plans') : join(dirname(tasksYaml), 'plans');
  let rows = [];
  try {
    rows = parseEdgeMatrix(readPlans(planDir));
  } catch {
    return []; // a missing plan is the orchestrator's problem, not the worker's
  }
  return rows
    .filter((r) => String(r.task) === String(taskId) && claimed.has(String(r.row).trim().toUpperCase()))
    .map((r) => ({ row: String(r.row).trim().toUpperCase(), case: r.case }));
}

export function buildWorkerContract(opts) {
  const { tasksYaml, taskId, slugDir = null } = opts;
  if (!taskId) {
    throw invalidInput(
      'taskId is required to build a worker contract',
      { ...hint({ action: toolCall('archgen_tasks', { action: 'list', tasksYaml: '<tasks.yaml>' }), reason: 'the list carries every task id.' }) },
    );
  }

  const { data } = readParsedPlanFile(tasksYaml);
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const task = tasks.find((t) => t?.id === taskId);
  if (!task) throw noSuchTask(taskId, tasks.map((t) => t?.id).filter(Boolean));

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
      throw invalidInput(`${tasksYaml}: ${e.message}`, {
        ...hint({ action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }), reason: 'validate reports what the task file is missing.' }),
        file: tasksYaml,
      });
    }
    throw e;
  }
  const upstream = (prerequisites.get(taskId) ?? []).map((id) => ({ id, title: byId.get(id)?.title ?? null }));
  const downstream = (dependents.get(taskId) ?? []).map((id) => ({ id, title: byId.get(id)?.title ?? null }));

  const acceptance = Array.isArray(task.acceptance) ? task.acceptance : [];
  const ownership = ownedPaths(task);
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];

  // ── the edge cases THIS task must cover ──────────────────────────────────
  //
  // The acceptance says "(covers E4)" — that is the link. The worker gets the
  // CASE, not just the link: a worker told "E4" and nothing else has to go
  // hunting for what E4 means, and a worker told the case cannot guess.
  const cases = claimedCases({ acceptance, taskId, slugDir, tasksYaml });

  const capabilities = Array.isArray(opts.capabilities) ? opts.capabilities : [];

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
  if (cases.length) {
    lines.push('**Cases you must cover (from the plan\'s edge-case matrix — each one is a test you owe):**');
    for (const c of cases) lines.push(`- ${c.row}: ${c.case}`);
    lines.push('');
  }
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

  // ── the capability skills ────────────────────────────────────────────────
  //
  // EVERY matched required skill is here, not just the first one. The old
  // contract injected `required[0]` — so a task matching the baseline AND
  // the accessibility skill silently lost the second one, even though it had
  // been installed on purpose. A skill that is installed but never named is
  // a skill that is never applied.
  if (capabilities.length) {
    lines.push('## Capability skills (REQUIRED — apply these rules)');
    lines.push('');
    for (const cap of capabilities) {
      lines.push(`### ${cap.domain ?? 'Capability'} — ${cap.slug}`);
      lines.push('');
      lines.push(skillDirective(cap));
      lines.push('');
      if (!cap.installed) {
        lines.push(
          `**NOT INSTALLED — the worker cannot comply until it is.** The orchestrator must install it with ` +
            `archgen_skills { action: 'install', skillId: '${cap.slug}', approve: true } and re-dispatch.`,
        );
        lines.push('');
        continue;
      }
      if (cap.rules) {
        lines.push('These rules are binding for this task:');
        lines.push('');
        for (const rule of cap.rules.split('\n')) lines.push(`- ${rule}`);
        lines.push('');
      }
      if (cap.sections?.length) {
        lines.push(`The skill's full text is at ${cap.path}. Its sections (pull ONE if you need more):`);
        lines.push('');
        for (const s of cap.sections) {
          lines.push(`- ${s.slug}${s.normative ? ' (normative)' : ''} — ${s.title}`);
        }
        lines.push('');
      }
    }
  }

  if (opts.docSections && opts.docSections.length) {
    lines.push('## Your context — start with these sections');
    lines.push('');
    lines.push('These sections contain your contract — read them first. The whole plan is not required:');
    for (const s of opts.docSections) {
      lines.push(`- ${s.file} § ${s.section}${s.title ? ` — ${s.title}` : ''}`);
    }
    lines.push('');
  }

  // ── CodeGraph ────────────────────────────────────────────────────────────
  //
  // Server-detected, not left for the worker to work out. The orchestrator's
  // prose mentioned CodeGraph, but the PROMPT never did — so the instruction
  // never reached the agent that needed it.
  if (opts.codegraph) {
    lines.push('## CodeGraph — use it for understanding');
    lines.push('');
    lines.push(
      'This project has a CodeGraph index. Use the CodeGraph MCP tools for anything that needs ' +
        'understanding — dependencies, callers, blast radius. It returns the real source and the call ' +
        'paths between symbols, which is faster and more accurate than grep.',
    );
    lines.push('');
    lines.push('- Never re-index it — the watcher keeps it live.');
    lines.push('- Never grep for what the index can answer.');
    lines.push('');
  }

  // ── what the worker must NOT do ──────────────────────────────────────────
  //
  // The contract is the worker's CONTEXT, not a cage. It used to forbid
  // reading the archgen skill and its references outright, and to forbid the
  // tool suite outright. Both were absolute, and both were wrong:
  //
  //   - the contract is a SNAPSHOT. The plan, the code and the sibling
  //     wave's output can change under the worker, and a contract that
  //     cannot answer a question left the worker to guess or to stall —
  //     the two things a worker must never do;
  //   - a worker that needs the capability skill's rules, the plan's own
  //     section, or the host's conventions can now READ them, and the
  //     cheapest source is named rather than forbidden.
  //
  // What stays bounded is the WORK: the orchestrator's protocol is not the
  // worker's to run. The worker does not open gates, does not dispatch
  // agents, does not rewrite the plan, and does not touch another task's
  // status. The single write it owns is the set_status it is told to make.
  lines.push('## Rules for you');
  lines.push('');
  lines.push(
    '- This contract is your context: it carries your acceptance criteria, your files, your dependencies and ' +
      'the rules you must follow. Read it first.',
  );
  lines.push(
    '- You MAY read anything else you need to do the job correctly: the archgen skill and its references, the ' +
      'capability skill named above, the plan, tasks.yaml, or the host repository. When something here does ' +
      'not answer your question, go and read it — do not guess, and do not come back asking.',
  );
  lines.push(
    '- Read the cheapest source that answers it: this contract, then the named section, then the file, then the ' +
      'tool. Do not read whole documents when a section is named.',
  );
  lines.push(
    '- The read-only archgen actions are yours for facts: ' + READONLY_ACTIONS + '. The ONLY archgen write you make is ' +
      'the set_status in "When you finish". Do not open the gates, do not dispatch anyone, and do not change ' +
      'another task\'s status.',
  );
  lines.push('- Edit NOTHING outside your owned files.');
  lines.push('- Do NOT talk to other workers — coordination happens through tasks.yaml.');
  lines.push(
    '- Finish in ONE pass: everything you need is in this contract or one read away. Do not come back asking for ' +
      'context.',
  );
  lines.push('');

  lines.push('## Paths and working state');
  lines.push('');
  lines.push('- Every path above is repo-root-relative and VERBATIM from tasks.yaml — never reconstruct a path from memory.');
  // The slug dir is known — it is the directory the tasks file lives in — so
  // the working-state path is a real path, never a literal "<slug>".
  const workingRoot = slugDir ?? dirname(tasksYaml);
  lines.push(`- Your working state goes under \`${join(workingRoot, '.agent')}/\`: notes to \`.agent/notes/${taskId}.md\`, decisions to \`.agent/decisions/\`.`);
  lines.push('- NEVER create ad-hoc note/context/decision folders at the repo root or anywhere outside `.archgen/`.');
  lines.push('');

  lines.push('## When you finish');
  lines.push('');
  // The completion call is COMPLETE. It used to name the task and the status
  // only — the tool requires the task file as well, so a worker that obeyed
  // the contract exactly was refused on the LAST step of every task
  // ("tasksYaml is required for set_status"). The path is the one the contract
  // was built from, and `toolCall` escapes it, so the call is paste-ready.
  lines.push(
    `1. Call \`${toolCall('archgen_tasks', { action: 'set_status', tasksYaml, taskId: task.id, status: 'done' })}\` — ` +
      `or \`${toolCall('archgen_tasks', { action: 'set_status', tasksYaml, taskId: task.id, status: 'failed' })}\` ` +
      'if you could not complete it. Do this IN THE SAME TURN you finish, before anything else.',
  );
  if (capabilities.length && capabilities[0].installed) {
    lines.push(
      `2. State whether you followed the capability skill, one auditable line: ` +
        `\`Skill compliance: followed ${capabilities[0].slug} (${capabilities[0].path})\` — or, if you did not, ` +
        `write \`Skill compliance: NOT followed —\` and then the reason in your own words.`,
    );
  } else {
    // The line is always there, so the audit is uniform — but it never
    // contains a placeholder the worker has to fill with a name it was not
    // given.
    lines.push(
      '2. State one auditable line: `Skill compliance: N/A — no capability skill was required for this task` ' +
        '(or, if one was required and you did not follow it, `Skill compliance: NOT followed —` and the reason).',
    );
  }
  lines.push('3. Commit your work scoped to the owned files.');
  lines.push('');

  const warnings = [
    ...(acceptance.length === 0 ? ['task has NO acceptance criteria — the verifier rejects it'] : []),
    ...(ownership.length === 0 ? ['task has NO file_ownership — a worker could edit anything'] : []),
    ...(capabilities.filter((c) => !c.installed).map((c) => `capability skill '${c.slug}' is REQUIRED but NOT installed — install it with archgen_skills{action:'install'} before dispatch`)),
  ];

  return {
    taskId: task.id,
    title: task.title ?? null,
    prompt: lines.join('\n'),
    acceptance,
    fileOwnership: ownership,
    artifacts,
    upstream,
    downstream,
    dispatchable: acceptance.length > 0 && ownership.length > 0 && capabilities.every((c) => c.installed !== false),
    // The ledger key for the dispatch table: one task = one worker session, so
    // a follow-up on the same files continues that session instead of
    // starting a fresh agent that has to re-read everything.
    dispatchKey: `${slugDir ? slugDir.split('/').pop() : '<slug>'}/${task.id}`,
    capabilities: capabilities.map((c) => ({
      slug: c.slug,
      path: c.path,
      domain: c.domain ?? null,
      installed: c.installed !== false,
      ruleCount: c.rules ? c.rules.split('\n').filter(Boolean).length : 0,
    })),
    warnings,
  };
}
