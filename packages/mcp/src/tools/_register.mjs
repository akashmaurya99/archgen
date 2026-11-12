// _register.mjs — one place where a tool becomes an MCP tool.
//
// Every archgen tool follows the same contract:
//   - a Zod input schema (the only thing the model must get right)
//   - a handler that returns a plain payload or throws a typed ArchgenError
//   - the response is ALWAYS the envelope (ok / data / error / meta)
//
// Registering through one helper is what keeps the catalog uniform — and the
// catalog is what every client injects into the model's context, so its shape
// matters as much as the tool logic.
import { z } from 'zod/v4';
import { guard, toToolResult } from '../envelope.mjs';
import { ignoredArgsWarning, trackArgs } from '../core/protocol/action-args.mjs';
import { Context } from '../context.mjs';

/** The envelope, as seen by the client. Loose so `data` can be any shape. */
export const envelopeSchema = z
  .object({
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    meta: z.record(z.string(), z.unknown()),
  })
  .loose();

/**
 * Every registered tool, keyed by name.
 *
 * The CLI facade (`archgen-mcp exec <tool> '<json>'`) drives the SAME
 * handlers the MCP server exposes — there is no second implementation of any
 * tool, only a second way to reach it.
 */
const SPECS = new Map();

/**
 * Look up a registered tool spec by name.
 * @param {string} name
 */
export function getToolSpec(name) {
  return SPECS.get(name) ?? null;
}

/** Every registered tool name. */
export function registeredToolNames() {
  return [...SPECS.keys()];
}

/**
 * Run a tool's handler and shape its answer.
 *
 * ONE execution path. The MCP server and the CLI facade both reach the tools
 * through here, so a behaviour added for one — the ignored-argument warning,
 * the project-root selection — is never missing from the other.
 *
 * @param {any} spec the registered tool spec
 * @param {import('../context.mjs').Context} ctx the per-call context
 * @param {Record<string, unknown>} args the caller's arguments
 * @returns {Promise<{ok: boolean, data?: unknown, error?: object, meta: object}>}
 */
export async function runTool(spec, ctx, args) {
  // The schema is flat — one shape for every action — so a caller can pass an
  // argument its action never reads. The handler says so: the arguments are
  // tracked as they are read, and one that was passed and never read is
  // reported. The call still did what the action does.
  const tracked = trackArgs(args, spec.actionArgs);
  const envelope = await guard(spec.handler, ctx, tracked.args);
  const ignored = tracked.ignored();
  if (ignored.length && envelope.ok) {
    envelope.meta = {
      ...(envelope.meta ?? {}),
      warnings: [
        ...(envelope.meta?.warnings ?? []),
        ignoredArgsWarning(ignored, tracked.owners()),
      ],
    };
  }
  return envelope;
}

/**
 * Register one tool on the server.
 *
 * @param {import('@modelcontextprotocol/server').McpServer} server
 * @param {string} name tool name
 * @param {{
 *   title: string,
 *   description: string,
 *   inputSchema: z.ZodObject<any>,
 *   handler: (ctx: Context, args: any) => unknown|Promise<unknown>,
 *   readOnly?: boolean,
 *   destructive?: boolean,
 *   idempotent?: boolean,
 *   actionArgs?: Record<string, string[]>,
 * }} spec
 */
export function registerTool(server, name, spec) {
  SPECS.set(name, spec);
  server.registerTool(
    name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: envelopeSchema,
      annotations: {
        readOnlyHint: spec.readOnly === true,
        destructiveHint: spec.destructive === true,
        idempotentHint: spec.idempotent === true,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      // A tool may target a directory inside the project (a monorepo package,
      // a worktree under it). The projectRoot argument SELECTS one; it does
      // not define the boundary. The server's anchor does, and a selection
      // outside it is refused with PERMISSION_DENIED.
      const base = extra?.archgenContext ?? serverContext();
      const requested = args?.projectRoot;
      const ctx =
        typeof requested === 'string' && requested.trim() !== ''
          ? base.withProjectRoot(requested)
          : base;
      const envelope = await runTool(spec, ctx, args ?? {});
      return toToolResult(envelope);
    },
  );
}

/** The process-wide context (project root = cwd unless overridden). */
let cachedContext = null;
export function serverContext() {
  if (!cachedContext) cachedContext = new Context();
  return cachedContext;
}

/** Reset the cached context (tests). */
export function resetServerContext() {
  cachedContext = null;
}

/**
 * A common argument for every tool that touches the project.
 * Optional: when omitted the server's own project root (cwd) applies.
 *
 * The shared schema words live in core/universal-args.mjs — the routing map
 * needs the same list, and two copies of a list is a list that drifts. They
 * are re-exported here because every tool already imports them from this
 * module.
 */
export {
  projectRootArg,
  LIMIT_DESC,
  OFFSET_DESC,
  LOCATION_DESC,
  APPROVE_DESC,
} from '../core/protocol/universal-args.mjs';
