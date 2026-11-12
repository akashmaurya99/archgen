// routing.mjs — ONE place that knows which arguments each action reads.
//
// WHY THIS FILE EXISTS.
//
// The catalog is injected into every request, so an argument's description is
// a permanent instruction. It used to carry a hand-written parenthesis
// naming the actions that read it:
//
//   collection: "Which collection `limit`/`offset` window
//               (validate, verify, coverage, impact)."
//
// That parenthesis was WRONG in six places, and it was wrong in the way
// that costs the most: `archgen_docs.collection` claimed one action and
// belongs to six, `archgen_plan.collection` claimed four and belongs to
// eight. A model that trusted the parenthesis would pass an argument the
// handler never reads — and the handler IGNORES an unread argument, so the
// call succeeds and the agent believes it did something it did not.
//
// The per-action tables in each tool (`PLAN_ACTION_ARGS` and friends) were
// already the truth. So the map is GENERATED from them, and the tool
// description carries ONE `Args — ...` line instead of ~50 scattered
// parentheticals that had to be kept in step by hand.
//
// WHY THE MAP IS INVERTED. It names each ARGUMENT once, with the actions
// that read it — not each action once, with the arguments it reads. The
// argument list is the longer side of the mapping, so naming it once is
// what makes the map cheap. A per-action map for `archgen_plan` repeats
// `tasksYaml` eight times; this one names it once.
//
// One source, one rendering, no drift: a parenthetical that lies cannot
// survive, because there are no parentheticals left to lie.
import { UNIVERSAL_ARGS } from './universal-args.mjs';

/**
 * The routing map for one tool — the `Args — ...` fragment.
 *
 * Each argument appears exactly once, beside the actions that read it.
 * Arguments read by every action are grouped as `every action`, and
 * arguments with the same owner-set are grouped together.
 *
 * @param {Record<string, string[]>} actionArgs the tool's per-action tables
 * @returns {string} the map, or '' when no action has a specific argument
 */
export function routingMap(actionArgs) {
  const entries = Object.entries(actionArgs ?? {});
  if (!entries.length) return '';

  // The actions that read each argument.
  const readers = new Map();
  for (const [action, args] of entries) {
    for (const a of args ?? []) {
      if (UNIVERSAL_ARGS.has(a)) continue;
      if (!readers.has(a)) readers.set(a, []);
      readers.get(a).push(action);
    }
  }
  if (!readers.size) return '';

  // The action count is the map's backbone: group the arguments by it, so
  // the reading order is "the most shared argument first".
  const allActions = entries.map(([action]) => action);
  const groups = new Map(); // ownerSet -> [args]
  for (const [arg, owners] of readers) {
    const key = owners.length === allActions.length ? 'every action' : owners.join(', ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(arg);
  }

  const parts = [];
  for (const [owners, args] of groups) {
    // The arguments are sorted so the line is stable across a reordering of
    // the action tables — a map that reshuffles on every edit is a map
    // nobody can diff.
    const list = [...args].sort().join(', ');
    parts.push(`${list}: ${owners}`);
  }
  // The most-shared owner set comes first: it is the one that applies most
  // often, and it reads as the default.
  parts.sort((a, b) => {
    const rank = (s) => (s.includes('every action') ? 0 : -s.split(', ').length);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return parts.join(' | ');
}

/**
 * The full `Args` sentence for a tool description.
 *
 * The universal arguments are NOT named here: they are properties of every
 * tool, they carry their own descriptions in the schema, and naming them
 * again in nine descriptions is nine times the cost for no extra fact.
 *
 * @param {Record<string, string[]>} actionArgs the tool's per-action tables
 * @returns {string}
 */
export function routingSentence(actionArgs) {
  const map = routingMap(actionArgs);
  if (!map) return '';
  return `Args — ${map}.`;
}
