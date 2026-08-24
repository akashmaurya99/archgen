#!/usr/bin/env node
// set-status.mjs — atomic, comment-preserving task status mutator.
// Usage: node set-status.mjs <tasks.yaml> <taskId> <status> [--force]
// Illegal transitions (done -> pending|ready) require --force. Exit 4 on refusal.
// Writes via temp-file + rename so concurrent readers never see partial files.
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
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

const raw = readFileSync(file, 'utf8');
const { data, comments } = parseYaml(raw, { filename: file });
const tasks = data?.tasks;
if (!Array.isArray(tasks)) { console.error(`${file}: missing 'tasks:' sequence`); process.exit(4); }

const task = tasks.find((t) => t && t.id === taskId);
if (!task) { console.error(`task '${taskId}' not found in ${file}`); process.exit(4); }

const prev = task.status ?? 'pending';
if ((prev === 'done') && (nextStatus === 'pending' || nextStatus === 'ready') && !force) {
  console.error(`refusing ${prev} -> ${nextStatus} for '${taskId}' without --force (reopening completed work needs explicit intent)`);
  process.exit(4);
}

task.status = nextStatus;
const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
writeFileSync(tmp, stringifyYaml(data, comments));
renameSync(tmp, file); // atomic on POSIX: readers observe old-or-new, never partial
console.log(`${taskId}: ${prev} -> ${nextStatus}`);
