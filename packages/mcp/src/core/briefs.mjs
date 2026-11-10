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
 * The TOTAL number of map lines a brief may carry.
 *
 * A 30-task plan with 60 edge rows rendered every map in full: 6,034 tokens,
 * a fifth of a 32k window in one message. The maps exist to PAIR a row with
 * its acceptance — not to reproduce the plan.
 *
 * THE BUDGET IS A CEILING, NOT A QUOTA, and it is allocated by USE, never by
 * a fixed per-map cap:
 *
 *   - a SMALL plan (few rows) is NEVER truncated — the ceiling only binds
 *     when there are more rows than a brief can carry, which is exactly when
 *     the agent should read sections instead of having everything inline;
 *   - the budget is shared and flows: the matrix gets half (it carries the
 *     link the floor just proved), requirements a third, ownership and the
 *     module DAG the rest — and a map with fewer rows than its share hands
 *     the surplus to the next one;
 *   - nothing is dropped SILENTLY: the brief says how many rows it omitted
 *     and where they live, and the verifier is told to read that section and
 *     check every row there.
 */
const MAP_LINE_BUDGET = 90;
/** The share of the budget each map may take, in priority order. */
const MAP_SHARES = { edgeMatrix: 0.5, requirements: 0.3, ownership: 0.2, modules: 0.2 };

/**
 * Render the mechanical floor and the maps a gate agent reads instead of
 * re-deriving them.
 *
 * The maps exist because the agent used to spend a whole round proving that a
 * matrix row points at an acceptance that exists, that every requirement is
 * cited, and that each task owns what it claims. Those are facts; the facts
 * are rendered here, so the agent spends its pass on judgment.
 *
 * COMPACT BY DESIGN. A 30-task plan with 60 edge rows rendered as markdown
 * tables measured 6,034 tokens — a fifth of a 32k window in one message. One
 * line per row, with the row caps, keeps the brief to the facts the agent
 * needs and nothing else.
 */
function renderAudit(audit) {
  const out = [];
  const maps = audit.maps ?? {};
  const issues = audit.issues ?? [];
  const warnings = audit.warnings ?? [];

  out.push('### Mechanical floor — computed for you (do NOT re-derive)');
  out.push('');
  out.push(`- blocking issues: ${issues.length}${summarizeCodes(issues)}`);
  out.push(`- warnings: ${warnings.length}${summarizeCodes(warnings)}`);
  if (issues.length) {
    out.push('');
    out.push('BLOCKING (report each once, with the fix):');
    for (const i of issues) out.push(`- ${i}`);
  }
  if (warnings.length) {
    out.push('');
    out.push('WARNINGS (informational; they do NOT block approval):');
    for (const w of warnings.slice(0, MAP_ROW_CAP)) out.push(`- ${w}`);
    if (warnings.length > MAP_ROW_CAP) out.push(`- … ${warnings.length - MAP_ROW_CAP} more`);
  }
  out.push('');

  const snapshot = audit.snapshot;
  if (snapshot) {
    out.push('### PLAN SNAPSHOT — compare it against what you read');
    out.push('');
    out.push(
      `- tasks: ${snapshot.tasks} · requirements: ${snapshot.requirements} · edge rows: ${snapshot.edgeRows} ` +
        `(linked: ${snapshot.linkedRows}) · fingerprint: ${snapshot.fingerprint}`,
    );
    out.push(
      'If the files you read disagree with these numbers, the plan CHANGED after this brief was rendered: ' +
        'report that as a finding and stop judging stale content.',
    );
    out.push('');
  }

  const reqs = maps.requirements ?? [];
  const rows = maps.edgeMatrix ?? [];
  const own = maps.ownership ?? [];
  const mods = maps.modules ?? [];

  // The map blocks, in PRIORITY order: the matrix carries the link the floor
  // just proved, so it gets the budget first.
  const blocks = [];
  if (rows.length) {
    blocks.push({
      key: 'edgeMatrix',
      title: '#### Edge-case matrix map — row | cited | the acceptance | claims',
      where: "the plan's edge-case matrix section (it holds each row's expected behaviour)",
      lines: rows.map((r) => {
        const text = r.acceptance ? String(r.acceptance).slice(0, 90) : 'NO SUCH ACCEPTANCE';
        const claimed = (r.claims ?? []).length ? r.claims.join(', ') : '—';
        return `${r.row} | ${r.task}#${r.index} | ${text} | ${claimed}`;
      }),
      footer:
        'The claim link is already checked. Judge the rest: does the cited acceptance verify the stated case? ' +
        "The case text lives in the plan's matrix section — read it for any row you doubt.",
    });
  }
  if (reqs.length) {
    blocks.push({
      key: 'requirements',
      title: '#### Requirement map — id | what it asks for | cited by | the acceptance',
      where: 'docs/prd.md',
      lines: reqs.map((r) => {
        const acc = r.acceptanceText ? String(r.acceptanceText).slice(0, 90) : 'NOT CITED';
        return `${r.id} | ${String(r.text ?? '').slice(0, 70)} | ${r.covered ? r.citedBy.join(', ') : '—'} | ${acc}`;
      }),
      footer: 'Compare the two texts: does the acceptance verify the requirement it claims?',
    });
  }
  if (own.length) {
    blocks.push({
      key: 'ownership',
      title: '#### Ownership map — task | wave | paths',
      where: 'tasks.yaml',
      lines: own.map((o) => `${o.id} | ${o.wave ?? '?'} | ${o.globs.join(', ')}`),
      footer: '',
    });
  }
  if (mods.length) {
    blocks.push({
      key: 'modules',
      title: '#### Module DAG — module | depends_on_modules | owning tasks',
      where: 'architecture.yaml',
      lines: mods.map((m) => `${m.name} | ${m.dependsOn.join(', ') || '—'} | ${m.ownedBy.join(', ') || 'NONE'}`),
      footer: '',
    });
  }

  // Allocate the shared budget by share, and let a map with fewer rows than
  // its share hand the surplus to the next one. Nothing is dropped silently,
  // and the total never exceeds the ceiling.
  let remaining = MAP_LINE_BUDGET;
  let carry = 0;
  const rendered = [];
  let omitted = 0;
  for (const block of blocks) {
    const share = Math.max(1, Math.floor(MAP_LINE_BUDGET * (MAP_SHARES[block.key] ?? 0.2)));
    const allowance = share + carry;
    const take = Math.min(block.lines.length, allowance, remaining);
    carry = allowance - take; // the unused share flows to the next map
    remaining -= take;
    const left = block.lines.length - take;
    omitted += left;
    rendered.push({ ...block, shown: block.lines.slice(0, take), omitted: left });
  }

  for (const block of rendered) {
    if (!block.lines.length) continue;
    out.push(block.title);
    for (const line of block.shown) out.push(line);
    if (block.omitted > 0) {
      out.push(`… ${block.omitted} more row(s) in ${block.where} — read that section and check every row there`);
    }
    if (block.footer) {
      out.push('');
      out.push(block.footer);
    }
    out.push('');
  }
  if (omitted > 0) {
    out.push(
      `The floor already checked EVERY row it did not show you (the links, the citations, the claims). ` +
        `Your judgement covers the rows above plus every row in the sections named above.`,
    );
    out.push('');
  }

  const waivers = audit.waivers ?? [];
  if (waivers.length) {
    out.push('#### Waived findings — approved deviations, not defects to fix');
    for (const w of waivers) {
      out.push(
        `${w.id || 'waiver'} | ${w.scope.join(', ') || 'unscoped'} | ${w.finding}` +
          `${w.reason ? ` | reason: ${w.reason}` : ''}` +
          `${w.approvedBy ? ` | approved by ${w.approvedBy}${w.approvedAt ? ` on ${w.approvedAt}` : ''}` : ''}`,
      );
    }
    out.push('');
    out.push('A waived finding is NOT a defect: do not re-raise it unless it regressed.');
    out.push('');
  }

  return out;
}

/** " (3 codes: A x1, B x2)" — the counts the orchestrator groups fixes by. */
function summarizeCodes(list) {
  if (!list.length) return '';
  const counts = new Map();
  for (const m of list) {
    const code = String(m).split(':')[0];
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([code, n]) => `${code} x${n}`);
  return ` (${parts.join(', ')})`;
}
