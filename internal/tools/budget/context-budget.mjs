#!/usr/bin/env node
// context-budget.mjs — internal QA tool (never shipped in the skill payload).
// Measures skill + .archgen/<slug>/ payloads against 32k/64k/128k/200k/1M windows.
//   node context-budget.mjs [--skill-dir <dir>] [--project <dir>] [--slug <name>]
//                           [--json] [--windows <list>] [--budget <n>] [--tokenizer <pkg>]
// Exit 0 ok · 1 over --budget · 2 invalid input · 4 unreadable input.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens, exactTokens, fmtTokens, pctOf } from './tokens.mjs';
import { writeOut, writeErr } from '../../../packages/mcp/src/core/protocol/io.mjs';

const USAGE = 'usage: context-budget.mjs [--skill-dir <dir>] [--project <dir>] [--slug <name>] [--mcp-dir <dir>] [--json] [--windows <list>] [--budget <n>] [--max-always-on <n>] [--tokenizer <pkg>]';
const DEFAULT_WINDOWS = [32768, 65536, 131072, 200000, 1000000];

function die(msg, code = 4) { writeErr(`context-budget: ${msg}`); process.exit(code); }

// --- arguments ---------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = {
  skillDir: null,
  project: null,
  slug: null,
  json: false,
  windows: DEFAULT_WINDOWS,
  budget: null,
  maxAlwaysOn: null,
  tokenizer: null,
  mcpDir: null,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--skill-dir') opts.skillDir = argv[++i];
  else if (a === '--project') opts.project = argv[++i];
  else if (a === '--slug') opts.slug = argv[++i];
  else if (a === '--json') opts.json = true;
  else if (a === '--windows') opts.windows = String(argv[++i] ?? '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
  else if (a === '--budget') opts.budget = parseInt(argv[++i], 10);
  else if (a === '--max-always-on') opts.maxAlwaysOn = parseInt(argv[++i], 10);
  else if (a === '--tokenizer') opts.tokenizer = argv[++i];
  else if (a === '--mcp-dir') opts.mcpDir = argv[++i];
  else if (a.startsWith('--')) die(`${USAGE} — unknown option '${a}'`);
  else die(`${USAGE} — unexpected argument '${a}'`);
}
if (opts.skillDir === undefined || opts.project === undefined || opts.slug === undefined || opts.tokenizer === undefined) {
  die(`${USAGE} — --skill-dir/--project/--slug/--tokenizer require a value`);
}
if (opts.windows.length === 0) die(`${USAGE} — --windows needs at least one positive integer`);
if (opts.budget !== null && (!Number.isFinite(opts.budget) || opts.budget <= 0)) die(`${USAGE} — --budget needs a positive integer`);
if (opts.maxAlwaysOn !== null && (!Number.isFinite(opts.maxAlwaysOn) || opts.maxAlwaysOn <= 0)) die(`${USAGE} — --max-always-on needs a positive integer`);

// --- skill dir resolution ----------------------------------------------------
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
function resolveSkillDir() {
  const candidates = [
    opts.skillDir ? resolve(opts.skillDir) : null,
    join(SCRIPT_DIR, '..'), // installed layout: <skill>/scripts/context-budget.mjs
    join(SCRIPT_DIR, '..', '..', '..', 'skill'), // repo layout: <repo>/skill/
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

/** Which references each SKILL.md mode actually pulls in. The protocol
 * documents live in the MCP package now (`assets/references/`), so the paths
 * are relative to the MCP dir, not the skill tree. */
const MODE_REFERENCES = {
  'GENERATE': ['assets/references/interview.md', 'assets/references/artifact-templates.md', 'assets/references/orchestration.md', 'assets/references/platforms.md'],
  'BROWNFIELD': ['assets/references/interview.md', 'assets/references/artifact-templates.md', 'assets/references/orchestration.md', 'assets/references/platforms.md'],
  'START-WORK': ['assets/references/orchestration.md', 'assets/references/artifact-templates.md', 'assets/references/platforms.md'],
  'UPDATE': ['assets/references/orchestration.md', 'assets/references/artifact-templates.md'],
  'ROLLBACK': ['assets/references/orchestration.md'],
  'INSTALL-MCP': ['assets/references/mcp-and-skills.md', 'assets/references/platforms.md'],
  'FETCH-SKILL': ['assets/references/mcp-and-skills.md'],
};

/** Dev-only subtrees that never ship to users (mirrors the CLI's DEV_ONLY_RELPATHS). */
// The skill ships no code any more, so the only dev-only subtree left to
// exclude is the legacy scripts/test (never shipped). The obsolete scripts/
// tree is pruned by the installer, not excluded here.
const DEV_ONLY_RELPATHS = ['scripts/test'];

function isDevOnly(rel) {
  return DEV_ONLY_RELPATHS.some((p) => rel === p || rel.startsWith(p + '/'));
}

async function auditSkill(mcpDir) {
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
  const mcpRef = (rel) => {
    const p = join(mcpDir, rel);
    return existsSync(p) ? estimateTokens(readFileSync(p, 'utf8')) : 0;
  };
  const modeRefTokens = modeRefs.reduce((n, rel) => n + mcpRef(rel), 0);
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
    label: "SKILL.md + one mode's protocol references (GENERATE path)",
    tokens: skillMd + modeRefTokens,
    note: `SKILL.md + ${modeRefs.length} MCP-served reference files`,
  });
  scenarios.push({
    id: 'skill-reference-max',
    label: 'SKILL.md + local references/assets (max readable prose in the skill)',
    tokens: skillMd + refAndAssets,
    note: 'the ceiling for prose that actually ships inside the skill tree',
  });
  scenarios.push({
    id: 'skill-full',
    label: 'entire shipped skill tree (worst case: agent reads every file)',
    tokens: shippedTotal,
    note: 'the guidance tree — normally read selectively, never in full',
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

// --- MCP tool catalog --------------------------------------------------------
//
// THE CATALOG IS A PERMANENT CONTEXT TAX. Every MCP client injects every
// tool's name, description and JSON schema into the model's context on every
// request — so the catalog costs as much as the SKILL.md, forever. Measuring
// it is the only way to keep a growing tool surface honest.
//
// The catalog is measured from the LIVE tool registry (the same specs the
// server registers), not from a hand-written copy, so it can never drift.

/**
 * Measure the injected cost of the MCP tool catalog.
 *
 * The number comes from the SERVER's OWN output (`archgen-mcp --catalog`),
 * which prints exactly what a client injects: each tool's name, description
 * and JSON schema. Measuring a hand-written copy would let the budget drift
 * from reality — the whole point of this tool is that it cannot.
 *
 * @param {string} mcpDir the packages/mcp directory
 * @returns {Promise<{available: boolean, tools: Array<{name: string, tokens: number}>, totalTokens: number, bytes: number, reason?: string}>}
 */
async function auditCatalog(mcpDir) {
  const bin = join(mcpDir, 'bin', 'archgen-mcp.mjs');
  if (!existsSync(bin)) {
    return { available: false, tools: [], totalTokens: 0, bytes: 0, reason: `no MCP package at ${mcpDir}` };
  }
  let stdout;
  try {
    const r = spawnSync(process.execPath, [bin, '--catalog'], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) throw new Error(r.stderr?.trim().split('\n')[0] || `exit ${r.status}`);
    stdout = r.stdout;
  } catch (e) {
    return {
      available: false,
      tools: [],
      totalTokens: 0,
      bytes: 0,
      reason: `the MCP catalog could not be read (${e instanceof Error ? e.message : String(e)}) — run: npm ci --prefix packages/mcp`,
    };
  }
  let catalog;
  try {
    catalog = JSON.parse(stdout);
  } catch (e) {
    return { available: false, tools: [], totalTokens: 0, bytes: 0, reason: `the MCP catalog is not valid JSON: ${e.message}` };
  }
  const tools = catalog.map((t) => ({ name: t.name, tokens: estimateTokens(JSON.stringify(t)) }));
  return {
    available: true,
    tools,
    totalTokens: tools.reduce((n, t) => n + t.tokens, 0),
    bytes: stdout.length,
  };
}

/**
 * Measure the REAL MCP wire catalog.
 *
 * `--catalog` prints name + description + inputSchema. The wire protocol's
 * `tools/list` carries MORE: the title, the output schema and the tool
 * annotations. A budget that measured only the projection UNDERCOUNTED the
 * permanent context tax by a third — so the gate was green while the model
 * paid for bytes no report showed.
 *
 * This speaks the protocol to the real binary over stdio — the same path a
 * client takes — and measures what comes back.
 *
 * @param {string} mcpDir the packages/mcp directory
 * @returns {{available: boolean, tools: Array<{name: string, tokens: number}>, totalTokens: number, bytes: number, reason?: string}}
 */
async function auditWireCatalog(mcpDir) {
  const bin = join(mcpDir, 'bin', 'archgen-mcp.mjs');
  if (!existsSync(bin)) {
    return { available: false, tools: [], totalTokens: 0, bytes: 0, reason: `no MCP package at ${mcpDir}` };
  }
  const list = await listMcpTools(bin, null);
  if (!list.ok) {
    return { available: false, tools: [], totalTokens: 0, bytes: 0, reason: list.reason };
  }
  const tools = list.tools.map((t) => ({ name: t.name, tokens: estimateTokens(JSON.stringify(t)) }));
  return {
    available: true,
    tools,
    totalTokens: tools.reduce((n, t) => n + t.tokens, 0),
    bytes: list.bytes,
  };
}

/**
 * Ask an MCP server for its tools over stdio.
 *
 * @param {string} bin the server binary
 * @param {Record<string, string|undefined>|null} env extra environment
 * @returns {Promise<{ok: boolean, tools: any[], bytes: number, reason?: string}>}
 */
function listMcpTools(bin, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [bin], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = '';
    let buffer = '';
    const pending = new Map();
    let nextId = 1;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolvePromise(result);
    };
    const timer = setTimeout(() => finish({ ok: false, tools: [], bytes: 0, reason: 'the server did not answer tools/list in time' }), 20000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });
    const call = (method, params) => new Promise((res) => {
      const id = nextId++;
      pending.set(id, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    child.on('error', (e) => finish({ ok: false, tools: [], bytes: 0, reason: e.message }));
    (async () => {
      const init = await call('initialize', {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'archgen-context-budget', version: '1.0.0' },
      });
      if (!init.result) {
        finish({ ok: false, tools: [], bytes: 0, reason: 'the server did not initialize' });
        return;
      }
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      const listed = await call('tools/list', {});
      const tools = listed.result?.tools ?? [];
      finish({ ok: true, tools, bytes: JSON.stringify(tools).length });
    })();
  });
}

/**
 * Measure the CodeGraph MCP catalog — the OTHER server a session may carry.
 *
 * CodeGraph is optional, but when it is wired its tools are in the model's
 * context exactly like ArchGen's own. The allowlist comes from the policy
 * asset, so the figure describes what the wire actually exposes.
 *
 * @param {string} mcpDir the packages/mcp directory
 * @returns {{available: boolean, tools: Array<{name: string, tokens: number}>, totalTokens: number, bytes: number, reason?: string}}
 */
async function auditCodegraphCatalog(mcpDir) {
  const policyPath = join(mcpDir, 'assets', 'codegraph-policy.json');
  if (!existsSync(policyPath)) {
    return { available: false, tools: [], totalTokens: 0, bytes: 0, reason: 'no CodeGraph policy asset' };
  }
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const baseline = readCodegraphBaseline();
  const bin = which('codegraph');
  if (!bin) {
    // FAIL CLOSED. The CodeGraph catalog is the THIRD always-on term, and a
    // CI runner has no codegraph installed — so measuring it live there
    // yields zero, and a gate that counted zero would check the ceiling
    // against 13,663 tokens while the real cost is 17,459. The baseline is
    // the measured figure, so the gate always sees the truth.
    if (baseline) {
      return {
        available: true,
        estimated: true,
        tools: baseline.tools.map((name) => ({ name, tokens: 0 })),
        totalTokens: baseline.totalTokens,
        bytes: 0,
        reason: 'the codegraph CLI is not on PATH — the committed baseline was used',
      };
    }
    return {
      available: false,
      tools: [],
      totalTokens: 0,
      bytes: 0,
      reason: 'the codegraph CLI is not on PATH and there is no baseline',
    };
  }
  const list = await listMcpToolsExternal(bin, ['serve', '--mcp', '--path', process.cwd()], {
    CODEGRAPH_MCP_TOOLS: (policy.tools ?? []).join(','),
    ...(policy.telemetry === 'off' ? { CODEGRAPH_TELEMETRY: '0' } : {}),
  });
  if (!list.ok) {
    if (baseline) {
      return {
        available: true,
        estimated: true,
        tools: baseline.tools.map((name) => ({ name, tokens: 0 })),
        totalTokens: baseline.totalTokens,
        bytes: 0,
        reason: `the CodeGraph server did not answer (${list.reason}) — the committed baseline was used`,
      };
    }
    return { available: false, tools: [], totalTokens: 0, bytes: 0, reason: list.reason };
  }
  const tools = list.tools.map((t) => ({ name: t.name, tokens: estimateTokens(JSON.stringify(t)) }));
  const totalTokens = tools.reduce((n, t) => n + t.tokens, 0);
  // A live measurement BELOW the baseline means the surface shrank. The gate
  // must not lower its floor because a CodeGraph release got smaller: the
  // baseline is the number the ceiling was set against.
  const floor = baseline?.totalTokens ?? 0;
  return {
    available: true,
    estimated: false,
    tools,
    totalTokens: Math.max(totalTokens, floor),
    bytes: list.bytes,
    reason: totalTokens < floor ? `the live catalog (${totalTokens}) is below the baseline (${floor}); the baseline was used` : null,
  };
}

/**
 * The committed CodeGraph catalog baseline.
 *
 * @returns {{totalTokens: number, tools: string[]}|null}
 */
function readCodegraphBaseline() {
  const path = join(SCRIPT_DIR, 'codegraph-catalog.baseline.json');
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return typeof data.totalTokens === 'number' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Ask an EXTERNAL MCP server for its tools over stdio.
 *
 * @param {string} bin the executable
 * @param {string[]} args its arguments
 * @param {Record<string, string|undefined>} env extra environment
 * @returns {Promise<{ok: boolean, tools: any[], bytes: number, reason?: string}>}
 */
function listMcpToolsExternal(bin, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let buffer = '';
    const pending = new Map();
    let nextId = 1;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolvePromise(result);
    };
    const timer = setTimeout(() => finish({ ok: false, tools: [], bytes: 0, reason: 'the server did not answer tools/list in time' }), 20000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });
    const call = (method, params) => new Promise((res) => {
      const id = nextId++;
      pending.set(id, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    child.on('error', (e) => finish({ ok: false, tools: [], bytes: 0, reason: e.message }));
    (async () => {
      const init = await call('initialize', {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'archgen-context-budget', version: '1.0.0' },
      });
      if (!init.result) {
        finish({ ok: false, tools: [], bytes: 0, reason: 'the server did not initialize' });
        return;
      }
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      const listed = await call('tools/list', {});
      const tools = listed.result?.tools ?? [];
      finish({ ok: true, tools, bytes: JSON.stringify(tools).length });
    })();
  });
}

/** Locate an executable on PATH. */
function which(bin) {
  const dirs = String(process.env.PATH ?? '').split(':').filter(Boolean);
  for (const d of dirs) {
    const p = join(d, bin);
    try { if (existsSync(p)) return p; } catch { /* not here */ }
  }
  return null;
}

// --- report ------------------------------------------------------------------
// --- ON-DEMAND CONTENT -------------------------------------------------------
//
// The always-on total is what a session PAYS. The on-demand content is what
// it CAN pay — the protocol references, the dispatch briefs and the artifact
// templates, all of which are read a section or a file at a time, never
// whole.
//
// THE MEDIAN SECTION is the number that matters: an agent pulls ONE `§`, so
// the cost of the pull is the size of that section. It is measured over the
// same span the SERVER serves — a level-2 section runs to the next level-2
// heading — so the figure describes what `archgen_refs{action:'read'}`
// actually returns, not a hand-counted approximation.
//
// It is here because the README quotes it. A quoted number with no tool
// behind it goes stale the moment anything changes, and a stale token figure
// is worse than none: it is a claim the reader cannot check.

/**
 * Measure the on-demand content: the protocol references and their sections,
 * the dispatch briefs and the artifact templates.
 *
 * @param {string} mcpDir the packages/mcp directory
 * @returns {{available: boolean, references: object, briefs: object, templates: object}}
 */
function auditOnDemand(mcpDir) {
  const refsDir = join(mcpDir, 'assets', 'references');
  const briefsDir = join(mcpDir, 'assets', 'briefs');
  const templatesDir = join(mcpDir, 'assets', 'templates');
  const list = (dir, exts) =>
    existsSync(dir) ? readdirSync(dir).filter((f) => exts.some((e) => f.endsWith(e))).sort() : [];

  const referenceFiles = list(refsDir, ['.md']);
  let referenceTokens = 0;
  const sectionTokens = [];
  for (const file of referenceFiles) {
    const text = readFileSync(join(refsDir, file), 'utf8');
    referenceTokens += estimateTokens(text);
    const lines = text.split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('## ')) continue;
      if (start >= 0) sectionTokens.push(estimateTokens(lines.slice(start, i).join('\n')));
      start = i;
    }
    if (start >= 0) sectionTokens.push(estimateTokens(lines.slice(start).join('\n')));
  }
  sectionTokens.sort((a, b) => a - b);
  const mid = Math.floor(sectionTokens.length / 2);
  const medianSection = sectionTokens.length
    ? sectionTokens.length % 2
      ? sectionTokens[mid]
      : Math.round((sectionTokens[mid - 1] + sectionTokens[mid]) / 2)
    : 0;

  const sum = (dir, files) =>
    files.reduce((n, f) => n + estimateTokens(readFileSync(join(dir, f), 'utf8')), 0);

  const briefFiles = list(briefsDir, ['.md']);
  const templateFiles = list(templatesDir, ['.md', '.yaml']);
  return {
    available: referenceFiles.length > 0,
    references: {
      files: referenceFiles.length,
      totalTokens: referenceTokens,
      sections: sectionTokens.length,
      medianSectionTokens: medianSection,
    },
    briefs: { files: briefFiles.length, totalTokens: sum(briefsDir, briefFiles) },
    templates: { files: templateFiles.length, totalTokens: sum(templatesDir, templateFiles) },
  };
}

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

const mcpDir = resolve(opts.mcpDir ?? join(SCRIPT_DIR, '..', '..', '..', 'packages', 'mcp'));
const skill = skillDir ? await auditSkill(mcpDir) : null;
const catalog = await auditCatalog(mcpDir);
const wireCatalog = await auditWireCatalog(mcpDir);
const codegraphCatalog = await auditCodegraphCatalog(mcpDir);
const onDemand = auditOnDemand(mcpDir);
const projectRoot = opts.project ? resolve(opts.project) : process.cwd();
const artifacts = await auditArtifacts(projectRoot, opts.slug);

// Scenarios combine the skill side with the artifact side.
const scenarios = [];
if (skill) {
  for (const s of skill.scenarios) scenarios.push(s);
}
if (catalog.available) {
  scenarios.push({
    id: 'mcp-catalog',
    label: 'MCP tool catalog (injected into EVERY request)',
    tokens: catalog.totalTokens,
    note: `${catalog.tools.length} tools — the permanent context tax`,
  });
}
if (wireCatalog.available) {
  scenarios.push({
    id: 'mcp-wire-catalog',
    label: 'MCP tool catalog — the REAL tools/list payload',
    tokens: wireCatalog.totalTokens,
    note: `${wireCatalog.tools.length} tools — what the protocol actually carries`,
  });
}
if (codegraphCatalog.available) {
  scenarios.push({
    id: 'codegraph-catalog',
    label: 'CodeGraph tool catalog (the OTHER server, when wired)',
    tokens: codegraphCatalog.totalTokens,
    note: `${codegraphCatalog.tools.length} tools — the curated CodeGraph surface`,
  });
}
// The ALWAYS-ON figure is the WIRE one: it is what a client injects, and it
// is the number the ceiling is checked against. The projection stays in the
// report for comparison.
const alwaysOnTokens = skill && wireCatalog.available
  ? skill.scenarios[0].tokens + wireCatalog.totalTokens + codegraphCatalog.totalTokens
  : skill && catalog.available
    ? skill.scenarios[0].tokens + catalog.totalTokens + codegraphCatalog.totalTokens
    : null;
if (alwaysOnTokens !== null) {
  scenarios.push({
    id: 'always-on',
    label: 'ALWAYS-ON: SKILL.md + the tool catalogs the client injects',
    tokens: alwaysOnTokens,
    note: 'what the agent pays before it does anything',
  });
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

// The ALWAYS-ON gate: what the agent pays before it does anything (the
// skill prompt + the MCP tool catalog) is the number that actually decides
// whether this design is token-efficient. It has a hard ceiling.
//
// The catalog is the LARGER of the two terms, so a catalog that cannot be
// measured leaves the number unknown — and an unknown number must NOT pass a
// ceiling. The gate failed open: a missing dependency or a broken server
// import turned the largest always-on term into zero and the budget job
// went green.
const alwaysOn = scenarios.find((s) => s.id === 'always-on');
const alwaysOnOver = opts.maxAlwaysOn !== null && alwaysOn !== undefined && alwaysOn.tokens > opts.maxAlwaysOn;
// An UNMEASURED always-on term must not pass a ceiling. The CodeGraph
// catalog is one of those terms: a CI runner has no codegraph installed, so
// without the committed baseline the third term would silently read zero and
// the gate would check the ceiling against a number that is 3,796 tokens
// short of the truth.
const alwaysOnUnmeasured =
  opts.maxAlwaysOn !== null && (alwaysOn === undefined || !codegraphCatalog.available);

const report = {
  generator: 'archgen context-budget',
  tokenModel: opts.tokenizer ? `exact:${opts.tokenizer}` : 'estimator (±10%)',
  windows: opts.windows,
  budget: opts.budget,
  maxAlwaysOn: opts.maxAlwaysOn,
  alwaysOn: alwaysOn ? { tokens: alwaysOn.tokens, over: alwaysOnOver } : null,
  catalog: {
    available: catalog.available,
    reason: catalog.reason ?? null,
    totalTokens: catalog.totalTokens,
    bytes: catalog.bytes,
    tools: catalog.tools,
  },
  wireCatalog: {
    available: wireCatalog.available,
    reason: wireCatalog.reason ?? null,
    totalTokens: wireCatalog.totalTokens,
    bytes: wireCatalog.bytes,
    tools: wireCatalog.tools,
  },
  codegraphCatalog: {
    available: codegraphCatalog.available,
    estimated: codegraphCatalog.estimated === true,
    reason: codegraphCatalog.reason ?? null,
    totalTokens: codegraphCatalog.totalTokens,
    bytes: codegraphCatalog.bytes,
    tools: codegraphCatalog.tools,
  },
  onDemand,
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
  // SYNCHRONOUS: a large report written to a pipe can lose its tail when the
  // process exits on Node 20, and a truncated JSON report is a report nobody
  // can read — and one the gate cannot check.
  writeOut(JSON.stringify(report, null, 2));
} else {
  const line = (s = '-') => writeOut(s);
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

  if (catalog.available) {
    line('MCP TOOL CATALOG (name + description + input schema)');
    line(`  total ${fmtTokens(catalog.totalTokens)} tokens across ${catalog.tools.length} tools`);
    for (const t of [...catalog.tools].sort((a, b) => b.tokens - a.tokens)) {
      line(`    ${String(t.tokens).padStart(8)}  ${t.name}`);
    }
    line();
  } else if (catalog.reason) {
    line(`MCP TOOL CATALOG — not measured: ${catalog.reason}`);
    line();
  }

  if (wireCatalog.available) {
    line('MCP WIRE CATALOG (the REAL tools/list payload a client injects)');
    line(`  total ${fmtTokens(wireCatalog.totalTokens)} tokens across ${wireCatalog.tools.length} tools`);
    for (const t of [...wireCatalog.tools].sort((a, b) => b.tokens - a.tokens)) {
      line(`    ${String(t.tokens).padStart(8)}  ${t.name}`);
    }
    line();
  } else if (wireCatalog.reason) {
    line(`MCP WIRE CATALOG — not measured: ${wireCatalog.reason}`);
    line();
  }

  if (codegraphCatalog.available) {
    line('CODEGRAPH TOOL CATALOG (the other server, when it is wired)');
    line(`  total ${fmtTokens(codegraphCatalog.totalTokens)} tokens across ${codegraphCatalog.tools.length} tools${codegraphCatalog.estimated ? ' (baseline — the CLI is not installed here)' : ''}`);
    for (const t of [...codegraphCatalog.tools].sort((a, b) => b.tokens - a.tokens)) {
      line(`    ${String(t.tokens).padStart(8)}  ${t.name}`);
    }
    line();
  } else if (codegraphCatalog.reason) {
    line(`CODEGRAPH TOOL CATALOG — not measured: ${codegraphCatalog.reason}`);
    line();
  }

  if (onDemand.available) {
    line('ON-DEMAND CONTENT (pulled a section or a file at a time)');
    line(
      `  protocol references: ${fmtTokens(onDemand.references.totalTokens)} tokens across ${onDemand.references.files} files`,
    );
    line(
      `  a typical section   : ${fmtTokens(onDemand.references.medianSectionTokens)} tokens (median of ${onDemand.references.sections} sections)`,
    );
    line(`  dispatch briefs     : ${fmtTokens(onDemand.briefs.totalTokens)} tokens across ${onDemand.briefs.files} briefs`);
    line(`  artifact templates  : ${fmtTokens(onDemand.templates.totalTokens)} tokens across ${onDemand.templates.files} templates`);
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

  if (alwaysOnUnmeasured) {
    writeErr(
      'context-budget: the ALWAYS-ON cost could not be measured, so the ceiling cannot be checked.\n' +
      '  The MCP tool catalog is the larger of the two always-on terms; without it the\n' +
      '  number is unknown, and an unknown number must not pass a ceiling.\n' +
      `  ${catalog.reason ?? 'the catalog was not measured'}`,
    );
    process.exit(1);
  }
}

if (overBudget.length || alwaysOnOver) process.exit(1);
