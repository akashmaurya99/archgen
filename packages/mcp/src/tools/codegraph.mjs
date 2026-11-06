// codegraph.mjs — the `archgen_codegraph` tool: install + wire + index
// CodeGraph (and CodeGraph's own MCP server).
//
// The tool DRIVES the official CodeGraph CLI — it never reimplements it. The
// MCP-config writing goes through the shared harness-wiring module, so the
// archgen MCP and the CodeGraph MCP are wired by the same code.
import { z } from 'zod/v4';
import { registerTool, projectRootArg } from './_register.mjs';
import { loadAsset } from '../context.mjs';
import { manageCodegraph, assertLocation } from '../core/codegraph-manager.mjs';

const ACTION_DESC = 'ensure | status | wire — see archgen_help.';

const schema = z.object({
  action: z.enum(['ensure', 'status', 'wire']).describe(ACTION_DESC),
  location: z.enum(['project', 'global', 'both']).optional().describe('Which scope to wire. Defaults to both.'),
  approve: z.boolean().optional().describe('Required to write any MCP config. Without it you get the plan and nothing is written.'),
  telemetry: z.enum(['keep', 'off', 'on']).optional().describe('Telemetry preference. Defaults to keep (leave as-is).'),
  noUpgrade: z.boolean().optional().describe('Do not upgrade an existing CodeGraph CLI.'),
  noInstall: z.boolean().optional().describe('Do not install the CLI; use the npx fallback in configs.'),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerCodegraphTools(server) {
  registerTool(server, 'archgen_codegraph', {
    title: 'ArchGen CodeGraph',
    description:
      'Install, wire and index CodeGraph — the source-symbol index — and its MCP server. ' +
      'Run once per project when .codegraph/ is missing; the index stays live afterwards, so never re-index.',
    inputSchema: schema,
    readOnly: false,
    destructive: false,
    idempotent: true,
    handler: async (ctx, args) => {
      const registry = loadAsset('harness-mcp.json');
      const location = assertLocation(args.location ?? 'both');
      const mode = args.action === 'status' ? 'status' : args.action === 'wire' ? 'wire' : 'ensure';
      return manageCodegraph({
        mode,
        projectRoot: ctx.projectRoot,
        registry,
        location,
        approved: args.approve === true,
        telemetry: args.telemetry ?? 'keep',
        noUpgrade: args.noUpgrade === true,
        noInstall: args.noInstall === true,
        home: ctx.home,
        env: ctx.env,
      });
    },
  });
}
