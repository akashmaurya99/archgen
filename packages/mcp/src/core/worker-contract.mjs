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
// the capability skill (not a pointer to a file it may never open), the exact
// sections to read, and an explicit statement of what it must NOT do.
//
// NOTE ON SIZE: there is deliberately NO token count in the prompt or the
// returned payload. A number the model can see becomes a number it tries to
// shrink — and an agent optimizing for a byte count produces a smaller,
// weaker contract and then needs another round to fix what it dropped. The
// cost of a dispatch is measured where it belongs (the server, the CI gate,
// the report to the user), and paid for by making the first answer complete.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { buildGraph, GraphError } from './graph.mjs';
import { skillDirective } from './skill-manager.mjs';
import { invalidInput, notFound } from './errors.mjs';

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
    lines.push('## Your context — read ONLY these sections');
    lines.push('');
    lines.push('Do NOT read the whole plan. These are the sections that contain your contract:');
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
  // Without this, a worker reads the archgen skill and its references (the
  // orchestrator's protocol, not its), and runs the archgen tool suite to
  // re-derive what this contract already says. That is a second and third
  // reading of the same facts — pure cost, and a chance to drift from the
  // protocol the orchestrator is actually following.
  lines.push('## Rules for you');
  lines.push('');
  lines.push(
    '- Do NOT read the archgen skill, its references, or any protocol document. They belong to the ' +
      'orchestrator. Everything you need is in this contract.',
  );
  lines.push(
    '- Do NOT run the archgen tool suite. The ONLY archgen call you make is the set_status in ' +
      '"When you finish". The orchestrator already ran every deterministic check.',
  );
  lines.push('- Edit NOTHING outside your owned files.');
  lines.push('- Do NOT talk to other workers — coordination happens through tasks.yaml.');
  lines.push('- Finish in ONE pass: the contract above is complete. Do not come back asking for context.');
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
  lines.push(
    "1. Call `archgen_tasks { action: 'set_status', taskId: '" +
      task.id +
      "', status: 'done' }` — or `status: 'failed'` if you could not complete it. Do this IN THE SAME TURN you finish, before anything else.",
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
