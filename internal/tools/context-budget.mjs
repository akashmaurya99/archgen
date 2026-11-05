#!/usr/bin/env node
// context-budget.mjs — internal QA tool (never shipped in the skill payload).
// Measures skill + .archgen/<slug>/ payloads against 32k/64k/128k/200k/1M windows.
//   node context-budget.mjs [--skill-dir <dir>] [--project <dir>] [--slug <name>]
//                           [--json] [--windows <list>] [--budget <n>] [--tokenizer <pkg>]
// Exit 0 ok · 1 over --budget · 2 invalid input · 4 unreadable input.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens, exactTokens, fmtTokens, pctOf } from './tokens.mjs';

const USAGE = 'usage: context-budget.mjs [--skill-dir <dir>] [--project <dir>] [--slug <name>] [--json] [--windows <list>] [--budget <n>] [--tokenizer <pkg>]';
const DEFAULT_WINDOWS = [32768, 65536, 131072, 200000, 1000000];

function die(msg, code = 4) { console.error(`context-budget: ${msg}`); process.exit(code); }

// --- arguments ---------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = {
  skillDir: null,
  project: null,
  slug: null,
  json: false,
  windows: DEFAULT_WINDOWS,
  budget: null,
  tokenizer: null,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--skill-dir') opts.skillDir = argv[++i];
  else if (a === '--project') opts.project = argv[++i];
  else if (a === '--slug') opts.slug = argv[++i];
  else if (a === '--json') opts.json = true;
  else if (a === '--windows') opts.windows = String(argv[++i] ?? '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
  else if (a === '--budget') opts.budget = parseInt(argv[++i], 10);
  else if (a === '--tokenizer') opts.tokenizer = argv[++i];
  else if (a.startsWith('--')) die(`${USAGE} — unknown option '${a}'`);
  else die(`${USAGE} — unexpected argument '${a}'`);
}
if (opts.skillDir === undefined || opts.project === undefined || opts.slug === undefined || opts.tokenizer === undefined) {
  die(`${USAGE} — --skill-dir/--project/--slug/--tokenizer require a value`);
}
if (opts.windows.length === 0) die(`${USAGE} — --windows needs at least one positive integer`);
if (opts.budget !== null && (!Number.isFinite(opts.budget) || opts.budget <= 0)) die(`${USAGE} — --budget needs a positive integer`);

// --- skill dir resolution ----------------------------------------------------
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
function resolveSkillDir() {
  const candidates = [
    opts.skillDir ? resolve(opts.skillDir) : null,
    join(SCRIPT_DIR, '..'), // installed layout: <skill>/scripts/context-budget.mjs
    join(SCRIPT_DIR, '..', '..', '..', 'skill'), // repo layout: <repo>/skill/scripts/...
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, 'SKILL.md'))) return c;
  }
  return null;
}
const skillDir = resolveSkillDir();
if (!skillDir && !opts.project) die('skill tree not found (no SKILL.md) — pass --skill-dir or --project', 2);

// --- file walking ------------------------------------------------------------
/** Recursively collect files under `dir`, skipping dot-directories and node_modules. */
function walk(dir, filter = () => true) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && filter(e.name)) out.push(p);
    }
  }
  return out.sort();
}

function readTextSafe(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

// --- token accounting --------------------------------------------------------
/**
 * Count tokens for a set of files. Uses the exact tokenizer when one was
 * supplied AND it loads; otherwise the estimator. `exact` is reported so the
 * reader knows which number they are looking at.
 */
async function countFiles(files) {
  const rows = [];
  let total = 0;
  let usedExact = false;
  for (const f of files) {
    const text = readTextSafe(f);
    if (text === null) continue;
    let tokens;
    if (opts.tokenizer) {
      const exact = await exactTokens(text, opts.tokenizer);
      if (exact !== null) { tokens = exact; usedExact = true; } else tokens = estimateTokens(text);
    } else {
      tokens = estimateTokens(text);
    }
    total += tokens;
    rows.push({ file: f, tokens, bytes: text.length });
  }
  return { rows, total, exact: usedExact };
}

// --- skill payload -----------------------------------------------------------
// Bucket the skill tree the way the loader actually cares about it.
function classifySkillFile(rel) {
  if (rel === 'SKILL.md') return 'skill-md';
  if (rel.startsWith('references/')) return 'references';
  if (rel.startsWith('scripts/')) return 'scripts';
  if (rel.startsWith('assets/')) return 'assets';
  return 'other';
}

/** Which references each SKILL.md mode actually pulls in. */
const MODE_REFERENCES = {
  'GENERATE': ['references/interview.md', 'references/artifact-templates.md', 'references/orchestration.md', 'references/code-standards.md', 'references/platforms.md'],
  'BROWNFIELD': ['references/interview.md', 'references/artifact-templates.md', 'references/orchestration.md', 'references/code-standards.md', 'references/platforms.md'],
  'START-WORK': ['references/orchestration.md', 'references/code-standards.md', 'references/artifact-templates.md', 'references/platforms.md'],
  'UPDATE': ['references/orchestration.md', 'references/artifact-templates.md', 'references/code-standards.md'],
  'ROLLBACK': ['references/orchestration.md'],
  'INSTALL-MCP': ['references/mcp-and-skills.md', 'references/platforms.md'],
  'FETCH-SKILL': ['references/mcp-and-skills.md'],
};

/** Dev-only subtrees that never ship to users (mirrors the CLI's DEV_ONLY_RELPATHS). */
const DEV_ONLY_RELPATHS = ['scripts/test'];

function isDevOnly(rel) {
  return DEV_ONLY_RELPATHS.some((p) => rel === p || rel.startsWith(p + '/'));
}

async function auditSkill() {
  const files = walk(skillDir);
  const { rows, total, exact } = await countFiles(files);
  const allFiles = rows.map((r) => ({ file: relative(skillDir, r.file).split(sep).join('/'), tokens: r.tokens, bytes: r.bytes }));
  // Dev-only files are repo tooling: they never reach an installed skill, so
  // counting them would inflate the payload by ~25% and misrepresent reality.
  const devOnly = allFiles.filter((r) => isDevOnly(r.file));
  const byFile = allFiles.filter((r) => !isDevOnly(r.file));
  const shippedTotal = byFile.reduce((n, r) => n + r.tokens, 0);
  const devOnlyTokens = devOnly.reduce((n, r) => n + r.tokens, 0);
  const groups = {};
  for (const r of byFile) {
    const g = classifySkillFile(r.file);
    groups[g] = (groups[g] ?? 0) + r.tokens;
  }
  const find = (rel) => byFile.find((r) => r.file === rel)?.tokens ?? 0;
  const skillMd = find('SKILL.md');

  const scenarios = [];
  const modeRefs = MODE_REFERENCES['GENERATE'];
  const modeRefTokens = modeRefs.reduce((n, rel) => n + find(rel), 0);
  const refAndAssets = byFile
    .filter((r) => r.file.startsWith('references/') || r.file.startsWith('assets/'))
    .reduce((n, r) => n + r.tokens, 0);
  scenarios.push({
    id: 'skill-trigger',
    label: 'SKILL.md only (always loaded on trigger)',
    tokens: skillMd,
    note: 'the progressive-disclosure entry point',
  });
  scenarios.push({
    id: 'skill-mode',
    label: "SKILL.md + one mode's references (GENERATE path)",
    tokens: skillMd + modeRefTokens,
    note: `SKILL.md + ${modeRefs.length} reference files`,
  });
  scenarios.push({
    id: 'skill-reference-max',
    label: 'SKILL.md + ALL references + assets (max readable prose)',
    tokens: skillMd + refAndAssets,
    note: 'the ceiling for a well-behaved agent that pulls every reference',
  });
  scenarios.push({
    id: 'skill-full',
    label: 'entire shipped skill tree (worst case: agent reads every file)',
    tokens: shippedTotal,
    note: 'includes scripts — normally invoked, never read',
  });
  return {
    dir: skillDir,
    total: shippedTotal,
    devOnlyTokens,
    devOnlyFiles: devOnly.length,
    exact,
    files: byFile,
    groups,
    scenarios,
  };
}

// --- artifact payload --------------------------------------------------------
// Audit .archgen/<slug>/ trees: full-tree cost + per-worker slices.
async function auditArtifacts(projectRoot, slugFilter) {
  const archgenDir = join(projectRoot, '.archgen');
  if (!existsSync(archgenDir)) return [];
  const slugs = readdirSync(archgenDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((s) => !slugFilter || s === slugFilter)
    .sort();

  const results = [];
  for (const slug of slugs) {
    const dir = join(archgenDir, slug);
    const files = walk(dir, (name) => /\.(md|ya?ml)$/i.test(name));
    const { rows, total, exact } = await countFiles(files);
    const byFile = rows.map((r) => ({ file: relative(dir, r.file).split(sep).join('/'), tokens: r.tokens, bytes: r.bytes }));
    const tasksFile = byFile.find((r) => r.file === 'tasks.yaml');
    const planFiles = byFile.filter((r) => r.file.startsWith('plans/'));
    const codeStandards = byFile.find((r) => r.file === 'references/code-standards.md');

    // Worker slice: the task contract (tasks.yaml) + the plan file that owns
    // the tasks + the code-standards reference every worker prompt carries.
    const workerTokens = (tasksFile?.tokens ?? 0) + (planFiles.length ? Math.max(...planFiles.map((p) => p.tokens)) : 0);

    results.push({
      slug,
      dir,
      total,
      exact,
      fileCount: byFile.length,
      files: byFile,
      tasksYamlTokens: tasksFile?.tokens ?? 0,
      planTokens: planFiles.reduce((n, p) => n + p.tokens, 0),
      workerSliceTokens: workerTokens + (codeStandards?.tokens ?? 0),
    });
  }
  return results;
}

// --- report ------------------------------------------------------------------
function windowRows(scenarios) {
  return opts.windows.map((w) => {
    const cells = scenarios.map((s) => ({ id: s.id, tokens: s.tokens, pct: pctOf(s.tokens, w) }));
    const worst = cells.reduce((m, c) => (c.pct > m.pct ? c : m), cells[0]);
    return { window: w, label: formatWindow(w), cells, worst };
  });
}

function formatWindow(w) {
  if (w >= 1000000) return `${w / 1000000}M`;
  // Binary windows (32768/65536/131072) read as their canonical 32k/64k/128k.
  if (w % 1024 === 0) return `${w / 1024}k`;
  if (w >= 1000) return `${Math.round(w / 1000)}k`;
  return String(w);
}

function statusFor(pct) {
  if (pct >= 100) return 'OVER';
  if (pct >= 25) return 'HIGH';
  if (pct >= 10) return 'MED';
  return 'OK';
}

const skill = skillDir ? await auditSkill() : null;
const projectRoot = opts.project ? resolve(opts.project) : process.cwd();
const artifacts = await auditArtifacts(projectRoot, opts.slug);

// Scenarios combine the skill side with the artifact side.
const scenarios = [];
if (skill) {
  for (const s of skill.scenarios) scenarios.push(s);
}
for (const a of artifacts) {
  scenarios.push({
    id: `artifacts-full:${a.slug}`,
    label: `full artifact tree — .archgen/${a.slug}/`,
    tokens: a.total,
    note: `${a.fileCount} markdown/yaml files`,
  });
  scenarios.push({
    id: `worker-context:${a.slug}`,
    label: `one worker slice — .archgen/${a.slug}/ (task contract + plan + standards)`,
    tokens: a.workerSliceTokens,
    note: 'what a single dispatched worker actually needs',
  });
}
if (skill && artifacts.length) {
  const a = artifacts[0];
  scenarios.push({
    id: 'orchestrator-total',
    label: 'orchestrator total (SKILL.md + mode refs + artifacts + one worker slice)',
    tokens: skill.scenarios[1].tokens + a.total + a.workerSliceTokens,
    note: 'realistic worst case for one full planning/execution cycle',
  });
}

const windows = windowRows(scenarios);
const overBudget = opts.budget !== null ? scenarios.filter((s) => s.tokens > opts.budget) : [];

const report = {
  generator: 'archgen context-budget',
  tokenModel: opts.tokenizer ? `exact:${opts.tokenizer}` : 'estimator (±10%)',
  windows: opts.windows,
  budget: opts.budget,
  skill: skill && {
    dir: skill.dir,
    totalTokens: skill.total,
    groups: skill.groups,
    files: skill.files.sort((a, b) => b.tokens - a.tokens),
  },
  artifacts,
  scenarios: scenarios.map((s) => ({ ...s, pct: Object.fromEntries(opts.windows.map((w) => [w, pctOf(s.tokens, w)])) })),
  windowPressure: windows,
  overBudget: overBudget.map((s) => ({ id: s.id, tokens: s.tokens, label: s.label })),
};

// --- output ------------------------------------------------------------------
if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = (s = '-') => console.log(s);
  line('archgen context budget');
  line(`  token model: ${report.tokenModel}`);
  line(`  windows:     ${opts.windows.map(formatWindow).join(', ')}`);
  line();

  if (skill) {
    line('SKILL PAYLOAD');
    line(`  total ${fmtTokens(skill.total)} tokens across ${skill.files.length} shipped files`);
    if (skill.devOnlyTokens) {
      line(`  (dev-only, not shipped: ${fmtTokens(skill.devOnlyTokens)} tokens in ${skill.devOnlyFiles} test files)`);
    }
    for (const [g, t] of Object.entries(skill.groups).sort((a, b) => b[1] - a[1])) {
      line(`    ${g.padEnd(12)} ${fmtTokens(t).padStart(9)}  ${pctOf(t, 200000).toFixed(2)}% of 200k`);
    }
    line('  largest files:');
    for (const f of skill.files.slice(0, 8)) {
      line(`    ${fmtTokens(f.tokens).padStart(8)}  ${f.file}`);
    }
    line();
  }

  if (artifacts.length) {
    line('ARTIFACT PAYLOAD (.archgen/<slug>/)');
    for (const a of artifacts) {
      line(`  ${a.slug}: ${fmtTokens(a.total)} tokens across ${a.fileCount} files (tasks.yaml ${fmtTokens(a.tasksYamlTokens)}, plans ${fmtTokens(a.planTokens)})`);
      for (const f of a.files.slice(0, 6)) {
        line(`    ${fmtTokens(f.tokens).padStart(8)}  ${f.file}`);
      }
    }
    line();
  }

  line('LOAD SCENARIOS');
  for (const s of scenarios) {
    const worst = opts.windows.map((w) => ({ w, pct: pctOf(s.tokens, w) })).reduce((m, c) => (c.pct > m.pct ? c : m));
    line(`  ${statusFor(worst.pct).padEnd(5)} ${fmtTokens(s.tokens).padStart(9)}  ${worst.pct.toFixed(2)}% of ${formatWindow(worst.w)}  ${s.label}`);
  }
  line();

  line('WINDOW PRESSURE');
  for (const w of windows) {
    line(`  ${w.label.padEnd(6)} ` + w.cells.map((c) => `${c.id}:${c.pct.toFixed(1)}%`).join('  '));
  }

  if (opts.budget !== null) {
    line();
    if (overBudget.length) {
      line(`OVER BUDGET (${fmtTokens(opts.budget)}):`);
      for (const s of overBudget) line(`  - ${s.label}: ${fmtTokens(s.tokens)}`);
    } else {
      line(`within budget (${fmtTokens(opts.budget)}).`);
    }
  }
}

if (overBudget.length) process.exit(1);
