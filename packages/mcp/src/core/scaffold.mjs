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
import { invalidInput } from './errors.mjs';
import { TEMPLATES_DIR } from '../context.mjs';

/**
 * Read a canonical template and substitute the project slug.
 * @param {string} templatesDir
 * @param {string} name the template file name
 * @param {string} slug
 */
function readTemplate(templatesDir, name, slug) {
  let text;
  try {
    text = readFileSync(join(templatesDir, name), 'utf8');
  } catch {
    throw invalidInput(`artifact template '${name}' is missing from the server assets`, { template: name });
  }
  return text
    .replaceAll('<slug>', slug)
    .replaceAll('<project name>', slug)
    .replaceAll('<feature>', slug);
}

/**
 * The artifact set + skeletons for one scope class.
 *
 * @param {object} ladder the depth-ladder.json content
 * @param {string} scopeClass 'SMALL' | 'MEDIUM' | 'LARGE'
 * @param {{slug?: string, generator?: string, generatedAt?: string, templatesDir?: string}} opts
 */
export function buildScaffold(ladder, scopeClass, opts = {}) {
  const key = String(scopeClass ?? '').toUpperCase();
  const spec = ladder.classes?.[key];
  if (!spec) {
    throw invalidInput(`unknown scope class '${scopeClass}' (allowed: ${Object.keys(ladder.classes ?? {}).join('|')})`, {
      scopeClass,
    });
  }

  const slug = opts.slug ?? '<slug>';
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const generator = opts.generator ?? 'archgen';
  const templatesDir = opts.templatesDir ?? TEMPLATES_DIR;

  // The artifact set, with <slug> resolved (a path may mention it twice).
  const artifacts = (spec.artifacts ?? []).map((a) => ({
    ...a,
    path: a.path.replaceAll('<slug>', slug),
  }));

  // The canonical templates (assets/templates/) — one copy, served here.
  // The PRD + architecture contract are LARGE-only artifacts; the ADR and the
  // Mermaid snippets are optional extras any class may add.
  const isLarge = key === 'LARGE';
  const isMediumPlus = key !== 'SMALL';
  const header = provenanceHeader(generatedAt, generator);
  const tasksYaml = templatesDir
    ? `${header}\n${readTemplate(templatesDir, 'tasks.yaml', slug)}`
    : `${header}\n${minimalTasksYaml()}`;
  const planMd = renderPlanMd(key, spec, slug, generatedAt);
  const answersYaml = isMediumPlus ? renderAnswersYaml(key, generatedAt, generator) : null;
  const prdMd = isLarge && templatesDir ? readTemplate(templatesDir, 'prd.md', slug) : null;
  const architectureYaml =
    isLarge && templatesDir ? `${header}\n${readTemplate(templatesDir, 'architecture.yaml', slug)}` : null;
  const adrMd = templatesDir ? readTemplate(templatesDir, 'adr.md', slug) : null;
  const edgeMatrix = templatesDir
    ? `${renderEdgeMatrix(ladder)}\n${readTemplate(templatesDir, 'edge-matrix.md', slug)}`
    : renderEdgeMatrix(ladder);
  const mermaid = templatesDir ? readTemplate(templatesDir, 'mermaid.md', slug) : null;

  const requiredArtifacts = artifacts.filter((a) => a.required !== false).map((a) => a.path);
  const optionalArtifacts = artifacts.filter((a) => a.required === false).map((a) => a.path);
  const depthBudgets = ladder.profile?.depthBudgets?.[key] ?? null;

  return {
    scopeClass: key,
    label: spec.label,
    // THIS TOOL WRITES NOTHING. It returns the CONTENT of every file the
    // scope class needs, and the caller writes them. An agent that assumes
    // otherwise gets "missing or not a directory" from every artifact tool
    // and reads it as a broken tool rather than an unwritten plan.
    writes: false,
    writeThese: requiredArtifacts,
    requiredArtifacts,
    optionalArtifacts,
    artifactPolicy:
      'Write a REQUIRED artifact. Write an OPTIONAL artifact only when the plan profile marks it create. ' +
      'A reuse decision cites an existing repository source; an omit decision records its reason. ' +
      'Unrecorded omissions and artifacts without a consumer are defects.',
    omissionPolicy: {
      allowed: true,
      mustRecord: 'Write every create/reuse/omit decision and its reason to the plan profile (answers.yaml or the plan Profile section).',
    },
    depthBudgets,
    intentDefaults: spec.intentDefaults ?? [],
    roundCap: spec.roundCap ?? null,
    artifacts,
    planSections: spec.planSections ?? [],
    minEdgeCasesPerTask: spec.minEdgeCasesPerTask ?? 0,
    requires: spec.requires ?? [],
    forbids: spec.forbids ?? [],
    notes: spec.notes ?? [],
    edgeCaseClasses: ladder.edgeCaseClasses ?? [],
    edgeCaseExtras: ladder.edgeCaseExtras ?? {},
    skeletons: {
      'answers.yaml': answersYaml,
      'tasks.yaml': tasksYaml,
      'plans/<slug>.md': planMd,
      'docs/prd.md': prdMd,
      'architecture.yaml': architectureYaml,
      'decisions/NNNN-title.md': adrMd,
      'docs/mermaid-snippets.md': mermaid,
    },
    edgeMatrixTemplate: edgeMatrix,
    nextStep:
      'Run archgen_plan{action:"profile"} first; then fill only the skeletons whose profile decision is create. ' +
      'Then run archgen_plan{action:"validate"} and archgen_plan{action:"verify"}.',
  };
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
      reason: ""
  escalate_if: []
  gate: # recorded after the gate; the floor compares it with waivers.yaml
    rounds: 0
    findings:
      blocking: 0
      nit: 0
      observation: 0
    waived: 0
    residual: 0
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
