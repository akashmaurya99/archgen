// registry-updater.mjs — keeps the AGENTS.md features registry in sync with .archgen/.
//
// Extracted verbatim from skill/scripts/update-agents.mjs (deleted in the
// MCP-first cutover). The registry is machine-maintained: it is rewritten
// between the <!-- archgen:features:start --> / <!-- archgen:features:end -->
// markers, preserving every byte outside the block (BOM and CRLF line endings
// included). A missing AGENTS.md gets a minimal scaffold; an existing file
// without markers gets them appended. Rows whose feature folder disappeared
// are pruned. Writes atomically via temp + rename.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { invalidInput } from './errors.mjs';
import { writeFileAtomic } from './fs-safety.mjs';

export const START_MARKER = '<!-- archgen:features:start -->';
export const END_MARKER = '<!-- archgen:features:end -->';
export const HEADER = '| Feature | Status | Updated |';
export const SEPARATOR = '| --- | --- | --- |';
export const DISPLAY_STATUSES = ['planned', 'in progress', 'done', 'blocked', 'unknown'];
// Task-level statuses the status mutator may write; anything else in tasks.yaml
// means the file is not a contract we can read -> row falls back to unknown.
const TASK_STATUSES = new Set(['pending', 'ready', 'running', 'blocked', 'done', 'failed']);

/** Date -> YYYY-MM-DD (local time, zero-padded). */
function fmtDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Derive the one-word registry status from a parsed tasks.yaml `tasks`
 * sequence. Precedence: unreadable -> unknown; any blocked -> blocked; all
 * failed -> blocked (dead work is never "in progress"); all done -> done;
 * all pending/ready -> planned; everything else -> in progress.
 * @param {unknown} tasks
 * @returns {string}
 */
export function deriveStatus(tasks) {
  if (!Array.isArray(tasks)) return 'unknown';
  const statuses = [];
  for (const t of tasks) {
    if (t === null || typeof t !== 'object' || Array.isArray(t)) return 'unknown';
    const s = String(t.status ?? 'pending').trim().toLowerCase();
    if (!TASK_STATUSES.has(s)) return 'unknown';
    statuses.push(s);
  }
  if (statuses.length === 0) return 'planned'; // scaffolded folder, no entries yet
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.every((s) => s === 'failed')) return 'blocked'; // all-failed feature: nothing progresses
  if (statuses.every((s) => s === 'done')) return 'done';
  if (statuses.every((s) => s === 'pending' || s === 'ready')) return 'planned';
  return 'in progress';
}

/**
 * Scan `<project>/.archgen/<slug>/tasks.yaml` and derive one registry row per feature.
 * @param {string} projectRoot
 * @returns {Map<string, {feature: string, status: string, updated: string}>}
 */
export function scanFeatures(projectRoot) {
  const archgenDir = join(projectRoot, '.archgen');
  const rows = new Map();
  if (!existsSync(archgenDir)) return rows;
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
  return rows;
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

/**
 * Refresh the AGENTS.md features registry.
 *
 * @param {string} projectRoot absolute project root
 * @param {{slug?: string|null, status?: string|null}} [opts] slug+status upsert one row
 * @returns {{updated: boolean, banner: string, notes: string[], rows: Array<{feature: string, status: string, updated: string}>, file: string}}
 */
export function updateRegistry(projectRoot, opts = {}) {
  const slug = opts.slug ?? null;
  const status = opts.status ?? null;

  if ((slug === null) !== (status === null)) {
    throw invalidInput('slug and status must be passed together', { slug, status });
  }
  if (status !== null && !DISPLAY_STATUSES.includes(status)) {
    throw invalidInput(`invalid status '${status}' (allowed: ${DISPLAY_STATUSES.join('|')})`, { status });
  }
  if (slug !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
    throw invalidInput(`invalid slug '${slug}' (start alphanumeric; then letters, digits, '.', '_', '-')`, { slug });
  }

  const archgenDir = join(projectRoot, '.archgen');
  if (!existsSync(archgenDir)) {
    throw invalidInput(`no .archgen/ directory under ${projectRoot} — nothing to register (generate a plan first)`, {
      projectRoot,
    });
  }

  const rows = scanFeatures(projectRoot);

  // Upsert override (run right after generating).
  if (slug !== null) {
    const existing = rows.get(slug);
    if (existing) existing.status = status;
    else rows.set(slug, { feature: slug, status, updated: fmtDate(new Date()) });
  }

  const ordered = [...rows.values()].sort((a, b) => (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));

  const renderTable = (eol) => {
    const lines = [HEADER, SEPARATOR, ...ordered.map((r) => `| ${r.feature} | ${r.status} | ${r.updated} |`)];
    return lines.join(eol) + eol;
  };

  const agentsPath = join(projectRoot, 'AGENTS.md');
  let raw = null;
  try {
    raw = readFileSync(agentsPath, 'utf8');
  } catch {
    /* missing -> scaffold below */
  }
  const oldRows = raw === null ? new Map() : (oldRowsFrom(raw) ?? new Map());

  let out;
  let banner;
  if (raw === null) {
    // Missing AGENTS.md: minimal scaffold — H1, pointer paragraph, markers+table.
    banner = `created ${agentsPath}`;
    out =
      '# Agent Guide\n' +
      '\n' +
      'This project uses the archgen skill at `.agents/skills/archgen/SKILL.md` for architecture generation and autonomous task execution.\n' +
      '\n' +
      START_MARKER +
      '\n' +
      renderTable('\n') +
      END_MARKER +
      '\n';
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
      throw invalidInput(`${agentsPath}: found ${START_MARKER} but no ${END_MARKER} — repair the markers by hand`, {
        file: agentsPath,
      });
    }
    banner = `updated features registry in ${agentsPath}`;
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    out = raw.slice(0, si + START_MARKER.length) + eol + renderTable(eol) + raw.slice(ei);
  }

  // Human summary.
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
  if (unchanged) notes.push(`unchanged: ${unchanged}`);

  writeFileAtomic(agentsPath, out);

  return {
    updated: true,
    banner,
    notes,
    rows: ordered,
    file: agentsPath,
  };
}

/**
 * Read the current registry rows without writing anything.
 * @param {string} projectRoot
 * @returns {{rows: Array<{feature: string, status: string, updated: string}>, hasMarkers: boolean}}
 */
export function showRegistry(projectRoot) {
  const agentsPath = join(projectRoot, 'AGENTS.md');
  let raw = null;
  try {
    raw = readFileSync(agentsPath, 'utf8');
  } catch {
    /* absent */
  }
  if (raw === null) return { rows: [], hasMarkers: false };
  const old = oldRowsFrom(raw);
  return {
    rows: old ? [...old.entries()].map(([feature, v]) => ({ feature, status: v.status, updated: v.updated })) : [],
    hasMarkers: raw.includes(START_MARKER) && raw.includes(END_MARKER),
  };
}
