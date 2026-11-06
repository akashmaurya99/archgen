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
      const envelope = await guard(spec.handler, ctx, args ?? {});
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
 */
export const projectRootArg = z
  .string()
  .optional()
  .describe('Absolute path to the project root. Defaults to the server working directory.');
