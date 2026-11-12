// slug.mjs — the ONE rule for a plan's slug.
//
// WHY THIS FILE EXISTS. A slug names a directory inside `.archgen/`, so it is
// a PATH SEGMENT and it must not be able to leave. Three tools accepted one,
// three rules:
//
//   - the brief's scope: lowercase, dash-separated;
//   - the registry's update: alphanumeric, then '.', '_', '-';
//   - the profile and the scaffold: ANY STRING — so `slug:"../../evil"`
//     produced `.archgen/../../evil/tasks.yaml`, a path OUTSIDE the artifact
//     space.
//
// The same artifact space was therefore legal two ways, and one way was a
// path traversal. One rule now, and every tool that takes a slug uses it.
import { invalidInput } from './errors.mjs';
import { teach, hint } from './guidance.mjs';
import { toolCall } from './call.mjs';

/**
 * A slug is lowercase, dash-separated, and starts with a letter or a digit.
 *
 * It is the directory name under `.archgen/`, so it is also a PATH SEGMENT:
 * a slash, a dot-dot or a space would take it somewhere else.
 */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether a string is a usable slug.
 *
 * @param {unknown} slug
 * @returns {boolean}
 */
export function isSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

/**
 * A token that becomes a FILE NAME.
 *
 * The investigate brief writes its notes to `.agent/notes/<topic>.md`, so a
 * topic of "../../evil" told the worker to write OUTSIDE the artifact space.
 * A name that becomes a path segment carries no slash, no dot-dot and no
 * space.
 */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Whether a string is safe to use as a file name.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPathToken(value) {
  return typeof value === 'string' && value.length <= 120 && TOKEN_RE.test(value);
}

/**
 * Refuse a value that would become a path outside the artifact space.
 *
 * @param {unknown} value
 * @param {string} name what the value is called
 * @param {string} [action] the action that needs it, for the next call
 * @throws {import('./errors.mjs').ArchgenError}
 */
export function assertPathToken(value, name, action = 'plan') {
  if (isPathToken(value)) return;
  throw invalidInput(
    teach(
      `'${value}' is not a usable ${name}`,
      'it becomes a file name, so it carries no slash, no dot-dot and no space',
      toolCall('archgen_plan', { action }),
    ),
    hint({
      action: toolCall('archgen_plan', { action }),
      reason: `a ${name} names a file inside the artifact space, so it cannot escape it.`,
    }),
  );
}

/**
 * Refuse a slug that is not one.
 *
 * @param {unknown} slug
 * @param {string} [action] the action that needs it, for the next call
 * @throws {import('./errors.mjs').ArchgenError}
 */
export function assertSlug(slug, action = 'profile') {
  if (isSlug(slug)) return;
  throw invalidInput(
    teach(
      `'${slug}' is not a valid slug`,
      'a slug is lowercase and dash-separated — it names a directory inside .archgen/',
      toolCall('archgen_plan', { action, slug: '<slug>' }),
    ),
    hint({
      action: toolCall('archgen_plan', { action, slug: '<slug>' }),
      reason: 'a slug is a path segment, so it cannot carry a slash, a dot or a space.',
    }),
  );
}
