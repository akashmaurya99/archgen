// codegraph.mjs — the `archgen_codegraph` tool: install + wire + index
// CodeGraph (and CodeGraph's own MCP server).
//
// The tool DRIVES the official CodeGraph CLI — it never reimplements it. The
// MCP-config writing goes through the shared harness-wiring module, so the
// archgen MCP and the CodeGraph MCP are wired by the same code.
import { z } from 'zod/v4';
import { registerTool, projectRootArg, LIMIT_DESC, OFFSET_DESC, LOCATION_DESC, APPROVE_DESC } from './_register.mjs';
import { loadAsset } from '../context.mjs';
import { manageCodegraph, assertLocation } from '../core/codegraph-manager.mjs';
import { moreMeta, project, withMeta } from '../envelope.mjs';
const ACTION_DESC = 'ensure|status|wire';

/**
 * Keep the facts a caller acts on. The manager's internal report also carries
 * mode, projectRoot, empty wiring buckets, a null `latest` and per-status
 * duplicates — none of which the caller needs, and all of which it pays for.
 *
 * EVERY COLLECTION IS WINDOWED. The wiring lists grow with the number of
 * detected harnesses; the manual list grew one row per harness×location and
 * was never projected, so `limit: 2` still returned seven rows.
 *
 * @param {any} report
 * @param {{limit?: number, offset?: number}} [window]
 */
export function shapeReport(report, window = {}) {
  const out = {
    ok: report.ok !== false,
    changed: report.changed === true,
    alreadyConfigured: report.alreadyConfigured === true,
    cli: {
      present: report.cli?.present === true,
      version: report.cli?.version ?? null,
      action: report.cli?.action ?? 'none',
    },
    telemetry: report.telemetry ?? { state: 'unknown', action: 'none' },
    // The detected harnesses, ALWAYS present — the key set must not depend
    // on which path answered.
    detected: report.detected ?? [],
  };
  if (report.cli?.bin) out.cli.bin = report.cli.bin;
  // A failed or blocked install explains itself in `detail`; dropping it
  // leaves the caller with "failed" and no next step.
  if (report.cli?.detail) out.cli.detail = report.cli.detail;
  // The index state, flat. It is a fact a caller acts on ("is the project
  // indexed?"), and it must be present on BOTH bootstrap paths — the two
  // used to answer with different shapes for the same question.
  out.indexed = report.index?.initialized === true || report.index?.indexed === true;
  // The index block, ALWAYS present — one shape per fact.
  out.index = report.index ?? { action: 'none', initialized: false };
  // ALWAYS present, so the key set does not depend on which path answered.
  out.planned = report.planned === true;
  const native = report.wiring?.native ?? [];
  const manual = project(report.wiring?.manual ?? [], window);
  const skipped = report.wiring?.skipped ?? [];
  // The wiring buckets are ALWAYS present, so the key set does not depend on
  // which harness happened to be detected.
  out.wiring = {
    native,
    manual: manual.items,
    manualTotal: manual.total,
    skipped,
  };
  return out;
}

const schema = z.object({
  action: z.enum(['ensure', 'status', 'wire']).describe(ACTION_DESC),
  location: z.enum(['project', 'global', 'both']).optional().describe(LOCATION_DESC),
  approve: z.boolean().optional().describe(APPROVE_DESC),
  telemetry: z.enum(['keep', 'off', 'on']).optional().describe('keep|off|on (default keep).'),
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
    title: 'ArchGen CodeGraph',
    description:
      'Install, wire, or inspect CodeGraph (source-symbol index + MCP) and its project index. ' +
      'Run once per project; the watcher keeps the index live.',
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
      // The detected harnesses are a collection too.
      shaped.detected = project(report.detected ?? [], {
        ...window,
        next: `archgen_codegraph{action:'${args.action}',limit:${args.limit ?? 50},offset:${(args.offset ?? 0) + (args.limit ?? 50)}}`,
      }).items;
      const manualTotal = shaped.wiring?.manualTotal ?? 0;
      return withMeta(
        shaped,
        moreMeta({
          total: shaped.detected.length,
          returned: shaped.detected.length,
          next: undefined,
          available: { harnesses: shaped.detected.length, wiringManual: manualTotal },
        }),
      );
    },
  });
}
