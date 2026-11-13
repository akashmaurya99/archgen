// scaffold.mjs — the depth ladder as tool output.
//
// The agent used to read references/artifact-templates.md and hand-write the
// artifact set for its scope class. That is exactly the kind of deterministic
// work a tool should own: the required set, the file shapes and the ordering
// are DATA, and prose restatements of data drift.
//
// The literal templates live in `assets/templates/` — ONE canonical copy. This
// module serves them; the reference keeps only the authoring RULES and points
// here. A template can therefore never disagree with the tool.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invalidInput } from '../protocol/errors.mjs';
import { assertSlug } from '../protocol/slug.mjs';
import { TEMPLATES_DIR } from '../../context.mjs';
import { buildPlanProfile, scopeArtifactRules } from './plan-profile.mjs';
import { buildWriteOrder } from './artifact-order.mjs';
import { hint } from '../protocol/guidance.mjs';
import { toolCall } from '../protocol/call.mjs';

/**
 * Which skeleton serves which artifact.
 *
 * The artifact path is the PLAN's name for the file; the skeleton key is the
 * TEMPLATE's name. The mapping is by suffix (see skeletonKeyFor), so the
 * scaffold can serve exactly the artifacts a profile marked `create`.
 */

/**
 * Read a canonical template and substitute the project slug.
 * @param {string} templatesDir
 * @param {string} name the template file name
 * @param {string} slug
 */
/**
 * Read a template and substitute the names it carries.
 *
 * `<slug>` and `<project name>` are the PROJECT's name, so they are filled in.
 * `<feature>` is NOT: it is the FEATURE the task delivers, which only the
 * agent knows, and filling it with the slug silently renamed every feature
 * path in the plan. It stays a placeholder for the agent to replace.
 *
 * @param {string} templatesDir
 * @param {string} name the template's file name
 * @param {string} slug the project's slug
 * @returns {string}
 */
function readTemplate(templatesDir, name, slug) {
  let text;
  try {
    text = readFileSync(join(templatesDir, name), 'utf8');
  } catch {
    throw invalidInput(
      `artifact template '${name}' is missing from the server assets`,
      { ...hint({ action: 'archgen-skill doctor', reason: "the server package is incomplete \u2014 reinstall archgen-mcp." }), template: name },
    );
  }
  return text
    .replaceAll('<slug>', slug)
    .replaceAll('<project name>', slug);
}

/**
 * The artifact set + skeletons for one scope class.
 *
 * TWO MODES, ONE SOURCE OF TRUTH.
 *
 * - With `intent` (and optionally `signals`): the PROFILE decides. The
 *   scaffold serves exactly the artifacts it marked `create`, and reports the
 *   `reuse` and `omit` decisions with their reasons. This is the mode the
 *   skill uses, because it is the only one that cannot drift from the
 *   recorded decision.
 * - Without `intent`: the scope class's CANDIDATE set — the same artifact
 *   rules, filtered by the class. `writeThese` is the required subset; the
 *   conditional artifacts are listed with `required: false` and their
 *   skeleton is served on request.
 *
 * The artifact set used to be listed TWICE in the ladder (once in the profile
 * rules, once per class), and the two drifted — the profile could mark an
 * artifact `create` that the scaffold never offered. There is one list now:
 * `profile.artifactRules`.
 *
 * @param {object} ladder the depth-ladder.json content
 * @param {string} scopeClass 'SMALL' | 'MEDIUM' | 'LARGE'
 * @param {{slug?: string, generator?: string, generatedAt?: string, templatesDir?: string,
 *          intent?: string, signals?: string[], modules?: number, tasks?: number}} opts
 */
export function buildScaffold(ladder, scopeClass, opts = {}) {
  const requested = String(scopeClass ?? '').toUpperCase();
  const spec = ladder.classes?.[requested];
  if (!spec) {
    throw invalidInput(
      `unknown scope class '${scopeClass}' (allowed: ${Object.keys(ladder.classes ?? {}).join('|')})`,
      { ...hint({ action: toolCall('archgen_plan', { action: 'profile', intent: 'GREENFIELD-SYSTEM', slug: '<slug>' }), reason: "the profile names every scope class." }), scopeClass, },
    );
  }

  const slug = opts.slug ?? '<slug>';
  if (opts.slug) assertSlug(opts.slug, 'scaffold');
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const generator = opts.generator ?? 'archgen';
  const templatesDir = opts.templatesDir ?? TEMPLATES_DIR;

  // The profile, when the caller knows the intent: it decides the set.
  // The scaffold is called with the SAME inputs the profile was called with
  // (the profile's own `next` spells them out), so the served set is the
  // recorded profile's create set — never a second, drifting one.
  const profile = opts.intent
    ? buildPlanProfile(ladder, {
        intent: opts.intent,
        signals: opts.signals ?? [],
        modules: opts.modules,
        tasks: opts.tasks,
        slug,
      })
    : null;
  const key = profile ? profile.scopeClass : requested;

  // The artifact set: one list (the profile rules), filtered by scope.
  const rules = scopeArtifactRules(ladder, key);
  const artifacts = profile
    ? profile.artifacts.map((a) => ({
        path: a.path,
        purpose: a.purpose ?? null,
        required: a.decision === 'create',
        decision: a.decision,
        reason: a.reason,
        pattern: a.pattern ?? null,
      }))
    : rules.map((r) => ({
        path: r.path.replaceAll('<slug>', slug),
        purpose: r.purpose ?? null,
        required: r.required,
        decision: r.required ? 'create' : 'conditional',
        reason: r.required
          ? (r.purpose ?? 'required for every plan at this scope')
          : 'the profile decides this one — it needs an intent and signals',
        pattern: r.pattern ?? null,
      }));

  const createPaths = profile
    ? profile.artifacts.filter((a) => a.decision === 'create').map((a) => a.path)
    : artifacts.filter((a) => a.required).map((a) => a.path);
  const reusePaths = profile ? profile.artifacts.filter((a) => a.decision === 'reuse').map((a) => a.path) : [];
  const omitPaths = profile ? profile.artifacts.filter((a) => a.decision === 'omit').map((a) => a.path) : [];

  // THE WRITE ORDER. The create set, in the only order it can be written
  // consistently: every artifact after the ones it depends on.
  //
  // The edges live in the ladder's rules (`dependsOn`); the order is DERIVED
  // from them here and never stored, so the two can never disagree. The
  // ladder's FULL rule list is the input — not the class-filtered one — so a
  // dependency the class does not create is DISSOLVED rather than reported
  // as an unknown family.
  const writeOrder = buildWriteOrder(artifacts, ladder.profile?.artifactRules ?? []);
  const orderedCreates = writeOrder.order;

  // The canonical templates (assets/templates/) — one copy, served here.
  const header = provenanceHeader(generatedAt, generator);
  const tasksYaml = templatesDir
    ? `${header}\n${readTemplate(templatesDir, 'tasks.yaml', slug)}`
    : `${header}\n${minimalTasksYaml()}`;
  const planMd = renderPlanMd(key, spec, slug, generatedAt);
  const answersYaml = key !== 'SMALL' ? renderAnswersYaml(key, generatedAt, generator) : null;
  const prdMd = templatesDir ? readTemplate(templatesDir, 'prd.md', slug) : null;
  const architectureYaml = templatesDir ? `${header}\n${readTemplate(templatesDir, 'architecture.yaml', slug)}` : null;
  const adrMd = templatesDir ? readTemplate(templatesDir, 'adr.md', slug) : null;
  // ONE edge-case table. The generated rows and the static template used to
  // be concatenated, so the plan carried TWO tables with the SAME row ids and
  // DIFFERENT cases (E3 was "concurrent" in one and "authz denied" in the
  // other) — and the floor then reported a dozen unresolved citations for
  // rows the agent had never seen.
  const edgeMatrix = templatesDir
    ? readTemplate(templatesDir, 'edge-matrix.md', slug)
    : renderEdgeMatrix(ladder);
  const mermaid = templatesDir ? readTemplate(templatesDir, 'mermaid.md', slug) : null;

  const skeletonBodies = {
    'answers.yaml': answersYaml,
    'tasks.yaml': tasksYaml,
    'plans/<slug>.md': planMd,
    'docs/prd.md': prdMd,
    'architecture.yaml': architectureYaml,
    'decisions/NNNN-title.md': adrMd,
    'docs/mermaid-snippets.md': mermaid,
  };

  // In profile mode the scaffold serves EXACTLY the create set. In class mode
  // it serves the candidates, with the required ones flagged.
  const wanted = profile ? artifacts.filter((a) => a.decision === 'create') : artifacts;
  const served = {};
  for (const a of wanted) {
    const key = skeletonKeyForPath(a.path);
    if (key && skeletonBodies[key]) served[key] = skeletonBodies[key];
  }

  const requiredArtifacts = profile
    ? createPaths
    : artifacts.filter((a) => a.required).map((a) => a.path);
  const optionalArtifacts = profile
    ? reusePaths
    : artifacts.filter((a) => !a.required).map((a) => a.path);
  const depthBudgets = ladder.profile?.depthBudgets?.[key] ?? null;

  return {
    scopeClass: key,
    label: spec.label,
    // WHICH SET THIS IS. 'profile' = exactly the recorded profile's create
    // set. 'class' = the class's CANDIDATE set, because no intent was given
    // and therefore no evidence exists to decide the conditional artifacts.
    // The two used to be presented identically, so an agent could serve the
    // candidate set and believe it had served the profile.
    mode: profile ? 'profile' : 'class',
    modeNote: profile
      ? 'this is exactly the profile\'s create set — fill these and only these'
      : 'no intent was given, so this is the class CANDIDATE set (conditional artifacts are marked optional). ' +
        'Run archgen_plan{action:"profile"} with the same intent and signals, then scaffold again with them.',
    // THIS TOOL WRITES NOTHING. It returns the CONTENT of every file the
    // profile requires, and the caller writes them. An agent that assumes
    // otherwise gets "missing or not a directory" from every artifact tool
    // and reads it as a broken tool rather than an unwritten plan.
    writes: false,
    // The create set, ORDERED. This is the list the agent writes, top to
    // bottom: each step waits for the ones it depends on.
    writeThese: orderedCreates,
    requiredArtifacts,
    optionalArtifacts,
    reuseArtifacts: reusePaths,
    omittedArtifacts: omitPaths,
    // The order itself, with each step's dependencies and the fact each one
    // must carry forward. The agent follows this, one file at a time.
    writeOrder: writeOrder.steps,
    writeOrderNote:
      'Write the artifacts in the writeOrder sequence, one file at a time. ' +
      'Each step names the artifacts it depends on and the fact it must carry forward from them; ' +
      'a dependency the profile omits dissolves, and one it reuses is satisfied by the host document.',
    profile,
    scopeMismatch:
      profile && profile.scopeClass !== requested
        ? `the profile says ${profile.scopeClass}, not ${requested} — the profile's class wins`
        : null,
    artifactPolicy:
      'Write a REQUIRED artifact. Write an OPTIONAL artifact only when the plan profile marks it create. ' +
      'Write them in the writeOrder sequence — each step waits for the artifacts it depends on. ' +
      'A reuse decision cites an existing repository source; an omit decision records its reason. ' +
      'Unrecorded omissions and artifacts without a consumer are defects.',
    omissionPolicy: {
      allowed: true,
      mustRecord: 'Write every create/reuse/omit decision and its reason to the plan profile (answers.yaml or the plan Profile section).',
    },
    depthBudgets,
    intentDefaults: spec.intentDefaults ?? [],
    artifacts,
    planSections: spec.planSections ?? [],
    // The edge-case budget has ONE owner: `profile.depthBudgets`. The class
    // used to carry a second copy (`minEdgeCasesPerTask`), and the two
    // disagreed at LARGE (3 against 7), so one payload said two different
    // things about the same ceiling.
    minEdgeCasesPerTask: depthBudgets?.edgeCasesPerTask ?? spec.minEdgeCasesPerTask ?? 0,
    requires: spec.requires ?? [],
    forbids: spec.forbids ?? [],
    notes: spec.notes ?? [],
    edgeCaseClasses: ladder.edgeCaseClasses ?? [],
    edgeCaseExtras: ladder.edgeCaseExtras ?? {},
    skeletons: served,
    edgeMatrixTemplate: edgeMatrix,
    nextStep:
      'Run archgen_plan{action:"profile"} first; then fill only the skeletons whose profile decision is create, ' +
      'in the writeOrder sequence (step 1 first). ' +
      'Then run archgen_plan{action:"validate"} and archgen_plan{action:"verify"}.',
  };
}

/**
 * The skeleton key that serves an artifact path (null when there is none).
 *
 * By SUFFIX, not by a table: the artifact path is the plan's name for the
 * file and the skeleton key is the template's name, and the plan's name
 * carries the slug (`plans/<slug>.md`) where the template's does not.
 *
 * EXPORTED: the tool resolves a caller's `file` argument through it, so the
 * path the tool publishes and the path it accepts can never disagree.
 */
export function skeletonKeyForPath(artifactPath) {
  const p = String(artifactPath);
  if (p.endsWith('/tasks.yaml')) return 'tasks.yaml';
  if (p.endsWith('/answers.yaml')) return 'answers.yaml';
  if (p.endsWith('/docs/prd.md')) return 'docs/prd.md';
  if (p.endsWith('/architecture.yaml')) return 'architecture.yaml';
  if (/\/decisions\/[^/]+\.md$/.test(p)) return 'decisions/NNNN-title.md';
  if (p.endsWith('/docs/mermaid-snippets.md')) return 'docs/mermaid-snippets.md';
  if (/\/plans\/[^/]+\.md$/.test(p)) return 'plans/<slug>.md';
  // A per-module diagram is authored FROM the diagram template — the
  // template IS the mermaid source, and the module file holds the rendered
  // diagram. Without this mapping a LARGE plan was told to write
  // `docs/<module>.md` and served no skeleton for it at all.
  if (/\/docs\/[^/]+\.md$/.test(p)) return 'docs/mermaid-snippets.md';
  return null;
}

/** The three-line provenance header every new artifact carries. */
function provenanceHeader(generatedAt, generator) {
  return [`# schema_version: 1`, `# generator: ${generator}`, `# generated_at: ${generatedAt}`].join('\n');
}

/** The fallback tasks.yaml shape when the template assets are unavailable. */
function minimalTasksYaml() {
  return `tasks:
  # Core pipeline — do first
  - id: <ID>
    title: <one-line summary>
    depends_on: []
    file_ownership:
      - <repo-root-relative path or glob>
    acceptance:
      - "<objectively checkable statement>"
`;
}

/** The plan skeleton — one section per required heading. */
function renderPlanMd(scopeClass, spec, slug, generatedAt) {
  const sections = spec.planSections ?? [];
  const lines = [`# ${slug} — plan (${scopeClass})`, '', `_Generated ${generatedAt}_`, ''];
  for (const section of sections) {
    lines.push(`## ${section}`, '');
    if (section === 'Profile') {
      lines.push(
        '- Scope: <SMALL | MEDIUM | LARGE> — <one-line evidence-based rationale>',
        '- Create: <artifact paths from the profile>',
        '- Reuse: <existing repository paths, or none>',
        '- Omit: <artifact paths + one-line reasons, or none>',
        '- Escalate if: <signals that would move the scope up, or none>',
        '',
        'The block below is the RECORD — the floor reads it and checks every',
        'create/reuse/omit decision against the files on disk. Keep it in step',
        'with the bullets above.',
        '',
        '```yaml',
        'scope_class: ' + scopeClass,
        'intent_class: ""',
        'signals: []',
        'artifacts:',
        '  - path: ""',
        '    decision: create | reuse | omit',
        '    reason: ""',
        '    host_path: "" # for a reuse decision: the existing file it cites',
        'escalate_if: []',
        'gate: # filled in after the gate; the floor reads it here',
        '  verifier: "" # who approved it — an approval needs a subject',
        '  rounds: 0',
        '  findings:',
        '    blocking: 0',
        '    nit: 0',
        '    observation: 0',
        '  waived: 0',
        '  residual: 0',
        '  at: "" # ISO-8601 timestamp of the approval',
        '```',
        '',
      );
    } else if (section === 'Context') {
      lines.push('- Why now:', '- What exists:', '- What changes:', '');
    } else if (section === 'Per-task sections') {
      lines.push('### <ID> — <title>', '');
      lines.push('Approach:', '- ', '', 'Edge cases:', '- ', '', 'Out of scope:', '- ', '');
    } else if (section === 'Edge-case matrices') {
      lines.push('| Case | Input/state | Expected behavior | Covered by |', '| --- | --- | --- | --- |', '| E1 |  |  | <ID>#1 |', '');
    } else if (section === 'Verification steps') {
      lines.push('1. `<exact command>`', '');
    } else {
      lines.push('- ', '');
    }
  }
  return lines.join('\n');
}

/** The answers.yaml skeleton (MEDIUM and LARGE) — requirements + plan profile. */
function renderAnswersYaml(scopeClass, generatedAt, generator) {
  return `${provenanceHeader(generatedAt, generator)}
scope_class: ${scopeClass}
intent_class: ""
calibration:
  scale: ""
  teamConstraints: ""
  pressure: ""
plan_profile:
  confidence: high | medium | low
  signals: []
  artifacts:
    - path: ""
      decision: create | reuse | omit
      host_path: "" # a reuse decision MUST name the host document it reuses
      reason: ""
  escalate_if: []
  gate: # recorded after the gate; the floor compares it with waivers.yaml
    verifier: "" # who approved it — an approval needs a subject
    rounds: 0
    findings:
      blocking: 0
      nit: 0
      observation: 0
    waived: 0
    residual: 0
    at: "" # ISO-8601 timestamp of the approval
problem: ""
success_criteria:
  - text: ""
    feeds: prd.metrics
constraints:
  - ""
non_goals: []
personas: []
nfrs: []
out_of_scope: []
stack:
  language: ""
  runtime: ""
  hosting: ""
integrations: []
compliance: []
risks: []
`;
}

/** The edge-case matrix header + the coverage classes every task must hit. */
function renderEdgeMatrix(ladder) {
  const classes = ladder.edgeCaseClasses ?? [];
  const lines = [
    '| Case | Input/state | Expected behavior | Covered by |',
    '| --- | --- | --- | --- |',
  ];
  classes.forEach((c, i) => {
    lines.push(`| E${i + 1} | ${c}: |  | <ID>#1 |`);
  });
  lines.push('');
  lines.push(`Covered by = \`<task-id>#<acceptance index>\` (1-based). Max ${ladder.edgeCaseExtras?.maxRowsPerMatrix ?? 10} rows per matrix — split beyond that.`);
  return lines.join('\n');
}
