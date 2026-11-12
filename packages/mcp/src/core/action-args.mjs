// action-args.mjs — tell the caller when an action ignored one of its
// arguments.
//
// WHY THIS EXISTS. The schema is FLAT: one shape for every action, so the
// model sees all twenty-four arguments of `archgen_plan` on every call and
// must pick the two its action uses. When it picked wrong, the handler
// ignored the extra argument — the call succeeded, and the agent believed
// it had done something it had not.
//
// HOW IT KNOWS. The arguments are handed to the handler through a Proxy that
// records every property the handler READS. An argument that was passed and
// never read was ignored — and that is a fact about the code, not a fact
// somebody has to keep a table in step with.
//
// The per-action tables below only ENRICH the message: they say which action
// does take the argument. A wrong entry there changes a sentence; it can
// never change what the tool does.
import { WARNING_CODES } from './codes.mjs';

/**
 * The arguments each action takes, when it is known.
 *
 * BEST EFFORT: these name the action that owns an argument so the warning
 * can say "it belongs to impact". They are not consulted to decide whether
 * an argument was ignored — the read-tracking decides that.
 * @typedef {Record<string, string[]>} ActionArgs
 */

/**
 * Watch the arguments an action reads.
 *
 * @param {Record<string, unknown>} args the caller's arguments
 * @param {ActionArgs} [table] the arguments each action takes
 * @returns {{args: Record<string, unknown>, ignored: () => string[]}}
 */
export function trackArgs(args, table) {
  const read = new Set();
  const source = args ?? {};
  const tracked = new Proxy(source, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') read.add(prop);
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === 'string') read.add(prop);
      return Reflect.has(target, prop);
    },
  });
  return {
    args: tracked,
    ignored() {
      return Object.keys(source).filter(
        (key) => source[key] !== undefined && !read.has(key) && key !== 'action' && key !== 'projectRoot',
      );
    },
    owners() {
      const owners = new Map();
      for (const [action, keys] of Object.entries(table ?? {})) {
        for (const key of keys) {
          if (!owners.has(key)) owners.set(key, []);
          owners.get(key).push(action);
        }
      }
      return owners;
    },
  };
}

/**
 * The warning for arguments the action did not read.
 *
 * @param {string[]} ignored the argument names
 * @param {Map<string, string[]>} owners which action takes each one
 * @returns {string}
 */
export function ignoredArgsWarning(ignored, owners) {
  const named = ignored
    .map((key) => {
      const where = owners.get(key);
      return where?.length ? `'${key}' belongs to ${where.join('|')}` : `'${key}'`;
    })
    .join('; ');
  return (
    `${WARNING_CODES.ARG_IGNORED}: the action ignored ${ignored.map((k) => `'${k}'`).join(', ')} — ` +
    `${named}. The call did what the action does; the argument changed nothing.`
  );
}
