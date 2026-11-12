// registry.mjs — the `archgen_registry` tool: the AGENTS.md features registry.
//
// The registry is machine-maintained. An agent that hand-edits it, or that
// forgets to refresh it after a wave, leaves every harness reading a stale
// feature map. This tool is the only sanctioned writer.
import { z } from 'zod/v4';
import { registerTool, projectRootArg, LIMIT_DESC, OFFSET_DESC } from './_register.mjs';
import { routingSentence } from '../core/protocol/routing.mjs';
import { updateRegistry, showRegistry, DISPLAY_STATUSES } from '../core/skill/registry-updater.mjs';
import { toolCall } from '../core/protocol/call.mjs';
import { moreMeta, project, withMeta } from '../envelope.mjs';

/**
 * The arguments each action takes. An argument that belongs to another
 * action is a typed error, not a silent no-op.
 */
const REGISTRY_ACTION_ARGS = {
  show: ['limit', 'offset'],
  update: ['slug', 'status', 'limit', 'offset'],
};

const schema = z.object({
  action: z.enum(['update', 'show']),
  projectRoot: projectRootArg,
  slug: z.string().optional().describe('Upsert one feature row; needs status.'),
  status: z.enum(DISPLAY_STATUSES).optional().describe('Status for the upserted row.'),
  limit: z.number().int().positive().optional().describe(LIMIT_DESC),
  offset: z.number().int().nonnegative().optional().describe(OFFSET_DESC),
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerRegistryTools(server) {
  registerTool(server, 'archgen_registry', {
    actionArgs: REGISTRY_ACTION_ARGS,
    title: 'ArchGen registry',
    description: 'Read or rewrite the AGENTS.md features registry from .archgen/. ' + routingSentence(REGISTRY_ACTION_ARGS),
    inputSchema: schema,
    readOnly: false,
    destructive: false,
    idempotent: true,
    handler: (ctx, args) => {
      if (args.action === 'show') {
        const shown = showRegistry(ctx.projectRoot);
        const p = project(shown.rows ?? [], {
          limit: args.limit,
          offset: args.offset,
          next: toolCall('archgen_registry', { action: 'show', limit: args.limit ?? 50, offset: (args.offset ?? 0) + (args.limit ?? 50) }),
        });
        return withMeta(
          { ...shown, rows: p.items },
          moreMeta({ total: p.total, returned: p.returned, next: p.next, available: { rows: p.total } }),
        );
      }
      return updateRegistry(ctx.projectRoot, { slug: args.slug ?? null, status: args.status ?? null });
    },
  });
}
