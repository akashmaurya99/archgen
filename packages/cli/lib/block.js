// block.js — managed-block writer for AGENTS.md / CLAUDE.md context pointers.
//
// WHY marked blocks: installers must never clobber user content. Everything
// archgen writes lives between START/END markers; re-runs replace the block
// in place, uninstalls strip it, and anything the user wrote outside the
// markers is untouched.
//
// AGENTS.md carries the full pointer block with an embedded features registry
// (between FEATURES_START/FEATURES_END). CLAUDE.md carries a one-line
// `@AGENTS.md` bridge inside the same managed markers.
//
// Block provenance: the FIRST line inside every managed block is a machine-
// readable `<!-- archgen:block vX.Y.Z -->` stamp sourced from the canonical
// config (lib/config.js loadConfig()). upsertBlock normalizes every block it
// writes to carry the CURRENT stamp, so legacy unversioned blocks upgrade in
// place on the next init/doctor pass and detectBlockVersion() lets doctor
// report stale formats precisely.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { assertNotSymlink } from './store.js';

// Markers + block-format version come from the single source of truth.
// Module-level load is safe: config resolution is module-relative and
// deterministic, and a missing/corrupt config fails loudly at import by design.
const CONFIG = loadConfig();

export const START = CONFIG.markers.start;
export const END = CONFIG.markers.end;
export const FEATURES_START = CONFIG.markers.featuresStart;
export const FEATURES_END = CONFIG.markers.featuresEnd;

/** The exact provenance line rendered as the first line of a managed block. */
export function provenanceLine() {
  return '<!-- archgen:block v' + CONFIG.version + ' -->';
}

const PROVENANCE_LINE_RE = /^<!--\s*archgen:block\s+v[^\s>]*\s*-->$/;

/**
 * Normalize an archgen-rendered block so the current provenance line sits
 * immediately after START: stale/differently-versioned stamps are dropped and
 * the canonical one inserted. Blocks not beginning with START pass through
 * untouched. Preserves the block's own CRLF/LF convention.
 */
function injectProvenance(block) {
  if (typeof block !== 'string' || !block.startsWith(START)) return block;
  const eol = block.includes('\r\n') ? '\r\n' : '\n';
  const lines = block.split(/\r?\n/).filter((l, i) => i === 0 || !PROVENANCE_LINE_RE.test(l.trim()));
  lines.splice(1, 0, provenanceLine());
  return lines.join(eol);
}

/**
 * Detect the provenance stamp of a managed block inside file content.
 * @param {string} content file contents (BOM/CRLF tolerated)
 * @returns {{present: boolean, version: string|null}} present=true when a
 *   provenance line is found as the first non-empty line after START; version
 *   is the stamped semver, or null when the line is malformed.
 */
export function detectBlockVersion(content) {
  const src = String(content ?? '');
  const s = src.indexOf(START);
  if (s === -1) return { present: false, version: null };
  const e = src.indexOf(END, s + START.length);
  const head = src.slice(s + START.length, e === -1 ? undefined : e);
  for (const line of head.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') continue;
    if (!t.includes('archgen:block')) return { present: false, version: null };
    const m = /^<!--\s*archgen:block\s+v([^\s>]+)\s*-->$/.exec(t);
    return { present: true, version: m ? m[1] : null };
  }
  return { present: false, version: null };
}

/**
 * Render the archgen pointer block for a project.
 * @param {string} skillRelPath relative path to the skill dir from project root
 * @param {string} eol line ending used to join the block lines
 */
export function renderBlock(skillRelPath = '.agents/skills/archgen', eol = '\n') {
  return [
    START,
    provenanceLine(),
    '# ArchGen - Architecture Generation & Autonomous Task Execution',
    '',
    'This project uses the **archgen** skill, installed at `' + skillRelPath + '/`.',
    '',
    '**Before running any archgen workflow, read its instructions:**',
    'read `' + skillRelPath + '/SKILL.md` first - it defines every mode, gate, and rule.',
    '',
    'Quick triggers:',
    '- "generate architecture for X" -> greenfield GENERATE mode',
    '- "add feature X" -> BROWNFIELD survey-first mode (analyzes this codebase)',
    '- "start work" -> execute pending tasks in `.archgen/*/tasks.yaml` wave-by-wave',
    '- "roll back ..." / "install mcp ..." / "fetch design skill" -> auxiliary modes',
    '',
    'Rules of the road:',
    '- Generated artifacts live ONLY under `.archgen/<slug>/`',
    '- Never hand-edit task statuses - use `scripts/set-status.mjs` (comment-safe)',
    '- Two gates before any execution: verifier approval, then human approval',
    '',
    '## Features registry',
    '',
    FEATURES_START,
    '| Feature | Status | Updated |',
    '| --- | --- | --- |',
    FEATURES_END,
    END,
  ].join(eol);
}

/**
 * Canonical AGENTS.md managed-block text (LF-joined, provenance included).
 * Integration contract: install.sh's heredoc is regenerated byte-identically
 * from this function's output — do not let the two drift.
 */
export function renderManagedBlockText() {
  return renderBlock();
}

/**
 * Canonical CLAUDE.md bridge text (LF-joined, provenance included).
 * Same integration contract as renderManagedBlockText().
 */
export function renderClaudeBridgeText() {
  return [START, provenanceLine(), '@AGENTS.md', END].join('\n');
}

function countOccurrences(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function stripCompleteBlocks(text) {
  let out = text;
  for (;;) {
    const s = out.indexOf(START);
    if (s === -1) break;
    const e = out.indexOf(END, s + START.length);
    if (e === -1) break;
    out = out.slice(0, s) + out.slice(e + END.length);
  }
  return out;
}

/**
 * Insert or replace the managed block inside existing file content.
 * Corrupted input with DUPLICATED markers (more than one START or END, e.g. a
 * twice-appended block) is normalized: the first complete block is replaced
 * in place, every later complete block is removed, and anything outside the
 * markers survives — the result carries exactly one block. Orphan markers
 * left over after normalization still throw, as does a single orphan marker.
 * @param {string} existing file contents ('' when creating new)
 * @param {string} block rendered block
 * @param {string} eol line ending used when appending to empty/missing files
 */
export function upsertBlock(existing, block, eol = '\n') {
  // Every write carries the CURRENT provenance stamp regardless of what the
  // caller rendered — this is what upgrades legacy unversioned blocks in place.
  const fresh = injectProvenance(block);
  const trimmed = existing ?? '';
  const starts = countOccurrences(trimmed, START);
  const ends = countOccurrences(trimmed, END);

  if (starts > 1 || ends > 1) {
    const s = trimmed.indexOf(START);
    const e = s === -1 ? -1 : trimmed.indexOf(END, s + START.length);
    if (s === -1 || e === -1) {
      throw new Error('found only one archgen marker - fix or remove it manually');
    }
    const tail = stripCompleteBlocks(trimmed.slice(e + END.length));
    if (tail.includes(START) || tail.includes(END)) {
      throw new Error('found only one archgen marker - fix or remove it manually');
    }
    return trimmed.slice(0, s) + fresh + tail;
  }

  const startIdx = trimmed.indexOf(START);
  const endIdx = trimmed.indexOf(END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return trimmed.slice(0, startIdx) + fresh + trimmed.slice(endIdx + END.length);
  }
  if (startIdx !== -1 || endIdx !== -1) {
    throw new Error('found only one archgen marker - fix or remove it manually');
  }
  if (trimmed.trim() === '') return fresh + eol;
  const core = trimmed.replace(/(?:\r?\n)+$/, '');
  return core + eol + eol + fresh + eol;
}

/**
 * Strip EVERY managed block from file contents (duplicated markers normalize
 * to zero blocks, matching upsertBlock's one-block guarantee).
 * @returns {{content: string, hadBlock: boolean}}
 */
export function stripBlock(existing) {
  const trimmed = existing ?? '';
  const out = stripCompleteBlocks(trimmed);
  if (out === trimmed) return { content: trimmed, hadBlock: false };
  // Collapse whitespace left behind; drop file if nothing else remains.
  return { content: out.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n'), hadBlock: true };
}

function splitBom(raw) {
  const bom = raw.charCodeAt(0) === 0xfeff;
  return { bom, body: bom ? raw.slice(1) : raw };
}

/** Write via sibling temp file + rename so readers never observe partial content. */
function atomicWrite(absPath, data) {
  const tmp = absPath + '.tmp-' + process.pid + '-' + Date.now();
  // 'wx' (O_CREAT|O_EXCL): if the tmp name already exists — e.g. an attacker
  // planted a symlink there to redirect the write — fail instead of following.
  writeFileSync(tmp, data, { flag: 'wx' });
  renameSync(tmp, absPath);
}

/**
 * BOM/EOL-aware upsert of a managed block directly into a file.
 * Preserves a leading UTF-8 BOM and the file's CRLF/LF convention.
 * Refuses (throws) when the target is a symlink: managed files must never be
 * written through a link (the final rename replaces the link itself, but the
 * read+upsert would otherwise operate on attacker-chosen content).
 * @param {string} absPath target file (created when missing)
 * @param {string[]} blockLines lines between the managed markers
 * @returns {boolean} whether the file existed before the call
 */
export function upsertManagedFile(absPath, blockLines) {
  assertNotSymlink(absPath);
  const existed = existsSync(absPath);
  const raw = existed ? readFileSync(absPath, 'utf8') : '';
  const { bom, body } = splitBom(raw);
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const next = upsertBlock(body, blockLines.join(eol), eol);
  atomicWrite(absPath, (bom ? '\uFEFF' : '') + next);
  return existed;
}

/**
 * True when the file already contains a trimmed `@AGENTS.md` line anywhere
 * (BOM- and CRLF-tolerant).
 */
export function importsAgents(absPath) {
  let raw = '';
  try { raw = readFileSync(absPath, 'utf8'); } catch { return false; }
  const { body } = splitBom(raw);
  return body.split(/\r?\n/).some((l) => l.trim() === '@AGENTS.md');
}

/** Strip the managed block from a file on disk, preserving BOM. */
export function stripManagedFile(absPath) {
  assertNotSymlink(absPath);
  let raw = '';
  try { raw = readFileSync(absPath, 'utf8'); } catch { return { hadBlock: false }; }
  const { bom, body } = splitBom(raw);
  const { content, hadBlock } = stripBlock(body);
  if (hadBlock) writeFileSync(absPath, (bom ? '\uFEFF' : '') + content);
  return { hadBlock };
}

function renderRow(row) {
  const cells = Array.isArray(row)
    ? row.map(String)
    : [row.feature ?? row.name ?? '', row.status ?? '', row.updated ?? ''].map(String);
  return '| ' + cells.join(' | ') + ' |';
}

/**
 * Replace the content between the archgen:features markers in a file with the
 * registry table (header rows plus `rows`). When the markers are missing but
 * the managed block exists, the registry section is inserted before its END
 * marker. Never touches anything outside the markers.
 * @param {string} fileAbsPath absolute path to AGENTS.md-style file
 * @param {Array<string[]|{feature:string,status:string,updated:string}>} rows
 * @returns {string} the new file content
 */
export function upsertFeaturesRegistry(fileAbsPath, rows = []) {
  assertNotSymlink(fileAbsPath);
  const raw = readFileSync(fileAbsPath, 'utf8');
  const table = [
    '| Feature | Status | Updated |',
    '| --- | --- | --- |',
    ...rows.map(renderRow),
  ].join('\n');
  const s = raw.indexOf(FEATURES_START);
  const e = raw.indexOf(FEATURES_END);
  let next;
  if (s !== -1 && e !== -1 && e > s) {
    next = raw.slice(0, s + FEATURES_START.length) + '\n' + table + '\n' + raw.slice(e);
  } else if (s === -1 && e === -1) {
    const bStart = raw.indexOf(START);
    const bEnd = raw.indexOf(END);
    if (bStart === -1 || bEnd === -1 || bEnd < bStart) {
      throw new Error('no archgen managed block - cannot place features registry');
    }
    const section = '\n## Features registry\n\n' + FEATURES_START + '\n' + table + '\n' + FEATURES_END + '\n';
    next = raw.slice(0, bEnd) + section + raw.slice(bEnd);
  } else {
    throw new Error('found only one archgen:features marker - fix or remove it manually');
  }
  if (next !== raw) writeFileSync(fileAbsPath, next);
  return next;
}
