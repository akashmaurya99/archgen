// diagnostics.mjs — one shape for every finding, and the rules that shape it.
//
// WHY A FINDING AND NOT A STRING. A finding has to carry three things: the
// class it belongs to (so fixes can be grouped), where it is (so the agent
// can go straight to it), and what to do (so it does not have to guess). A
// bare sentence carries none of them, and the validator used to report bare
// sentences — so the same defect surfaced under a different name depending
// on which tool the agent called.
//
// The shape is deliberately small. `code` groups, `message` locates, `fix`
// completes. The rule behind a code lives in codes.mjs, which the reference
// document also reads, so a code is never documented in one place and
// emitted from another.
//
// TWO RENDERINGS, ONE FINDING. The validator returns the structured finding;
// the floor renders it as one line (`CODE: message — fix`) because a gate
// brief reads as prose and a line is what a reviewer can quote. Both come
// from the same object, so they cannot disagree.

/**
 * @typedef {{code: string, message: string, fix?: string}} Finding
 */

/**
 * Build a finding.
 *
 * @param {string} code stable code; see codes.mjs
 * @param {string} message what is wrong, naming the field it is in
 * @param {{fix?: string}} [spec] the action that clears it
 * @returns {Finding}
 */
export function finding(code, message, spec = {}) {
  const out = { code, message };
  if (spec.fix) out.fix = spec.fix;
  return out;
}

/**
 * Render a finding as one line: `CODE: message — fix`.
 *
 * @param {Finding} f
 * @returns {string}
 */
function formatFinding(f) {
  return f.fix ? `${f.code}: ${f.message} — ${f.fix}` : `${f.code}: ${f.message}`;
}

/**
 * Render a list of findings as lines.
 *
 * @param {Finding[]} findings
 * @returns {string[]}
 */
export function formatFindings(findings) {
  return findings.map(formatFinding);
}

/**
 * Count findings by code.
 *
 * @param {Finding[]} findings
 * @returns {Record<string, number>}
 */
export function countByCode(findings) {
  const out = {};
  for (const f of findings) out[f.code] = (out[f.code] ?? 0) + 1;
  return out;
}
