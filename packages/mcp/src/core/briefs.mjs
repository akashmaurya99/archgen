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

  if (ctx.audit) {
    out.push(...renderAudit(ctx.audit));
  }

  return out.join('\n');
}

/** How many rows of a map the brief carries before it truncates. */
const MAP_ROW_CAP = 60;

/**
 * Render the mechanical floor and the maps a gate agent reads instead of
 * re-deriving them.
 *
 * The maps exist because the agent used to spend a whole round proving that a
 * matrix row points at an acceptance that exists, that every requirement is
 * cited, and that each task owns what it claims. Those are facts; the facts
 * are rendered here, so the agent spends its pass on judgment.
 */
function renderAudit(audit) {
  const out = [];
  const maps = audit.maps ?? {};
  const issues = audit.issues ?? [];
  const warnings = audit.warnings ?? [];

  out.push('### Mechanical floor — computed for you (do NOT re-derive)');
  out.push('');
  out.push(`- blocking issues: ${issues.length}`);
  out.push(`- warnings: ${warnings.length}`);
  if (issues.length) {
    out.push('');
    out.push('BLOCKING (each one is a defect; report it once, with the fix):');
    for (const i of issues) out.push(`- ${i}`);
  }
  if (warnings.length) {
    out.push('');
    out.push('WARNINGS (informational; they do NOT block approval):');
    for (const w of warnings.slice(0, MAP_ROW_CAP)) out.push(`- ${w}`);
    if (warnings.length > MAP_ROW_CAP) out.push(`- … ${warnings.length - MAP_ROW_CAP} more`);
  }
  out.push('');

  const reqs = maps.requirements ?? [];
  if (reqs.length) {
    out.push('#### Requirement map — every PRD requirement and the acceptance that cites it');
    out.push('');
    out.push('| requirement | cited by |');
    out.push('|---|---|');
    for (const r of reqs.slice(0, MAP_ROW_CAP)) {
      out.push(`| ${r.id} | ${r.covered ? r.citedBy.join(', ') : 'NOT CITED — no acceptance claims it'} |`);
    }
    if (reqs.length > MAP_ROW_CAP) out.push(`| … ${reqs.length - MAP_ROW_CAP} more | |`);
    out.push('');
  }

  const rows = maps.edgeMatrix ?? [];
  if (rows.length) {
    out.push('#### Edge-case matrix map — each row and the acceptance text it cites');
    out.push('');
    out.push('| row | case | cited | the acceptance it points at |');
    out.push('|---|---|---|---|');
    for (const r of rows.slice(0, MAP_ROW_CAP)) {
      const text = r.acceptance ? r.acceptance.slice(0, 160) : 'NO SUCH ACCEPTANCE';
      out.push(`| ${r.row} | ${String(r.case).slice(0, 80)} | ${r.task}#${r.index} | ${text} |`);
    }
    if (rows.length > MAP_ROW_CAP) out.push(`| … ${rows.length - MAP_ROW_CAP} more | | | |`);
    out.push('');
    out.push('Judge each row: does the cited acceptance actually verify the stated case?');
    out.push('');
  }

  const own = maps.ownership ?? [];
  if (own.length) {
    out.push('#### Ownership map — task → the paths it owns (and its wave)');
    out.push('');
    out.push('| task | wave | paths |');
    out.push('|---|---|---|');
    for (const o of own.slice(0, MAP_ROW_CAP)) {
      out.push(`| ${o.id} | ${o.wave ?? '?'} | ${o.globs.join(', ')} |`);
    }
    if (own.length > MAP_ROW_CAP) out.push(`| … ${own.length - MAP_ROW_CAP} more | | |`);
    out.push('');
  }

  const mods = maps.modules ?? [];
  if (mods.length) {
    out.push('#### Module DAG — module → depends_on_modules → the tasks that own it');
    out.push('');
    out.push('| module | depends_on_modules | owning tasks |');
    out.push('|---|---|---|');
    for (const m of mods.slice(0, MAP_ROW_CAP)) {
      out.push(`| ${m.name} | ${m.dependsOn.join(', ') || '—'} | ${m.ownedBy.join(', ') || 'NONE'} |`);
    }
    if (mods.length > MAP_ROW_CAP) out.push(`| … ${mods.length - MAP_ROW_CAP} more | | |`);
    out.push('');
  }

  return out;
}
