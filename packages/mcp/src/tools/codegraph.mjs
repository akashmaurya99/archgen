// codegraph.mjs — the `archgen_codegraph` tool: install + wire + index
// CodeGraph (and CodeGraph's own MCP server).
//
// The tool DRIVES the official CodeGraph CLI — it never reimplements it. The
// MCP-config writing goes through the shared harness-wiring module, so the
// archgen MCP and the CodeGraph MCP are wired by the same code.
import { z } from 'zod/v4';
import { registerTool, projectRootArg, LIMIT_DESC, OFFSET_DESC, LOCATION_DESC, APPROVE_DESC } from './_register.mjs';
import { routingSentence } from '../core/routing.mjs';
import { loadAsset } from '../context.mjs';
import { manageCodegraph, assertLocation, shapeReport } from '../core/codegraph-manager.mjs';
import { toolCall } from '../core/call.mjs';
import { moreMeta, project, withMeta } from '../envelope.mjs';

/**
 * The arguments each action takes. An argument that belongs to another
 * action is a typed error, not a silent no-op.
 */
const CODEGRAPH_ACTION_ARGS = {
  ensure: ['location', 'approve', 'telemetry', 'noInstall', 'limit', 'offset'],
  status: ['location', 'approve', 'telemetry', 'noInstall', 'limit', 'offset'],
  wire: ['location', 'approve', 'telemetry', 'noInstall', 'limit', 'offset'],
};

const schema = z.object({
  action: z.enum(['ensure', 'status', 'wire']),
  location: z.enum(['project', 'global', 'both']).optional().describe(LOCATION_DESC),
  approve: z.boolean().optional().describe(APPROVE_DESC),
  telemetry: z.enum(['keep', 'off', 'on']).optional().describe('CodeGraph anonymous telemetry; off is machine-wide.'),
  noInstall: z.boolean().optional().describe('Do not install the CLI; use npx in configs.'),
  limit: z.number().int().positive().optional().describe(LIMIT_DESC),
  offset: z.number().int().nonnegative().optional().describe(OFFSET_DESC),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerCodegraphTools(server) {
  registerTool(server, 'archgen_codegraph', {
    actionArgs: CODEGRAPH_ACTION_ARGS,
    title: 'ArchGen CodeGraph',
    description:
      'Install, wire, or inspect CodeGraph (source-symbol index + MCP) and its project index. ' +
      'Run once per project; the watcher keeps the index live. ' +
      routingSentence(CODEGRAPH_ACTION_ARGS),
    inputSchema: schema,
    readOnly: false,
    destructive: false,
    idempotent: true,
    handler: async (ctx, args) => {
      const registry = loadAsset('harness-mcp.json');
      const location = assertLocation(args.location ?? 'both');
      const mode = args.action === 'status' ? 'status' : args.action === 'wire' ? 'wire' : 'ensure';
      const report = await manageCodegraph({
        mode,
        projectRoot: ctx.projectRoot,
        registry,
        location,
        approved: args.approve === true,
        telemetry: args.telemetry ?? 'keep',
        noInstall: args.noInstall === true,
        home: ctx.home,
        env: ctx.env,
      });
      // The wiring lists grow with the number of detected harnesses, so they
      // are bounded — and the agent is told what else it could fetch.
      const window = { limit: args.limit, offset: args.offset };
      const shaped = shapeReport(report, window);
      // The detected harnesses are a collection too — and the projection is
      // KEPT, so the total, the count and the continuation describe the WHOLE
      // list. Discarding it made `limit: 1` report a total of 1 and no
      // continuation, so eight harnesses were unreachable.
      const det = project(report.detected ?? [], {
        ...window,
        next: toolCall('archgen_codegraph', { action: args.action, limit: args.limit ?? 50, offset: (args.offset ?? 0) + (args.limit ?? 50) }),
      });
      shaped.detected = det.items;
      const manualTotal = shaped.wiring?.manualTotal ?? 0;
      return withMeta(
        shaped,
        moreMeta({
          total: det.total,
          returned: det.returned,
          next: det.next,
          more: manualTotal > shaped.wiring?.manual?.length
            ? toolCall('archgen_codegraph', { action: args.action, limit: args.limit ?? 50, offset: (args.offset ?? 0) + (args.limit ?? 50) })
            : undefined,
          available: { harnesses: det.total, wiringManual: manualTotal },
        }),
      );
    },
  });
}
