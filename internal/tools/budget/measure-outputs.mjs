// measure-outputs.mjs — what does every tool action actually RETURN?
//
// WHY: the token story of archgen rests on "the agent never reads a whole
// file". That is a claim about OUTPUTS, not about the prose that describes
// them — so it has to be measured on the real payloads the server returns.
//
// This drives the real binary (the same facade the fixtures use) against a
// realistic artifact tree, and reports for every tool action:
//   - the payload size in bytes and tokens
//   - the LARGEST embedded text (the "big English" an agent would read)
//   - whether that text is PROSE (a prompt / document) or DATA (a map)
//
// A prose payload is a context cost every time it is called. A data payload
// is a map the agent reads once and navigates. The two are not the same, and
// only this measurement tells them apart.
//
//   node internal/tools/budget/measure-outputs.mjs [--json]
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from './tokens.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const MCP = join(REPO, 'packages', 'mcp', 'bin', 'archgen-mcp.mjs');
const FIXTURE = join(REPO, 'fixtures', 'greenfield-demo');

/** Build a sandbox project with a realistic `.archgen/<slug>/` artifact tree. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'archgen-measure-'));
  cpSync(FIXTURE, dir, { recursive: true });
  const slug = join(dir, '.archgen', 'demo');
  mkdirSync(join(slug, 'plans'), { recursive: true });
  mkdirSync(join(slug, 'docs'), { recursive: true });
  cpSync(join(FIXTURE, 'plans', 'demo-platform.md'), join(slug, 'plans', 'demo.md'));
  cpSync(join(FIXTURE, 'docs', 'c4-context.md'), join(slug, 'docs', 'context.md'));
  cpSync(join(FIXTURE, 'architecture.template.yaml'), join(slug, 'architecture.yaml'));
  cpSync(join(FIXTURE, 'answers.yaml'), join(slug, 'answers.yaml'));
  return dir;
}

/** The biggest string anywhere in a JSON value, with where it came from. */
function largestText(value, path = '') {
  let best = { bytes: 0, path: '', text: '' };
  if (typeof value === 'string') {
    if (value.length > best.bytes) best = { bytes: value.length, path, text: value };
    return best;
  }
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const found = largestText(v, `${path}[${i}]`);
      if (found.bytes > best.bytes) best = found;
    }
    return best;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const found = largestText(v, path ? `${path}.${k}` : k);
      if (found.bytes > best.bytes) best = found;
    }
  }
  return best;
}

/** Is this text PROSE (sentences, instructions) or DATA (a map, a list, ids)? */
function classify(text) {
  if (!text) return 'none';
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 3) return 'data';
  const proseish = lines.filter((l) => /[.!?](\s|$)/.test(l) && l.length > 60).length;
  if (proseish / lines.length > 0.25) return 'PROSE';
  if (/^\s*[-|#]|^\s*\d+\.|^\s*\|/.test(text)) return 'data';
  return 'mixed';
}

/**
 * Find the SAME text delivered twice in one payload — either the same string
 * at two paths, or one string contained in a bigger one.
 *
 * This is the measurable form of "the output repeats itself": the tool says
 * the same thing twice, and the agent pays for both copies.
 */
function redundancies(value) {
  const strings = [];
  const walk = (v, path) => {
    if (typeof v === 'string') strings.push({ path, text: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    }
  };
  walk(value, '');
  const out = [];
  for (let i = 0; i < strings.length; i++) {
    for (let j = i + 1; j < strings.length; j++) {
      const a = strings[i];
      const b = strings[j];
      if (a.text.length < 40 || b.text.length < 40) continue;
      if (a.text === b.text) out.push({ a: a.path, b: b.path, bytes: a.text.length, kind: 'identical' });
      else if (a.text.includes(b.text)) out.push({ a: a.path, b: b.path, bytes: b.text.length, kind: 'contained' });
      else if (b.text.includes(a.text)) out.push({ a: a.path, b: b.path, bytes: a.text.length, kind: 'contained' });
    }
  }
  return out.sort((x, y) => y.bytes - x.bytes);
}

const dir = sandbox();
const TASKS = join(dir, '.archgen', 'demo', 'tasks.yaml');
const PLANS = join(dir, '.archgen', 'demo', 'plans');
const SLUGDIR = join(dir, '.archgen', 'demo');

const CALLS = [
  ['archgen_plan', { action: 'validate', tasksYaml: TASKS }],
  ['archgen_plan', { action: 'verify', tasksYaml: TASKS, planDir: PLANS }],
  ['archgen_plan', { action: 'graph', tasksYaml: TASKS }],
  ['archgen_plan', { action: 'graph', tasksYaml: TASKS, format: 'mermaid', status: true }],
  ['archgen_plan', { action: 'impact', tasksYaml: TASKS, target: 'API' }],
  ['archgen_plan', { action: 'coverage', tasksYaml: TASKS, planDir: PLANS }],
  ['archgen_plan', { action: 'scaffold', scope: 'LARGE', slug: 'demo' }],
  ['archgen_plan', { action: 'brief', kind: 'verifier', tasksYaml: TASKS }],
  ['archgen_plan', { action: 'brief', kind: 'review', tasksYaml: TASKS }],
  ['archgen_plan', { action: 'brief', kind: 'survey', slug: 'demo', featureRequest: 'a notes app' }],
  ['archgen_plan', { action: 'brief', kind: 'investigate', slug: 'demo', topic: 'auth', round: 1 }],
  ['archgen_tasks', { action: 'next', tasksYaml: TASKS }],
  ['archgen_tasks', { action: 'list', tasksYaml: TASKS }],
  ['archgen_tasks', { action: 'snapshot', tasksYaml: TASKS }],
  ['archgen_tasks', { action: 'contract', tasksYaml: TASKS, taskId: 'API' }],
  ['archgen_tasks', { action: 'set_status', tasksYaml: TASKS, taskId: 'API', status: 'running' }],
  ['archgen_docs', { action: 'index', slugDir: SLUGDIR }],
  ['archgen_docs', { action: 'digest', slugDir: SLUGDIR }],
  ['archgen_docs', { action: 'validate', slugDir: SLUGDIR }],
  ['archgen_docs', { action: 'map', token: 'API', slugDir: SLUGDIR }],
  ['archgen_docs', { action: 'refs', token: 'API', slugDir: SLUGDIR }],
  ['archgen_docs', { action: 'section', section: 'context', slugDir: SLUGDIR }],
  ['archgen_registry', { action: 'show' }],
  ['archgen_registry', { action: 'update', slug: 'demo', status: 'planned' }],
  ['archgen_codegraph', { action: 'status' }],
  ['archgen_codegraph', { action: 'wire' }],
  ['archgen_codegraph', { action: 'ensure' }],
  ['archgen_setup', { action: 'doctor' }],
  ['archgen_setup', { action: 'harnesses' }],
  ['archgen_setup', { action: 'install_mcp' }],
  ['archgen_setup', { action: 'uninstall_mcp' }],
  ['archgen_skills', { action: 'list' }],
  ['archgen_skills', { action: 'match', title: 'Redesign the checkout UI', fileOwnership: ['src/features/checkout/**'] }],
  ['archgen_skills', { action: 'installed' }],
  ['archgen_skills', { action: 'digest', skillId: 'fixing-motion-performance' }],
  ['archgen_skills', { action: 'load', skillId: 'fixing-motion-performance' }],
  ['archgen_skills', { action: 'install', skillId: 'fixing-motion-performance' }],
  ['archgen_refs', { action: 'list' }],
  ['archgen_refs', { action: 'index', topic: 'orchestration' }],
  ['archgen_refs', { action: 'read', topic: 'orchestration', section: 'dispatch--wave-execution' }],
  ['archgen_refs', { action: 'read', topic: 'orchestration' }],
  ['archgen_refs', { action: 'search', topic: 'orchestration', token: 'APPROVE' }],
  ['archgen_help', { topic: 'all' }],
  ['archgen_help', { topic: 'plan' }],
  ['archgen_help', { topic: 'tasks' }],
  ['archgen_help', { topic: 'docs' }],
  ['archgen_help', { topic: 'registry' }],
  ['archgen_help', { topic: 'codegraph' }],
  ['archgen_help', { topic: 'setup' }],
  ['archgen_help', { topic: 'platform' }],
  ['archgen_help', { topic: 'skills' }],
  ['archgen_help', { topic: 'refs' }],
  ['archgen_help', { topic: 'yaml' }],
  ['archgen_platform', {}],
];

const rows = [];
for (const [tool, args] of CALLS) {
  const r = spawnSync(process.execPath, [MCP, 'exec', tool, JSON.stringify(args), '--project', dir], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = r.stdout ?? '';
  let parsed = null;
  try {
    parsed = JSON.parse(out);
  } catch {
    /* leave null */
  }
  const data = parsed?.data;
  const big = largestText(data);
  const dupes = redundancies(data);
  rows.push({
    tool,
    action: args.action ?? args.topic ?? '—',
    ok: parsed?.ok === true,
    bytes: Buffer.byteLength(out),
    tokens: estimateTokens(out),
    biggestBytes: big.bytes,
    biggestAt: big.path,
    kind: classify(big.text),
    dupes: dupes.slice(0, 3).map((d) => `${d.kind}:${d.a}~${d.b}(${d.bytes})`),
    dupeBytes: dupes.reduce((n, d) => n + d.bytes, 0),
    head: big.text.slice(0, 90).replace(/\s+/g, ' '),
    error: parsed?.ok === false ? parsed.error?.message?.slice(0, 80) : undefined,
  });
}

rmSync(dir, { recursive: true, force: true });

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('tool                action        bytes    tokens  biggest  kind   where');
  console.log('------------------- ------------- ------- -------- ------- ------ -----');
  for (const r of rows.sort((a, b) => b.bytes - a.bytes)) {
    console.log(
      `${r.tool.padEnd(19)} ${String(r.action).padEnd(13)} ${String(r.bytes).padStart(7)} ${String(r.tokens).padStart(8)} ` +
        `${String(r.biggestBytes).padStart(7)} ${r.kind.padEnd(6)} ${r.biggestAt}`,
    );
  }
  console.log('');
  const prose = rows.filter((r) => r.kind === 'PROSE');
  console.log(`PROSE payloads (${prose.length}/${rows.length}) — every call pays for the whole block:`);
  for (const p of prose.sort((a, b) => b.biggestBytes - a.biggestBytes)) {
    console.log(`  ${p.tool}{action:'${p.action}'}  ${p.tokens} tokens  ${p.biggestAt}`);
  }
  const dupes = rows.filter((r) => r.dupeBytes > 0).sort((a, b) => b.dupeBytes - a.dupeBytes);
  console.log('');
  console.log(`REDUNDANT payloads (${dupes.length}/${rows.length}) — the same text delivered twice:`);
  for (const d of dupes) {
    console.log(`  ${d.tool}{action:'${d.action}'}  ${d.dupeBytes} duplicated bytes`);
    for (const x of d.dupes) console.log(`      ${x}`);
  }
}
