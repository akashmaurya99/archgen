// status-mutator.mjs — atomic, comment-preserving task status mutator.
//
// Extracted verbatim from skill/scripts/set-status.mjs (deleted in the
// MCP-first cutover). Three behaviours are load-bearing and are covered by
// dedicated unit tests:
//
//   1. ATOMICITY — the file is written via an O_EXCL temp file + rename, so
//      concurrent readers (same-wave parallel workers) never see a partial
//      file, and a crash mid-write leaves the original byte-intact.
//   2. LINE ENDINGS — the file's dominant convention (CRLF vs LF) is detected
//      BEFORE parsing and re-emitted, so a rewrite never churns every line.
//   3. COMMENTS — `stringifyYaml(data, comments)` re-emits the author's
//      comments verbatim.
//
// ANY transition out of 'done' requires explicit intent (force): reopening
// completed work — directly or via a failed/blocked hop — is refused without it.
import { readFileSync } from 'node:fs';
import { stringifyYaml } from '../fs/yaml.mjs';
import { readParsedPlanFile } from './plan-file.mjs';
import { conflict, invalidInput } from '../protocol/errors.mjs';
import { writeFileAtomic, withFileLock } from '../fs/fs-safety.mjs';
import { hint } from '../protocol/guidance.mjs';
import { toolCall } from '../protocol/call.mjs';

export const STATUSES = ['pending', 'ready', 'running', 'blocked', 'done', 'failed'];

/**
 * Detect the dominant line ending of a file's raw text.
 * @param {string} raw
 * @returns {string} '\r\n' or '\n'
 */
export function detectEol(raw) {
  const crlfCount = (raw.match(/\r\n/g) ?? []).length;
  const loneLfCount = (raw.match(/(?<!\r)\n/g) ?? []).length;
  return crlfCount > loneLfCount ? '\r\n' : '\n';
}

/**
 * Do two task ids name the same task?
 *
 * Textually equal ids match. A NUMERIC id also matches by value, because
 * YAML resolves `id: 007` to the number 7 — the agent holds the text it
 * read and the parser holds the value. A QUOTED id is text and matches
 * exactly: `id: "7"` and "07" are different tasks.
 */
export function sameId(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (sa === sb) return true;
  if (typeof a !== 'number') return false;
  const nb = Number(sb);
  return sb.trim() !== '' && Number.isFinite(nb) && a === nb;
}

/**
 * Set a task's status atomically.
 *
 * @param {string} file absolute path to tasks.yaml
 * @param {string} taskId
 * @param {string} nextStatus one of STATUSES
 * @param {{force?: boolean}} [opts]
 * @returns {{taskId: string, from: string, to: string, changed: boolean, file: string}}
 */
export function setTaskStatus(file, taskId, nextStatus, opts = {}) {
  const force = opts.force === true;

  if (!STATUSES.includes(nextStatus)) {
    throw invalidInput(
      `invalid status '${nextStatus}' (allowed: ${STATUSES.join('|')})`,
      { ...hint({ action: toolCall('archgen_tasks', { action: 'list', tasksYaml: '<tasks.yaml>' }), reason: "the list carries every task and its status." }), status: nextStatus },
    );
  }

  // The whole read-modify-write runs under an exclusive lock. Atomic writes
  // keep a reader from seeing a half-written file, but two writers still
  // lose each other's changes without this: parallel workers in one wave
  // each read the same bytes and each write its own status over the other's.
  return withFileLock(file, () => mutateStatus(file, taskId, nextStatus, force));
}

/** The read-modify-write itself. Runs with the file's lock held. */
function mutateStatus(file, taskId, nextStatus, force) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw invalidInput(
      `cannot read ${file} (missing or unreadable)`,
      { ...hint({ action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }), reason: "validate reports what the task file is missing." }), file },
    );
  }
  // Detect the file's dominant line ending BEFORE parsing so the rewrite keeps
  // the author's convention instead of churning every line CRLF<->LF.
  const eol = detectEol(raw);

  const { data, comments } = readParsedPlanFile(file);
  const tasks = data?.tasks;
  if (!Array.isArray(tasks)) throw invalidInput(
    `${file}: missing 'tasks:' sequence`,
    { ...hint({ action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }), reason: "validate reports what the task file is missing." }), file },
  );

  // Ids are matched as TEXT, and — when both sides are numeric — as NUMBERS.
  // YAML reads `id: 007` as the number 7, so the id the agent holds ("007")
  // and the id the file holds (7) are different strings for the same task.
  // A strict comparison made such a task permanently unaddressable.
  const task = tasks.find((t) => t && sameId(t.id, taskId));
  if (!task) throw invalidInput(
    `task '${taskId}' not found in ${file}`,
    { ...hint({ action: toolCall('archgen_tasks', { action: 'list', tasksYaml: '<tasks.yaml>' }), reason: "the list carries every task id." }), file, taskId },
  );

  const prev = task.status ?? 'pending';
  if (prev === 'done' && nextStatus !== 'done' && !force) {
    throw conflict(
      `refusing ${prev} -> ${nextStatus} for '${taskId}' without force (reopening completed work needs explicit intent)`,
      {
        ...hint({
          action: toolCall('archgen_tasks', { action: 'set_status', tasksYaml: '<tasks.yaml>', taskId, status: nextStatus, force: true }),
          reason: 'reopening completed work is deliberate — pass force:true.',
        }),
        file,
        taskId,
        from: prev,
        to: nextStatus,
      },
    );
  }

  const changed = prev !== nextStatus;
  task.status = nextStatus;
  const content = stringifyYaml(data, comments, { eol });
  writeFileAtomic(file, content);

  return { taskId, from: prev, to: nextStatus, changed, file };
}
