// envelope.mjs — the single response shape every tool returns.
//
// WHY AN ENVELOPE: an agent consumes dozens of tool results per session. If
// each tool invents its own shape, the model has to re-learn the contract on
// every call. One envelope means: `ok` says whether it worked, `data` is the
// payload, `error` is a typed machine-readable failure, `meta` carries the
// versions and warnings. Failures are DATA, not protocol errors — the model
// can read a failure and act on it (fix the YAML, resolve the cycle, retry
// with force).
import { toArchgenError } from './core/protocol/errors.mjs';

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
    // A tool that carries its own meta (the map to the rest of the data)
    // EXTENDS the envelope's meta — it never replaces it. The envelope's
    // meta is the contract (server version, skill version, project root,
    // warnings); the tool's meta is the map to whatever it did not send.
    const own = typeof data === 'object' && data !== null && data.__meta ? data.__meta : null;
    const meta = own ? { ...ctx.meta(), ...own } : ctx.meta();
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

// ── collection projection ───────────────────────────────────────────────────
//
// WHY: a tool that answers "give me everything in this collection" makes the
// agent pay for the whole collection every time it needs ONE item — and the
// only way to get one item is to take the whole collection and pick from it.
// That is the wrong default for both sides: the server sends text nobody
// asked for, and the agent pays for it in context.
//
// The fix is not a smaller cap — a cap silently truncates, and the agent
// cannot tell what it missed. It is a SELECTOR plus a MAP TO THE REST: every
// collection-shaped answer can be narrowed to one item, and every answer says
// what else exists and exactly how to fetch it. The agent fetches; it never
// receives a dump.

/**
 * The default bound on a collection.
 *
 * It exists so a LARGE project cannot dump itself: a 500-task plan, a
 * 250-node graph, a 200-file artifact tree. The bound is the CALLER's to
 * raise (`limit`), and every answer says how many items exist and exactly
 * which call returns the next slice — so a bound never hides data, it only
 * makes the agent ask for it.
 */
export const DEFAULT_LIMIT = 50;

/**
 * Narrow a collection to what the caller asked for, and report what is left.
 *
 * `limit` is the caller's bound, not the server's: a caller that needs the
 * whole set asks for it (`limit: null` means no bound). The default is
 * finite so a huge collection is never dumped — and the report says exactly
 * how many remain and which call gets the next slice.
 *
 * @param {any[]} items
 * @param {{limit?: number|null, offset?: number|null, next?: string|null}} [opts]
 * @returns {{items: any[], total: number, returned: number, offset: number, limit: number|null, truncated: boolean, next: string|null}}
 */
export function project(items, opts = {}) {
  const all = Array.isArray(items) ? items : [];
  const offset = Math.max(0, Number(opts.offset ?? 0) || 0);
  const rawLimit = opts.limit === undefined ? DEFAULT_LIMIT : opts.limit;
  const limit = rawLimit === null ? null : Math.max(0, Math.trunc(Number(rawLimit) || 0));
  const slice = limit === null ? all.slice(offset) : all.slice(offset, offset + limit);
  const truncated = offset + slice.length < all.length;
  return {
    items: slice,
    total: all.length,
    returned: slice.length,
    offset,
    limit,
    truncated,
    // The exact next call — not a hint, not a cursor the agent has to build.
    next: truncated ? (opts.next ?? null) : null,
  };
}

/**
 * The uniform "what else is there" block.
 *
 * Every collection-shaped answer carries it, so the agent always knows that
 * more exists and exactly how to get it — without the server having sent any
 * of it.
 *
 * @param {{total?: number, returned?: number, available?: object, more?: string|null, next?: string|null}} info
 * @returns {object}
 */
export function moreMeta(info = {}) {
  const meta = {};
  if (info.total !== undefined) meta.total = info.total;
  if (info.returned !== undefined) meta.returned = info.returned;
  if (info.available && Object.keys(info.available).length) meta.available = info.available;
  if (info.more) meta.more = info.more;
  if (info.next) meta.next = info.next;
  return meta;
}

/**
 * Attach meta to a payload.
 *
 * The envelope already understands this shape (`__meta` is lifted out of the
 * data), so a tool can add the map to the rest without knowing anything
 * about the envelope.
 *
 * @param {unknown} data
 * @param {object} meta
 * @returns {{data: unknown, __meta: object}}
 */
export function withMeta(data, meta) {
  return { data, __meta: meta };
}

