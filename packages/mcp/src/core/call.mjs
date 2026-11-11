// call.mjs — build an archgen tool call the agent can paste back.
//
// WHY IT EXISTS. Every continuation string was hand-written at each call
// site: `archgen_docs{action:'refs',token:'${args.token}'}`. A value holding
// an apostrophe produced a call that would not parse — and the skill tells
// the agent to FETCH the named call, so the broken string cost a round-trip
// and taught the agent nothing.
//
// One builder: the values are escaped, the shape is uniform, and the action
// is named once instead of at every site.

/**
 * Render one value for a tool call.
 *
 * Numbers and booleans stay bare; everything else is single-quoted, with
 * the backslash and the apostrophe escaped — the two characters that would
 * otherwise end the string early.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function callValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(callValue).join(',')}]`;
  const text = String(value ?? '');
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Build a tool call.
 *
 * @param {string} tool the tool name, e.g. `archgen_plan`
 * @param {Record<string, unknown>} args the arguments, in the order they read
 * @returns {string}
 */
export function toolCall(tool, args) {
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}:${callValue(v)}`);
  return `${tool}{${parts.join(',')}}`;
}
