// registry.mjs — the `archgen_registry` tool: the AGENTS.md features registry.
//
// The registry is machine-maintained. An agent that hand-edits it, or that
// forgets to refresh it after a wave, leaves every harness reading a stale
// feature map. This tool is the only sanctioned writer.
import { z } from 'zod/v4';
import { registerTool, projectRootArg } from './_register.mjs';
import { updateRegistry, showRegistry, DISPLAY_STATUSES } from '../core/registry-updater.mjs';

const schema = z.object({
  action: z.enum(['update', 'show']).describe('update = rewrite the registry from .archgen/; show = read it without writing.'),
  projectRoot: projectRootArg,
  slug: z.string().optional().describe('Upsert one feature row (update). Requires status.'),
  status: z.enum(DISPLAY_STATUSES).optional().describe('Registry status for the upserted row (update).'),
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerRegistryTools(server) {
  registerTool(server, 'archgen_registry', {
    title: 'ArchGen registry',
    description:
      'Keep the AGENTS.md features registry in sync with .archgen/. Call update after every task completes ' +
      'and after every plan change — the registry is what every harness reads to know what exists.',
    inputSchema: schema,
    readOnly: false,
    destructive: false,
    idempotent: true,
    handler: (ctx, args) => {
      if (args.action === 'show') return showRegistry(ctx.projectRoot);
      return updateRegistry(ctx.projectRoot, { slug: args.slug ?? null, status: args.status ?? null });
    },
  });
}
