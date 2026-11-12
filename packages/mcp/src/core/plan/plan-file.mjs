// plan-file.mjs — the ONE way a tool reads a plan's task file.
//
// WHY IT EXISTS. Seven modules read the file, parsed it, and shaped the
// failure their own way. The same broken file produced four different error
// messages across four tools, and two of them DELETED the line number — so
// the agent had less to go on depending on which tool it happened to call.
//
// One reader, one shape: the cause, the line, the fix and the next call.

import { readFileSync, realpathSync } from 'node:fs';
import { parseYaml } from '../fs/yaml.mjs';
import { invalidInput, ArchgenError } from '../protocol/errors.mjs';
import { teach, hint } from '../protocol/guidance.mjs';
import { finding } from '../protocol/diagnostics.mjs';
import { toolCall } from '../protocol/call.mjs';

/**
 * Read and parse a plan file.
 *
 * A file that cannot be parsed is NOT an exception here: it comes back as a
 * finding, so a caller that can report the defect as data does, and a caller
 * that cannot uses `readParsedPlanFile`.
 *
 * @param {string} file absolute path to the plan's task file
 * @returns {{file: string, data: any, comments: object[], provenance: Map<string, number>, findings: object[]}}
 */
export function readPlanFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    const code = e?.code === 'ENOENT' ? 'NOT_FOUND' : 'INVALID_INPUT';
    throw new ArchgenError(
      code,
      `${code === 'NOT_FOUND' ? 'plan file not found' : 'cannot read plan file'}: ${file}`,
      { file },
    );
  }
  try {
    const { data, comments, provenance } = parseYaml(raw, { filename: file });
    return { file, data, comments, provenance, findings: [] };
  } catch (e) {
    return { file, data: null, comments: [], provenance: new Map(), findings: [parseFinding(e)] };
  }
}

/**
 * Read a plan file that MUST parse, or throw the one typed error.
 *
 * @param {string} file absolute path to the plan's task file
 * @returns {{file: string, data: any, comments: object[], provenance: Map<string, number>}}
 */
export function readParsedPlanFile(file) {
  const read = readPlanFile(file);
  if (read.findings.length) throw planFileError(file, read.findings);
  return read;
}

/**
 * The typed error for a plan file that cannot be parsed.
 *
 * @param {string} file
 * @param {object[]} findings
 * @returns {import('./errors.mjs').ArchgenError}
 */
export function planFileError(file, findings) {
  const first = findings[0] ?? { message: 'the file could not be read' };
  // The path is resolved so every tool spells it the same way — one tool
  // resolved its input through a realpath and another did not, and the same
  // broken file produced two different messages.
  const where = realPathOf(file);
  const next = toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' });
  return invalidInput(
    teach(
      `${where} cannot be parsed: ${first.message}`,
      'fix that line and re-run',
      next,
    ),
    hint({
      action: next,
      reason: 'the file must parse before any check can run on it.',
      alternatives: [toolCall('archgen_plan', { action: 'verify', tasksYaml: '<tasks.yaml>', planDir: '<planDir>' })],
    }),
  );
}

/**
 * The file's real path, when it has one.
 *
 * WHY IT IS NOT CALLED `resolvePath`: another module had a `resolvePath`
 * that walks a JSON tree by key path — a different operation under the same
 * name. Two names for two operations in one codebase is how a reader picks
 * the wrong one. This one answers "what path does this really point at",
 * so it is named for that.
 *
 * @param {string} file
 * @returns {string} the real path, or the input when it cannot be resolved
 */
function realPathOf(file) {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
}

/**
 * The finding for a parse failure.
 *
 * The location is part of the MESSAGE, like every other finding's — the
 * finding shape is {code, message, fix}, and a finding that cannot say where
 * it is cannot be acted on.
 *
 * @param {Error} e the parser's error
 * @returns {object}
 */
function parseFinding(e) {
  const line = Number.isInteger(e?.line) ? e.line : null;
  const path = e?.path ?? null;
  const detail = e?.detail ?? String(e?.message ?? e);
  const where = line ? ` (line ${line}${path ? `, ${path}` : ''})` : '';
  return finding('UNPARSEABLE', `${detail}${where}`, {
    fix: line
      ? `fix line ${line}, then re-run ${toolCall('archgen_plan', { action: 'validate' })}`
      : `fix the file, then re-run ${toolCall('archgen_plan', { action: 'validate' })}`,
  });
}
