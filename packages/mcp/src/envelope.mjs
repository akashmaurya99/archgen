// envelope.mjs — the single response shape every tool returns.
//
// WHY AN ENVELOPE: an agent consumes dozens of tool results per session. If
// each tool invents its own shape, the model has to re-learn the contract on
// every call. One envelope means: `ok` says whether it worked, `data` is the
// payload, `error` is a typed machine-readable failure, `meta` carries the
// versions and warnings. Failures are DATA, not protocol errors — the model
// can read a failure and act on it (fix the YAML, resolve the cycle, retry
// with force).
import { toArchgenError } from './core/errors.mjs';

/**
 * Build a successful tool result.
 * @param {unknown} data the payload
 * @param {object} [meta] the context meta block
 * @returns {{ok: true, data: unknown, meta: object}}
 */
export function ok(data, meta = {}) {
  return { ok: true, data, meta };
}

/**
 * Build a failed tool result. NEVER throws — a failed capability is a
 * readable result, not a crashed server.
 * @param {unknown} e the thrown value
 * @param {object} [meta] the context meta block
 * @returns {{ok: false, error: {code: string, message: string, details: object}, meta: object}}
 */
export function fail(e, meta = {}) {
  const err = toArchgenError(e);
  return { ok: false, error: err.toJSON(), meta };
}

/**
 * Wrap a tool body so every outcome — success, typed failure, or an
 * unexpected throw — comes back in the envelope.
 * @param {(ctx: any, args: any) => Promise<unknown>|unknown} body
 * @param {object} ctx
 * @param {object} args
 * @returns {Promise<{ok: boolean, data?: unknown, error?: object, meta: object}>}
 */
export async function guard(body, ctx, args) {
  try {
    const data = await body(ctx, args);
    const meta = typeof data === 'object' && data !== null && data.__meta ? data.__meta : ctx.meta();
    const payload = typeof data === 'object' && data !== null && data.__meta ? data.data : data;
    return ok(payload, meta);
  } catch (e) {
    return fail(e, ctx.meta());
  }
}

/**
 * Convert an envelope into the MCP tool-call result shape.
 * @param {{ok: boolean, data?: unknown, error?: object, meta: object}} envelope
 * @returns {{content: Array<{type: 'text', text: string}>, structuredContent: object, isError?: boolean}}
 */
export function toToolResult(envelope) {
  const text = JSON.stringify(envelope, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: envelope,
    ...(envelope.ok ? {} : { isError: true }),
  };
}
