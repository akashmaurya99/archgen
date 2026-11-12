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
import { invalidInput } from './errors.mjs';
import { hint } from './guidance.mjs';
import { toolCall } from './call.mjs';

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

/**
 * The collection rules for ONE tool.
 *
 * WHY A SHARED RULE. A `collection` argument is shared across the actions of
 * a tool, so a caller can name a collection an action does not have. The
 * answer must be a TYPED ERROR — never a silent fallback, and never a quiet
 * no-op that drops the argument.
 *
 * The rule was written twice — once per tool — and the two copies were free
 * to drift. One implementation, one place: the table and the help topic are
 * the only things that differ, and they are the parameters.
 *
 * @param {Record<string, string[]>} collections the collections each action can walk
 * @param {string} topic the help topic that lists them
 * @returns {{
 *   resolve: (action: string, collection: string|undefined, fallback: string) => string,
 *   reject: (action: string, collection: string|undefined) => void,
 * }}
 */
export function collectionRules(collections, topic) {
  const allowedFor = (action) => collections[action] ?? [];

  return {
    /**
     * The collection a caller named, validated against the action's own set.
     *
     * @param {string} action
     * @param {string|undefined} collection
     * @param {string} fallback the action's default collection
     * @returns {string}
     */
    resolve(action, collection, fallback) {
      const allowed = allowedFor(action);
      if (collection === undefined || collection === null) return fallback;
      if (!allowed.includes(collection)) {
        throw invalidInput(
          `'${collection}' is not a collection of '${action}' (allowed: ${allowed.join('|') || 'none'})`,
          { ...hint({ action: toolCall('archgen_help', { topic }), reason: 'the collections of each action are listed there.' }), action, collection, allowed },
        );
      }
      return collection;
    },

    /**
     * Reject `collection` on an action that has NO collection.
     *
     * @param {string} action
     * @param {string|undefined} collection
     */
    reject(action, collection) {
      if (collection === undefined || collection === null) return;
      const allowed = allowedFor(action);
      throw invalidInput(
        `'${action}' has no collection (allowed elsewhere: ${allowed.join('|') || 'none'})`,
        { ...hint({ action: toolCall('archgen_help', { topic }), reason: 'the collections of each action are listed there.' }), action, collection },
      );
    },
  };
}
