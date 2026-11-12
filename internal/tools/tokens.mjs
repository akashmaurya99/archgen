// tokens.mjs — token helpers for the internal context-budget tool.
//
// The ESTIMATOR lives in the MCP package (`packages/mcp/src/core/protocol/tokens.mjs`)
// because the server now reports the cost of its own calls. This file
// re-exports it — so the number the CI gate prints and the number the
// server reports are the same number — and adds the optional exact-tokenizer
// path the QA tool can use when a tokenizer is installed.

export { estimateTokens } from '../../packages/mcp/src/core/protocol/tokens.mjs';

/**
 * Exact count from an installed tokenizer (gpt-tokenizer / js-tiktoken);
 * null when unavailable, so callers fall back to the estimator.
 */
export async function exactTokens(text, moduleName) {
  if (!moduleName) return null;
  let mod;
  try {
    mod = await import(moduleName);
  } catch {
    return null;
  }
  try {
    if (typeof mod.encode === 'function') {
      const out = mod.encode(text);
      if (Array.isArray(out)) return out.length;
      if (out && typeof out.length === 'number') return out.length;
    }
    if (typeof mod.encodeText === 'function') {
      const out = mod.encodeText(text);
      if (Array.isArray(out)) return out.length;
      if (out && typeof out.length === 'number') return out.length;
    }
    if (typeof mod.getEncoding === 'function') {
      const enc = mod.getEncoding('cl100k_base');
      const out = enc.encode(text);
      if (Array.isArray(out)) return out.length;
    }
  } catch {
    return null;
  }
  return null;
}

/** Human-readable token count. */
export function fmtTokens(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}

/** Percentage of a window, clamped to 4 decimals. */
export function pctOf(tokens, window) {
  if (!window) return 0;
  return Math.round((tokens / window) * 10000) / 100;
}
