// tokens.mjs — the ONE token estimator.
//
// WHY IT LIVES HERE AND NOT ONLY IN internal/: the estimate is now part of
// the SERVER's output. Every envelope carries what the call cost, and every
// dispatch brief and worker contract carries what the prompt will cost — so
// the orchestrator can see the price of its own behaviour instead of
// discovering it at the end of a run.
//
// The repo's QA tool (`internal/tools/context-budget.mjs`) imports THIS one,
// so the number the CI gate reports and the number the server reports are
// the same number.
//
// Approximation via a BPE-style pre-tokenizer (±10% for English prose,
// markdown and YAML).

/** CJK + full-width ranges: ~1 token per character. */
const CJK_RE = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/gu;

/** Alphanumeric runs (letters, marks, numbers) — one "word" to the estimator. */
const WORD_RE = /[\p{L}\p{M}\p{N}]+/gu;

/**
 * Estimate the token count of a string.
 *
 * @param {string} text
 * @param {{calibration?: number}} [opts] multiplier on the raw estimate
 * @returns {number}
 */
export function estimateTokens(text, opts = {}) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const calibration = typeof opts.calibration === 'number' && opts.calibration > 0 ? opts.calibration : 1;

  let tokens = 0;

  // CJK first: these characters are \p{L}, so the word regex would swallow
  // them into long "words" and undercount badly.
  const cjk = text.match(CJK_RE);
  if (cjk) tokens += cjk.length;

  // Strip CJK so the latin pass never double-counts it.
  const latin = text.replace(CJK_RE, ' ');

  // Words: max(1, round(len/4)).
  const words = latin.match(WORD_RE);
  if (words) {
    for (const w of words) {
      const len = w.length;
      // Long identifiers/digits pack denser than prose (roughly len/3.5);
      // short words pack looser. One threshold keeps the model simple and
      // monotonic in length.
      tokens += len <= 6 ? 1 : Math.max(1, Math.round(len / (len > 12 ? 3.5 : 4)));
    }
  }

  // Symbols: every non-space, non-alphanumeric character is its own token
  // in practice ("tasks.yaml" -> "tasks" "." "yaml").
  const symbols = latin.match(/[^\s\p{L}\p{M}\p{N}]/gu);
  if (symbols) tokens += symbols.length;

  return Math.max(0, Math.round(tokens * calibration));
}
