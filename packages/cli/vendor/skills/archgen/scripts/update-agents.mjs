#!/usr/bin/env node
// update-agents.mjs — keeps the AGENTS.md features registry in sync with .archgen/.
// Usage: node update-agents.mjs <projectRoot> [--slug <s>] [--status <s>] [--prune]
// Scans .archgen/*/tasks.yaml and rewrites the table between the
// <!-- archgen:features:start --> / <!-- archgen:features:end --> markers in
// <projectRoot>/AGENTS.md, preserving every byte outside the block (BOM and
// CRLF line endings included). A missing AGENTS.md gets a minimal scaffold; an
// existing file without markers gets them appended. Rows whose feature folder
// disappeared are pruned by default (--prune is accepted as the explicit
// no-op spelling of the same behavior). Writes atomically via temp + rename.
// Exit codes: 0 ok · 2 no .archgen/ dir · 4 usage/IO/marker errors.
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './lib/yaml.mjs';

const START_MARKER = '<!-- archgen:features:start -->';
const END_MARKER = '<!-- archgen:features:end -->';
const HEADER = '| Feature | Status | Updated |';
const SEPARATOR = '| --- | --- | --- |';
const DISPLAY_STATUSES = ['planned', 'in progress', 'done', 'blocked', 'unknown'];
// Task-level statuses set-status.mjs may write; anything else in tasks.yaml
// means the file is not a contract we can read -> row falls back to unknown.
const TASK_STATUSES = new Set(['pending', 'ready', 'running', 'blocked', 'done', 'failed']);

// ---- arguments ------------------------------------------------------------
const [projectRoot, ...flags] = process.argv.slice(2);
let slug = null;
let status = null;
let pruneFlag = false; // pruning is always on; the flag just makes it explicit
for (let i = 0; i < flags.length; i++) {
  const arg = flags[i];
  if (arg === '--slug' || arg === '--status') {
    const value = flags[++i];
    if (value === undefined) { console.error(`${arg} requires a value`); process.exit(4); }
    if (arg === '--slug') slug = value;
    else status = value;
  } else if (arg === '--prune') {
    pruneFlag = true;
  } else {
    console.error(`unknown argument '${arg}'`);
    process.exit(4);
  }
}
if (!projectRoot) {
  console.error('usage: update-agents.mjs <projectRoot> [--slug <s>] [--status <s>] [--prune]');
  process.exit(4);
}
if ((slug === null) !== (status === null)) {
  console.error('--slug and --status must be passed together');
  process.exit(4);
}
if (status !== null && !DISPLAY_STATUSES.includes(status)) {
  console.error(`invalid status '${status}' (allowed: ${DISPLAY_STATUSES.join('|')})`);
  process.exit(4);
}
if (slug !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
  console.error(`invalid slug '${slug}' (start alphanumeric; then letters, digits, '.', '_', '-')`);
  process.exit(4);
}

// ---- scan .archgen/*/tasks.yaml -------------------------------------------
const archgenDir = join(projectRoot, '.archgen');
if (!existsSync(archgenDir)) {
  console.error(`no .archgen/ directory under ${projectRoot} — nothing to register (generate a plan first)`);
  process.exit(2);
}

/** Date -> YYYY-MM-DD (local time, zero-padded). */
function fmtDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Derive the one-word registry status from a parsed tasks.yaml `tasks`
 * sequence. Precedence: unreadable -> unknown; any blocked -> blocked; all
 * done -> done; all pending/ready -> planned; everything else (any running,
 * or a done/pending/failed mix) -> in progress.
 */
function deriveStatus(tasks) {
  if (!Array.isArray(tasks)) return 'unknown';
  const statuses = [];
  for (const t of tasks) {
    if (t === null || typeof t !== 'object' || Array.isArray(t)) return 'unknown';
    const s = String(t.status ?? 'pending').trim().toLowerCase(); // SKILL.md leaves status unset until wave resolution
    if (!TASK_STATUSES.has(s)) return 'unknown';
    statuses.push(s);
  }
  if (statuses.length === 0) return 'planned'; // scaffolded folder, no entries yet
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.every((s) => s === 'done')) return 'done';
  if (statuses.every((s) => s === 'pending' || s === 'ready')) return 'planned';
  return 'in progress';
}

/** @type {Map<string, {feature: string, status: string, updated: string}>} */
const rows = new Map();
for (const ent of readdirSync(archgenDir, { withFileTypes: true })) {
  if (!ent.isDirectory()) continue;
  const tasksPath = join(archgenDir, ent.name, 'tasks.yaml');
  if (!existsSync(tasksPath)) continue; // the scan target is exactly */tasks.yaml
  let derived = 'unknown';
  try {
    const { data } = parseYaml(readFileSync(tasksPath, 'utf8'), { filename: tasksPath });
    derived = deriveStatus(data?.tasks);
  } catch {
    derived = 'unknown'; // unparseable YAML is data about the feature, not a crash
  }
  rows.set(ent.name, { feature: ent.name, status: derived, updated: fmtDate(statSync(tasksPath).mtime) });
}

// ---- upsert override (--slug/--status, run right after generating) --------
if (slug !== null) {
  const existing = rows.get(slug);
  if (existing) existing.status = status;
  else rows.set(slug, { feature: slug, status, updated: fmtDate(new Date()) });
}

const ordered = [...rows.values()].sort((a, b) => (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));

// ---- render -----------------------------------------------------------------
function renderTable(eol) {
  const lines = [HEADER, SEPARATOR, ...ordered.map((r) => `| ${r.feature} | ${r.status} | ${r.updated} |`)];
  return lines.join(eol) + eol;
}

/** Parse the CURRENT registry rows out of an existing AGENTS.md (or null). */
function oldRowsFrom(raw) {
  const si = raw.indexOf(START_MARKER);
  if (si === -1) return null;
  const ei = raw.indexOf(END_MARKER, si + START_MARKER.length);
  if (ei === -1) return null;
  const old = new Map();
  for (const line of raw.slice(si + START_MARKER.length, ei).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|') || t === HEADER || t === SEPARATOR) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (!cells[0]) continue;
    old.set(cells[0], { status: cells[1] ?? '', updated: cells[2] ?? '' });
  }
  return old;
}

const agentsPath = join(projectRoot, 'AGENTS.md');
let raw = null;
try { raw = readFileSync(agentsPath, 'utf8'); } catch { /* missing -> scaffold below */ }
const oldRows = raw === null ? new Map() : (oldRowsFrom(raw) ?? new Map());

let out;
let banner;
if (raw === null) {
  // Missing AGENTS.md: minimal scaffold — H1, pointer paragraph, markers+table.
  banner = `created ${agentsPath}`;
  out = '# Agent Guide\n'
    + '\n'
    + 'This project uses the archgen skill at `.agents/skills/archgen/SKILL.md` for architecture generation and autonomous task execution.\n'
    + '\n'
    + START_MARKER + '\n'
    + renderTable('\n')
    + END_MARKER + '\n';
} else if (!raw.includes(START_MARKER)) {
  // Existing user file: append newline + markers + table; prior bytes untouched.
  banner = `appended features registry to ${agentsPath}`;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  out = raw + eol + START_MARKER + eol + renderTable(eol) + END_MARKER + '\n';
} else {
  // Markers present: replace ONLY the span between them; every outside byte
  // (BOM, prose, trailing sections, CRLF endings) survives verbatim.
  const si = raw.indexOf(START_MARKER);
  const ei = raw.indexOf(END_MARKER, si + START_MARKER.length);
  if (ei === -1) {
    console.error(`${agentsPath}: found ${START_MARKER} but no ${END_MARKER} — repair the markers by hand`);
    process.exit(4);
  }
  banner = `updated features registry in ${agentsPath}`;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  out = raw.slice(0, si + START_MARKER.length) + eol + renderTable(eol) + raw.slice(ei);
}

// ---- human summary ----------------------------------------------------------
const notes = [];
for (const feature of oldRows.keys()) {
  if (!rows.has(feature)) notes.push(`pruned: ${feature} (missing .archgen/${feature}/tasks.yaml)`);
}
let unchanged = 0;
for (const r of ordered) {
  const prev = oldRows.get(r.feature);
  if (!prev) notes.push(`added: ${r.feature} (${r.status})`);
  else if (prev.status !== r.status) notes.push(`updated: ${r.feature} (${prev.status || '?'} -> ${r.status})`);
  else if (prev.updated !== r.updated) notes.push(`updated: ${r.feature} (${r.updated})`);
  else unchanged++;
}

const tmp = `${agentsPath}.tmp-${process.pid}-${Date.now()}`;
writeFileSync(tmp, out);
renameSync(tmp, agentsPath); // atomic on POSIX: readers observe old-or-new, never partial

console.log(banner);
for (const n of notes) console.log(n);
if (unchanged) console.log(`unchanged: ${unchanged}`);
console.log(`registry: ${ordered.length} feature${ordered.length === 1 ? '' : 's'}`);
