// setup.mjs — the `archgen_setup` tool: install, MCP wiring, health.
import { z } from 'zod/v4';
import { registerTool, projectRootArg } from './_register.mjs';
import { loadAsset } from '../context.mjs';
import { wireArchgenMcp, archgenMcpStatus, resolveMcpBinary, uninstallArchgenMcp } from '../core/mcp-server-manager.mjs';
import { manageCodegraph, assertLocation, findCodegraph } from '../core/codegraph-manager.mjs';
import { detectHarnesses } from '../core/harness-wiring.mjs';
import { platformCapabilities, detectHarness } from '../core/platform-caps.mjs';
import { checkCapability } from '../core/compat.mjs';
import { invalidInput } from '../core/errors.mjs';
import { moreMeta, project, withMeta } from '../envelope.mjs';

const ACTION_DESC =
  'doctor | bootstrap | install_mcp | uninstall_mcp | harnesses | harness_info — see archgen_help.';

const schema = z.object({
  action: z.enum(['doctor', 'bootstrap', 'install_mcp', 'uninstall_mcp', 'harnesses', 'harness_info']).describe(ACTION_DESC),
  location: z.enum(['project', 'global', 'both']).optional().describe('Which scope to wire. Defaults to both.'),
  approve: z.boolean().optional().describe('Required to write any MCP config. Without it you get the plan and nothing is written.'),
  telemetry: z.enum(['keep', 'off', 'on']).optional().describe('CodeGraph telemetry preference (bootstrap).'),
  harness: z.string().optional().describe('Harness id (harness_info, harnesses). One harness (harnesses).'),
  limit: z.number().int().positive().optional().describe('Max items to return. Default 50.'),
  offset: z.number().int().nonnegative().optional().describe('Skip this many items.'),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerSetupTools(server) {
  registerTool(server, 'archgen_setup', {
    title: 'ArchGen setup',
    description:
      'Install and wire archgen: report the health of an install, wire the archgen MCP server into every detected ' +
      'harness, bootstrap CodeGraph (CLI + its MCP + the project index), or remove what was wired.',
    inputSchema: schema,
    readOnly: false,
    destructive: false,
    idempotent: true,
    handler: async (ctx, args) => {
      const registry = loadAsset('harness-mcp.json');
      const location = assertLocation(args.location ?? 'both');
      const approved = args.approve === true;

      if (args.action === 'harness_info') {
        const caps = loadAsset('platform-capabilities.json');
        if (args.harness) return platformCapabilities(caps, args.harness);
        // No explicit harness: report the detected one, and never throw — an
        // unknown platform is a normal situation (the skill has a procedure
        // for it), not an error.
        try {
          return detectHarness(caps, { projectRoot: ctx.projectRoot, home: ctx.home });
        } catch (e) {
          return {
            detected: null,
            reason: e instanceof Error ? e.message : String(e),
            nextStep: 'Unknown platform: web-search the official MCP + skills docs, propose findings, get user approval.',
            harnesses: Object.entries(caps.harnesses ?? {}).map(([id, h]) => ({ id, label: h.label })),
            universal: caps.universal ?? null,
          };
        }
      }

      if (args.action === 'harnesses') {
        const detected = detectHarnesses(registry, ctx.projectRoot, ctx.home, ctx.env);
        const rows = detected.map((d) => ({
          id: d.id,
          label: d.label,
          atHome: d.atHome,
          atProject: d.atProject,
          configs: Object.entries(d.spec.configs ?? {}).map(([loc, cfg]) => ({
            location: loc,
            path: cfg.path,
            key: cfg.key ?? `mcp_servers.archgen`,
            format: cfg.format ?? 'json',
          })),
        }));
        // ONE harness, when the caller named one.
        if (args.harness) {
          const one = rows.find((r) => r.id === args.harness);
          if (!one) {
            throw invalidInput(`unknown harness '${args.harness}'`, {
              action: args.action,
              harness: args.harness,
              available: rows.map((r) => r.id),
            });
          }
          return {
            location,
            detected: [one],
            binary: resolveMcpBinary({ projectRoot: ctx.projectRoot, home: ctx.home, env: ctx.env }),
          };
        }
        const p = project(rows, {
          limit: args.limit,
          offset: args.offset,
          next: `archgen_setup{action:'harnesses',limit:${args.limit ?? 50},offset:${(args.offset ?? 0) + (args.limit ?? 50)}}`,
        });
        return withMeta(
          {
            location,
            // ONE copy of the rows: the same array under two keys was the
            // payload saying the same thing twice.
            detected: p.items,
            binary: resolveMcpBinary({ projectRoot: ctx.projectRoot, home: ctx.home, env: ctx.env }),
          },
          moreMeta({
            total: p.total,
            returned: p.returned,
            next: p.next,
            available: { harnesses: p.total },
            more: `archgen_setup{action:'harnesses',harness:'<one harness>'}`,
          }),
        );
      }

      if (args.action === 'doctor') {
        const status = archgenMcpStatus({ projectRoot: ctx.projectRoot, registry, home: ctx.home });
        const codegraph = findCodegraph(ctx.env);
        const checks = [];

        // THE CAPABILITY CONTRACT — the skill declares the server version it
        // needs; this is where a mismatch surfaces instead of failing silently
        // later as "the agent called an action that no longer exists".
        const compat = checkCapability({ skillDir: ctx.skill?.path ?? null, serverVersion: ctx.serverVersion });
        checks.push({
          status: compat.compatible ? 'OK' : 'FAIL',
          msg: !ctx.skill
            ? 'capability contract — no skill installed, nothing to check (run `npx archgen-skill init`)'
            : compat.compatible
              ? `capability contract satisfied (skill requires archgen-mcp ${compat.required}, server is ${compat.running})`
              : `CAPABILITY MISMATCH — ${compat.reason}. Update the server: npm i -g archgen-mcp@latest`,
        });

        checks.push({
          status: ctx.skill ? 'OK' : 'WARN',
          msg: ctx.skill
            ? `skill installed at ${ctx.skill.path} (${ctx.skill.version ?? 'unknown version'})`
            : 'skill not found — run `npx archgen-skill init` in the project root',
        });
        checks.push({
          status: status.binary.bin ? 'OK' : 'WARN',
          msg: `archgen-mcp binary: ${status.binary.bin ?? 'not on PATH (npx fallback used)'} (${status.binary.source})`,
        });
        checks.push({
          status: codegraph ? 'OK' : 'WARN',
          msg: codegraph ? `codegraph ${codegraph.version} at ${codegraph.bin}` : 'codegraph not installed — run archgen_codegraph { action: "ensure" }',
        });
        checks.push({
          status: 'OK',
          msg: `node ${process.versions.node} · server ${ctx.serverVersion}`,
        });
        return {
          checks,
          tally: checks.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {}),
          versions: { skill: ctx.skill?.version ?? null, server: ctx.serverVersion, codegraph: codegraph?.version ?? null },
          mcpTargets: status.targets,
          node: process.versions.node,
        };
      }

      if (args.action === 'uninstall_mcp') {
        if (!approved) {
          return { written: false, planned: true, detail: 'uninstall_mcp needs approve: true — nothing was removed' };
        }
        // The scope is honoured: removing only the global wiring leaves the
        // project's wiring in place, and vice versa.
        return {
          written: true,
          ...uninstallArchgenMcp(ctx.projectRoot, ctx.home, location, ctx.env),
        };
      }

      if (args.action === 'install_mcp') {
        const res = wireArchgenMcp({
          projectRoot: ctx.projectRoot,
          registry,
          home: ctx.home,
          location,
          approved,
          env: ctx.env,
        });
        return res;
      }

      // bootstrap — wire archgen MCP AND ensure CodeGraph, in one report.
      // A capability mismatch is reported, never silently ignored: wiring a
      // skill to an incompatible server is how a broken install is born.
      const compat = checkCapability({ skillDir: ctx.skill?.path ?? null, serverVersion: ctx.serverVersion });
      const mcp = wireArchgenMcp({
        projectRoot: ctx.projectRoot,
        registry,
        home: ctx.home,
        location,
        approved,
        env: ctx.env,
      });
      const codegraph = await manageCodegraph({
        mode: 'ensure',
        projectRoot: ctx.projectRoot,
        registry,
        location,
        approved,
        telemetry: args.telemetry ?? 'keep',
        home: ctx.home,
        env: ctx.env,
      });
      return {
        compat,
        mcp: { detected: mcp.detected, wired: mcp.wired, planned: mcp.planned, binary: mcp.binary },
        codegraph,
        ok: codegraph.ok !== false,
      };
    },
  });
}
