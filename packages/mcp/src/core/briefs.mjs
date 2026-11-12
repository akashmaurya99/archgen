// briefs.mjs — the dispatch brief templates, served as tool output.
//
// The verifier / review / survey / investigate briefs lived as prose blocks in
// references/orchestration.md and were copy-pasted into every sub-agent
// dispatch. A brief IS a template — a machine-shaped output — so the tool owns
// it and the reference keeps only the policy around it.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { invalidInput, notFound } from './errors.mjs';
import { hint } from './guidance.mjs';
import { toolCall } from './call.mjs';

export const BRIEF_KINDS = ['verifier', 'review', 'survey', 'investigate'];

/**
 * The include directive: `<!-- include: name.md -->`.
 *
 * WHY IT EXISTS. The two gate briefs each restated the SAME protocol — the
 * three finding classes, the three-part BLOCKING test, the two-round cap.
 * Two copies of a protocol is a protocol that drifts: they had already
 * begun to differ in wording, and the next edit would have made them differ
 * in MEANING.
 *
 * So the shared rules live in ONE file and both briefs include it. The
 * rendered brief is still SELF-CONTAINED — the fragment is pasted in — so
 * the gate agent never has to know that a fragment exists.
 *
 * It is a comment directive rather than a `<placeholder>` on purpose: a
 * placeholder is a value the CALLER supplies, and the fragment is not one.
 */
const INCLUDE_RE = /<!--\s*include:\s*([A-Za-z0-9._-]+\.md)\s*-->/g;

/**
 * Resolve every include directive in a brief template.
 *
 * @param {string} text the template
 * @param {string} briefsDir the directory the fragments live in
 * @returns {string}
 */
function resolveIncludes(text, briefsDir) {
  return text.replace(INCLUDE_RE, (_m, name) => {
    const path = join(briefsDir, name);
    if (!existsSync(path)) {
      throw invalidInput(
        `brief fragment '${name}' is missing`,
        { ...hint({ action: toolCall('archgen_setup', { action: 'doctor' }), reason: "the server package is incomplete — reinstall archgen-mcp." }), fragment: name },
      );
    }
    return readFileSync(path, 'utf8').trim();
  });
}

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
    throw invalidInput(
      `unknown brief '${kind}' (allowed: ${BRIEF_KINDS.join('|')})`,
      { ...hint({ action: toolCall('archgen_help', { topic: 'plan' }), reason: "the brief kinds are listed there." }), kind },
    );
  }
  const path = join(briefsDir, `${key}.md`);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw notFound(`brief template '${key}.md' is missing`, { kind, path });
  }
  // The shared fragments are pasted in BEFORE the placeholder check, so a
  // fragment's own text can never be mistaken for a missing value.
  text = resolveIncludes(text, briefsDir);
  // The placeholders the TEMPLATE carries are checked BEFORE the
  // substitution, and a placeholder counts as missing only when the caller
  // supplied nothing for it. Checking the FILLED brief read the agent's own
  // text as a placeholder: a feature request of "add support for <T>
  // generics" produced "brief 'survey' is missing T", and there was no
  // argument that could clear it.
  const missing = remainingPlaceholders(text).filter((name) => {
    const value = vars[name];
    return value === undefined || value === null || value === '';
  });
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined || value === null || value === '') continue;
    text = text.split(`<${name}>`).join(String(value));
  }
  return { kind: key, brief: text, missing };
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
 *   3. THE BOUND. The brief is the agent's context, not a cage: it may read
 *      the archgen skill, its references, the plan and the repository when a
 *      question the brief does not answer needs an answer. What is bounded is
 *      the WORK — the calls that change something. The brief names them, so
 *      the agent judges instead of re-deriving the facts it was handed, and
 *      it can still look up what it was not handed.
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
    'This brief is your context: read it first, and judge what it carries.',
  );
  out.push(
    'You MAY read anything else you need to judge correctly: the archgen skill and its references, the plan, ' +
      'tasks.yaml, or the host repository. When the brief does not answer a question, go and read it — do not ' +
      'guess, and do not report a blocker you could have resolved by reading.',
  );
  out.push(
    'Read the cheapest source that answers it: this brief, then the named section, then the file, then the tool. ' +
      'Do not read whole documents when a section is named.',
  );
  const allowed = ctx.allowedCalls ?? [];
  out.push(
    'The read-only archgen actions are yours for facts: archgen_plan{validate,verify,graph,impact,coverage,' +
      'profile,scaffold,brief}, archgen_docs, archgen_refs, archgen_help, archgen_tasks{next,list,contract}, ' +
      'archgen_codegraph{status}, archgen_setup{doctor,harnesses,harness_info}, ' +
      'archgen_skills{match,installed,load,digest,list}, archgen_registry{show}.',
  );
  out.push(
    allowed.length
      ? `These are the ONLY archgen calls beyond reading that you may make: ${allowed.join(', ')}.`
      : 'Make no archgen call that changes anything — you judge, you do not repair.',
  );
  out.push('');

  if (ctx.scope) {
    out.push('## EVIDENCE — the plan under review');
    out.push('');
    // The paths are NOT repeated here: each brief names its own scope in its
    // first lines, and the tool's payload carries them as structured data.
    // Listing them a third time cost the reader 300 bytes per brief for no
    // fact.
    out.push('');
  }

  if (ctx.evidence?.files?.length) {
    out.push('### Section index — pull the section, never the file');
    out.push('');
    for (const f of ctx.evidence.files) {
      out.push(`- ${f.path}`);
      for (const s of f.sections) out.push(`  - § ${s.slug} — ${s.title}`);
    }
    if (ctx.evidence.sectionsOmitted) {
      out.push('');
      out.push('Some sections were left out of this index — fetch a file\'s own index with archgen_docs{action:\'digest\',file:...}');
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
  } else if (ctx.graphNote) {
    // The graph is NOT here. Say so, and say where to get it — a brief that
    // claims a graph is "rendered for you" and carries none is worse than
    // one that never promised it.
    out.push('### Dependency graph — NOT rendered');
    out.push('');
    out.push(ctx.graphNote);
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
      out.push(
      "Broken references (reported by `archgen_docs{action:'validate'}`; the deterministic floor does NOT gate " +
        'on them — judge them here):',
    );
      for (const b of ctx.docsValidation.broken) {
        out.push(`- ${b.file ?? ''}${b.line ? `:${b.line}` : ''} — ${b.kind ?? 'broken'}: ${b.ref ?? ''}`);
      }
    }
    out.push('');
  }

  if (ctx.audit) {
    out.push(...renderAudit(ctx.audit, ctx.scope));
  }

  return out.join('\n');
}

/** How many rows of a map the brief carries before it truncates. */
const MAP_ROW_CAP = 60;
/**
 * How many floor findings one brief lists.
 *
 * The COUNTS are complete; the list is a sample. A broken 120-task plan has
 * 120 findings in maybe three classes — the agent reports the classes with
 * their counts, and the orchestrator fixes the class.
 */
const FINDING_ROW_CAP = 40;

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
function renderAudit(audit, scope = null) {
  const out = [];
  const maps = audit.maps ?? {};
  const issues = audit.issues ?? [];
  const warnings = audit.warnings ?? [];

  out.push('### Mechanical floor — computed for you (do NOT re-derive)');
  out.push('');
  const issueTotal = audit.issuesTotal ?? issues.length;
  const warningTotal = audit.warningsTotal ?? warnings.length;
  const shownIssues = issues.slice(0, FINDING_ROW_CAP);
  const shownWarnings = warnings.slice(0, FINDING_ROW_CAP);
  if (audit.verdict) out.push(`- floor verdict: ${audit.verdict}`);
  out.push(`- blocking issues: ${issueTotal}${summarizeCodes(issues, audit.issueCodes)}`);
  out.push(`- warnings: ${warningTotal}${summarizeCodes(warnings, audit.warningCodes)}`);
  const waived = audit.waivedFindings ?? [];
  if (waived.length) {
    out.push(`- waived (approved deviations, NOT defects): ${waived.length}${summarizeCodes(waived.map((w) => w.finding), audit.waivedCodes)}`);
  }
  if (shownIssues.length) {
    out.push('');
    out.push('BLOCKING (report each once, with the fix):');
    for (const i of shownIssues) out.push(`- ${i}`);
    const omitted = Math.max(0, issueTotal - shownIssues.length);
    if (omitted > 0) {
      out.push(
        `- … ${omitted} more of the same classes — report them BY CLASS with the counts above, not one line each` +
          (scope?.tasksYaml
            ? ` (the instances are reachable: archgen_plan{action:'verify',offset:${shownIssues.length}})`
            : ''),
      );
    }
  }
  if (shownWarnings.length) {
    out.push('');
    out.push('WARNINGS (informational; they do NOT block approval):');
    for (const w of shownWarnings) out.push(`- ${w}`);
    const omitted = Math.max(0, warningTotal - shownWarnings.length);
    if (omitted > 0) {
      out.push(
        `- … ${omitted} more` +
          (scope?.tasksYaml
            ? ` (reachable: archgen_plan{action:'verify',collection:'warnings',offset:${shownWarnings.length}})`
            : ''),
      );
    }
  }
  if (waived.length) {
    out.push('');
    out.push('WAIVED — approved deviations. Do NOT re-raise them unless they regressed:');
    for (const w of waived.slice(0, FINDING_ROW_CAP)) out.push(`- ${w.waiver ? `${w.waiver}: ` : ''}${w.finding}`);
    if (waived.length > FINDING_ROW_CAP) out.push(`- … ${waived.length - FINDING_ROW_CAP} more`);
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
      title: '#### Edge-case matrix map — row | expected | cited | the acceptance | claims',
      where: "the plan's edge-case matrix section (it holds each row's input state)",
      lines: rows.map((r) => {
        const text = r.acceptance ? String(r.acceptance).slice(0, 90) : 'NO SUCH ACCEPTANCE';
        const claimed = (r.claims ?? []).length ? r.claims.join(', ') : '—';
        const expected = String(r.expected ?? r.case ?? '').slice(0, 70);
        return `${r.row} | ${expected} | ${r.task}#${r.index} | ${text} | ${claimed}`;
      }),
      footer:
        'The claim link is already checked. Judge the rest: does the cited acceptance deliver the expected behaviour? ' +
        "The input state lives in the plan's matrix section — read it for any row you doubt.",
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

/**
 * " (MIRROR_MISSING x120, REQ_UNCITED x3)" — the counts the orchestrator
 * groups fixes by.
 *
 * The counts come from the FLOOR's own tally (`issueCodes`), so they are
 * complete even when the floor's list is a sample. That is the whole point:
 * 120 identical findings are one fix, not 120 lines to read.
 */
function summarizeCodes(list, counts) {
  const source = counts && Object.keys(counts).length ? counts : null;
  if (source) {
    const parts = Object.entries(source).map(([code, n]) => `${code} x${n}`);
    return ` (${parts.join(', ')})`;
  }
  if (!list.length) return '';
  const local = new Map();
  for (const m of list) {
    const code = String(m).split(':')[0];
    local.set(code, (local.get(code) ?? 0) + 1);
  }
  return ` (${[...local.entries()].map(([code, n]) => `${code} x${n}`).join(', ')})`;
}
