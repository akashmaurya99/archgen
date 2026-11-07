// briefs.mjs — the dispatch brief templates, served as tool output.
//
// The verifier / review / survey / investigate briefs lived as prose blocks in
// references/orchestration.md and were copy-pasted into every sub-agent
// dispatch. A brief IS a template — a machine-shaped output — so the tool owns
// it and the reference keeps only the policy around it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invalidInput, notFound } from './errors.mjs';

export const BRIEF_KINDS = ['verifier', 'review', 'survey', 'investigate'];

/**
 * Load one dispatch brief.
 *
 * @param {string} briefsDir the directory holding the brief templates
 * @param {string} kind one of BRIEF_KINDS
 * @param {Record<string, string>} vars placeholder values substituted into the template
 */
export function loadBrief(briefsDir, kind, vars = {}) {
  const key = String(kind ?? '').toLowerCase();
  if (!BRIEF_KINDS.includes(key)) {
    throw invalidInput(`unknown brief '${kind}' (allowed: ${BRIEF_KINDS.join('|')})`, { kind });
  }
  const path = join(briefsDir, `${key}.md`);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw notFound(`brief template '${key}.md' is missing`, { kind, path });
  }
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined || value === null || value === '') continue;
    text = text.split(`<${name}>`).join(String(value));
  }
  return { kind: key, brief: text };
}

/**
 * The placeholder names a brief still contains.
 *
 * A dispatched brief must not carry a placeholder: a worker told to read
 * `<slug dir>` looks for a directory with that literal name.
 *
 * The matcher is CASE-INSENSITIVE on the first letter. It used to require a
 * lowercase first character, so `<Domain>` — the literal placeholder that
 * shipped in every worker prompt — was invisible to it.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function remainingPlaceholders(text) {
  return [...new Set([...String(text ?? '').matchAll(/<([A-Za-z][A-Za-z. ]*)>/g)].map((m) => m[1]))];
}

/**
 * Every brief, for a caller that wants them all.
 * @param {string} briefsDir
 */
export function loadAllBriefs(briefsDir) {
  const out = {};
  for (const kind of BRIEF_KINDS) out[kind] = loadBrief(briefsDir, kind).brief;
  return out;
}

/**
 * The context block every dispatch brief carries — the EVIDENCE map, the
 * pre-rendered tool results, and the rules that keep the sub-agent from
 * re-deriving what the brief already says.
 *
 * WHY THIS IS RENDERED BY THE TOOL AND NOT WRITTEN INTO EACH TEMPLATE:
 *
 *   1. EVIDENCE. The verifier used to be told to "read plans + tasks.yaml" —
 *      whole files, every round. The brief now carries the FILE LIST and the
 *      SECTION ANCHORS, so the agent reads the sections that matter instead
 *      of re-reading the plan. A map, not a copy: the agent decides what to
 *      open, and the map is what lets it decide.
 *
 *   2. PRE-RENDERED RESULTS. The review brief used to say "attach the
 *      mermaid graph and the docs-validate result" — which cost the
 *      orchestrator two extra tool calls per round, one of which (the graph)
 *      failed on every plan. The tool renders them once, into the brief.
 *
 *   3. THE FORBIDDEN LIST. Without it, a sub-agent reads the archgen skill
 *      and its references (the orchestrator's protocol, not its) and runs the
 *      archgen tool suite to re-derive what it was just handed. That is a
 *      second and third reading of the same facts — pure cost, and a chance
 *      to drift from the protocol the orchestrator is following.
 *
 * @param {{
 *   scope?: {slug?: string, slugDir?: string, plansDir?: string, tasksYaml?: string}|null,
 *   evidence?: {files: Array<{path: string, sections: Array<{slug: string, title: string}>}>, fileCount: number}|null,
 *   graph?: string|null,
 *   docsValidation?: {valid: boolean, broken: unknown[], warnings: unknown[]}|null,
 *   allowedCalls?: string[],
 * }} ctx
 * @returns {string}
 */
export function renderBriefContext(ctx = {}) {
  const out = [];

  out.push('## CONTEXT — read this first');
  out.push('');
  out.push(
    'Everything you need is in this brief. Do NOT read the archgen skill, its references, or any ' +
      'protocol document — they are the ORCHESTRATOR\'s, and reading them re-derives context you were ' +
      'already given.',
  );
  const allowed = ctx.allowedCalls ?? [];
  out.push(
    allowed.length
      ? `Do NOT run the archgen tool suite beyond these calls: ${allowed.join(', ')}.`
      : 'Do NOT run the archgen tool suite at all.',
  );
  out.push(
    'Read ONLY the files in EVIDENCE, and only the sections named. Do not read whole documents when a ' +
      'section is named.',
  );
  out.push('');

  if (ctx.scope) {
    out.push('## EVIDENCE — the plan under review');
    out.push('');
    if (ctx.scope.tasksYaml) out.push(`- tasks: ${ctx.scope.tasksYaml}`);
    if (ctx.scope.plansDir) out.push(`- plans: ${ctx.scope.plansDir}`);
    if (ctx.scope.slugDir) out.push(`- artifacts: ${ctx.scope.slugDir}`);
    out.push('');
  }

  if (ctx.evidence?.files?.length) {
    out.push('### Section index — pull the section, never the file');
    out.push('');
    for (const f of ctx.evidence.files) {
      out.push(`- ${f.path}`);
      for (const s of f.sections) out.push(`  - § ${s.slug} — ${s.title}`);
    }
    out.push('');
  }

  if (ctx.graph) {
    out.push('### Dependency graph (rendered for you — do not re-fetch)');
    out.push('');
    out.push('```mermaid');
    out.push(ctx.graph);
    out.push('```');
    out.push('');
  }

  if (ctx.docsValidation) {
    const broken = ctx.docsValidation.broken?.length ?? 0;
    const warned = ctx.docsValidation.warnings?.length ?? 0;
    out.push('### Reference-integrity result (rendered for you — do not re-fetch)');
    out.push('');
    out.push(`- valid: ${ctx.docsValidation.valid === true}`);
    out.push(`- broken references: ${broken}`);
    out.push(`- warnings: ${warned}`);
    if (broken > 0) {
      out.push('');
      out.push('Broken references (each BLOCKS approval):');
      for (const b of ctx.docsValidation.broken) {
        out.push(`- ${b.file ?? ''}${b.line ? `:${b.line}` : ''} — ${b.kind ?? 'broken'}: ${b.ref ?? ''}`);
      }
    }
    out.push('');
  }

  return out.join('\n');
}
