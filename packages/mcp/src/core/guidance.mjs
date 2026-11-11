// guidance.mjs — every failure teaches the agent what to do NEXT, in ONE line.
//
// WHY THIS FILE EXISTS.
//
// An error that only says WHAT FAILED leaves the agent to guess, and a guess
// that fails the same way is a loop. An agent that called
// `archgen_refs{action:'read', section:'plan-depth'}` and got
// "no section 'plan-depth'" had no way to know the slug it was told to use
// was a shorthand for a longer one — so it burned a round-trip rediscovering
// the vocabulary, and did it again for the next section.
//
// So every archgen failure is ONE line that carries the cause, the fix, and
// the exact next step:
//
//   <cause> — <the fix in a clause>. Next: <the call, ready to paste>
//
// The vocabulary is SHARED, so every tool teaches the same way. And where a
// failure can be prevented rather than explained, it is: the section
// resolver accepts the shorthand the skill teaches, so the question never
// comes up.
//
// `hint()` adds machine-readable next-step fields to the error DETAILS, so a
// client can act on them without parsing prose.
import { invalidInput, notFound } from './errors.mjs';
import { toolCall } from './call.mjs';

/**
 * Compose a ONE-LINE teaching message.
 *
 * @param {string} cause what went wrong, in a few words
 * @param {string} fix the fix, in one clause
 * @param {string} action the exact next call, ready to paste
 * @returns {string}
 */
export function teach(cause, fix, action) {
  return `${cause} — ${fix}. Next: ${action}`;
}

/**
 * Machine-readable next-step fields, attached to an error's details.
 *
 * `action` is the next step: the exact call to make when there is one, and
 * the instruction to follow when there is not (a file to repair by hand, a
 * value to supply). `reason` says why that step clears the failure.
 *
 * @param {{action?: string, reason?: string, alternatives?: string[], available?: unknown[]}} spec
 * @returns {Record<string, unknown>}
 */
export function hint(spec) {
  const out = {};
  if (spec.action) out.nextAction = spec.action;
  if (spec.reason) out.reason = spec.reason;
  if (spec.alternatives?.length) out.alternatives = spec.alternatives;
  if (spec.available?.length) out.available = spec.available;
  return out;
}

/**
 * "The artifact space does not exist yet."
 *
 * `archgen_plan{action:'scaffold'}` is a GENERATOR: it returns the CONTENT
 * of the files to create, and writes nothing. An agent that assumes otherwise
 * gets "missing or not a directory" from every artifact tool, and the
 * natural reading — "the tool is broken" — sends it hunting for a flag that
 * does not exist.
 *
 * @param {string} slug the slug, when known
 * @param {string} slugDir the path that was looked for
 */
export function artifactSpaceMissing(slug, slugDir) {
  return invalidInput(
    teach(
      `no artifact space at ${slugDir}`,
      'scaffold returns file CONTENT and writes nothing, so write it first',
      toolCall('archgen_plan', { action: 'scaffold', scope: 'LARGE', slug: '<slug>' }),
    ),
    hint({ action: toolCall('archgen_plan', { action: 'scaffold', scope: 'LARGE', slug: '<slug>' }), reason: 'scaffold returns content; you write it.' }),
  );
}

/**
 * "That section does not exist."
 *
 * @param {string} topic the reference topic
 * @param {string} section the section that was asked for
 * @param {string[]} available the valid slugs
 */
export function noSuchSection(topic, section, available) {
  return notFound(
    teach(
      `no section '${section}' in '${topic}'`,
      'a prefix of the slug works too, if unambiguous',
      toolCall('archgen_refs', { action: 'index', topic }),
    ),
    hint({ action: toolCall('archgen_refs', { action: 'index', topic }), reason: 'the index lists every exact slug.', available }),
  );
}

/**
 * "That skill is not installed."
 *
 * @param {string} slug the skill slug
 */
export function skillNotInstalled(slug) {
  return invalidInput(
    teach(
      `the capability skill '${slug}' is not installed`,
      'install it before dispatching the worker',
      toolCall('archgen_skills', { action: 'install', skillId: slug, approve: true }),
    ),
    hint({ action: toolCall('archgen_skills', { action: 'install', skillId: slug, approve: true }), reason: 'a required skill must be on disk before dispatch.' }),
  );
}

/**
 * "That task id is not in the plan."
 *
 * @param {string} taskId the id that was asked for
 * @param {string[]} available the task ids that exist
 */
export function noSuchTask(taskId, available) {
  return notFound(
    teach(
      `no task '${taskId}' in the plan`,
      'task ids are case-sensitive',
      toolCall('archgen_tasks', { action: 'list', tasksYaml: '<tasks.yaml>' }),
    ),
    hint({ action: toolCall('archgen_tasks', { action: 'list', tasksYaml: '<tasks.yaml>' }), reason: 'the list carries every task id.', available }),
  );
}

/**
 * "That path is outside the project."
 *
 * @param {string} path the refused path
 * @param {string} root the anchor the server is bound to
 */
export function outsideProject(path, root) {
  return invalidInput(
    teach(
      `the path is outside the project: ${path}`,
      'the server is anchored to one root and cannot read or write outside it',
      `use a path under ${root}`,
    ),
    hint({ action: `use a path under ${root}`, reason: 'the anchor is the boundary.' }),
  );
}
