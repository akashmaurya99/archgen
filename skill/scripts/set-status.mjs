#!/usr/bin/env node
// set-status.mjs — atomic, comment-preserving task status mutator.
// Usage: node set-status.mjs <tasks.yaml> <taskId> <status> [--force]
// ANY transition out of 'done' requires --force (reopening completed work —
// directly or via a failed/blocked hop — needs explicit intent). Exit 4 on refusal.
// Writes via O_EXCL temp-file + rename so concurrent readers never see partial
// files (same-wave parallel workers + crash mid-write both safe: the original
// stays byte-intact until the rename lands; a failure or kill before the rename
// leaves at worst an orphaned .tmp- sibling, never a half-written tasks.yaml),
// and re-emits the file's dominant line-ending convention (CRLF stays CRLF).
// Exit codes: 0 ok · 4 usage/refusal/parse/IO errors.
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { parseYaml, stringifyYaml } from './lib/yaml.mjs';

const STATUSES = ['pending', 'ready', 'running', 'blocked', 'done', 'failed'];
const [, , file, taskId, nextStatus, ...extra] = process.argv;
const force = extra.includes('--force');

if (!file || !taskId || !nextStatus) {
  console.error('usage: set-status.mjs <tasks.yaml> <taskId> <status> [--force]');
  process.exit(4);
}
if (!STATUSES.includes(nextStatus)) {
  console.error(`invalid status '${nextStatus}' (allowed: ${STATUSES.join('|')})`);
  process.exit(4);
}

let raw;
try {
  raw = readFileSync(file, 'utf8');
} catch {
  console.error(`cannot read ${file} (missing or unreadable)`);
  process.exit(4);
}
// Detect the file's dominant line ending BEFORE parsing so the rewrite keeps
// the author's convention instead of churning every line CRLF<->LF.
const crlfCount = (raw.match(/\r\n/g) ?? []).length;
const loneLfCount = (raw.match(/(?<!\r)\n/g) ?? []).length;
const eol = crlfCount > loneLfCount ? '\r\n' : '\n';

let data, comments;
try {
  ({ data, comments } = parseYaml(raw, { filename: file }));
} catch (e) {
  console.error(`${file}: unparseable YAML (${String(e?.message ?? e).replace(/^[^:]*:\d+:\s*/, '')})`);
  process.exit(4);
}
const tasks = data?.tasks;
if (!Array.isArray(tasks)) { console.error(`${file}: missing 'tasks:' sequence`); process.exit(4); }

const task = tasks.find((t) => t && t.id === taskId);
if (!task) { console.error(`task '${taskId}' not found in ${file}`); process.exit(4); }

const prev = task.status ?? 'pending';
if (prev === 'done' && nextStatus !== 'done' && !force) {
  console.error(`refusing ${prev} -> ${nextStatus} for '${taskId}' without --force (reopening completed work needs explicit intent)`);
  process.exit(4);
}

task.status = nextStatus;
// O_EXCL ('wx') guarantees the temp path is freshly created — a stale leftover
// with the same pid+timestamp is never silently truncated and overwritten.
const content = stringifyYaml(data, comments, { eol });
let tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
for (let attempt = 0; ; attempt++) {
  try {
    writeFileSync(tmp, content, { flag: 'wx' });
    break;
  } catch (e) {
    if (e?.code === 'EEXIST' && attempt < 10) { tmp = `${file}.tmp-${process.pid}-${Date.now()}-${attempt + 1}`; continue; }
    console.error(`${file}: cannot write temp file (${e?.code ?? e?.message ?? e})`);
    process.exit(4);
  }
}
try {
  renameSync(tmp, file); // atomic on POSIX: readers observe old-or-new, never partial
} catch (e) {
  try { unlinkSync(tmp); } catch { /* original intact; leftover tmp is harmless */ }
  console.error(`${file}: atomic rename failed (${e?.code ?? e?.message ?? e}) — original left untouched`);
  process.exit(4);
}
console.log(`${taskId}: ${prev} -> ${nextStatus}`);
