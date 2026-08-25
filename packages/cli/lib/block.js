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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const START = '<!-- archgen:start (managed block - do not edit between markers) -->';
export const END = '<!-- archgen:end -->';
export const FEATURES_START = '<!-- archgen:features:start -->';
export const FEATURES_END = '<!-- archgen:features:end -->';

/**
 * Render the archgen pointer block for a project.
 * @param {string} skillRelPath relative path to the skill dir from project root
 * @param {string} eol line ending used to join the block lines
 */
export function renderBlock(skillRelPath = '.agents/skills/archgen', eol = '\n') {
  return [
    START,
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
 * Insert or replace the managed block inside existing file content.
 * @param {string} existing file contents ('' when creating new)
 * @param {string} block rendered block
 * @param {string} eol line ending used when appending to empty/missing files
 */
export function upsertBlock(existing, block, eol = '\n') {
  const trimmed = existing ?? '';
  const startIdx = trimmed.indexOf(START);
  const endIdx = trimmed.indexOf(END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return trimmed.slice(0, startIdx) + block + trimmed.slice(endIdx + END.length);
  }
  if (startIdx !== -1 || endIdx !== -1) {
    throw new Error('found only one archgen marker - fix or remove it manually');
  }
  if (trimmed.trim() === '') return block + eol;
  const core = trimmed.replace(/(?:\r?\n)+$/, '');
  return core + eol + eol + block + eol;
}

/**
 * Strip the managed block from file contents.
 * @returns {{content: string, hadBlock: boolean}}
 */
export function stripBlock(existing) {
  const trimmed = existing ?? '';
  const startIdx = trimmed.indexOf(START);
  const endIdx = trimmed.indexOf(END);
  if (startIdx === -1 || endIdx === -1) return { content: trimmed, hadBlock: false };
  let out = trimmed.slice(0, startIdx) + trimmed.slice(endIdx + END.length);
  // Collapse whitespace left behind; drop file if nothing else remains.
  out = out.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
  return { content: out, hadBlock: true };
}

function splitBom(raw) {
  const bom = raw.charCodeAt(0) === 0xfeff;
  return { bom, body: bom ? raw.slice(1) : raw };
}

/**
 * BOM/EOL-aware upsert of a managed block directly into a file.
 * Preserves a leading UTF-8 BOM and the file's CRLF/LF convention.
 * @param {string} absPath target file (created when missing)
 * @param {string[]} blockLines lines between the managed markers
 * @returns {boolean} whether the file existed before the call
 */
export function upsertManagedFile(absPath, blockLines) {
  const existed = existsSync(absPath);
  const raw = existed ? readFileSync(absPath, 'utf8') : '';
  const { bom, body } = splitBom(raw);
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const next = upsertBlock(body, blockLines.join(eol), eol);
  writeFileSync(absPath, (bom ? '\uFEFF' : '') + next);
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
