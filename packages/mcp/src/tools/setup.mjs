// setup.mjs — the `archgen_setup` tool: install, MCP wiring, health.
import { z } from 'zod/v4';
import { registerTool, projectRootArg, LIMIT_DESC, OFFSET_DESC, LOCATION_DESC, APPROVE_DESC } from './_register.mjs';
import { loadAsset } from '../context.mjs';
import { wireArchgenMcp, archgenMcpStatus, resolveMcpBinary, uninstallArchgenMcp } from '../core/mcp-server-manager.mjs';
import { manageCodegraph, assertLocation, findCodegraph, codegraphState } from '../core/codegraph-manager.mjs';
import { shapeReport } from './codegraph.mjs';
import { getToolSpec, registeredToolNames } from './_register.mjs';
import { detectHarnesses } from '../core/harness-wiring.mjs';
import { platformCapabilities, detectHarness } from '../core/platform-caps.mjs';
import { checkCapability } from '../core/compat.mjs';
import { invalidInput } from '../core/errors.mjs';
import { moreMeta, project, withMeta } from '../envelope.mjs';

const ACTION_DESC = 'doctor|bootstrap|install_mcp|uninstall_mcp|harnesses|harness_info';

const schema = z.object({
  action: z.enum(['doctor', 'bootstrap', 'install_mcp', 'uninstall_mcp', 'harnesses', 'harness_info']).describe(ACTION_DESC),
  location: z.enum(['project', 'global', 'both']).optional().describe(LOCATION_DESC),
  approve: z.boolean().optional().describe(APPROVE_DESC),
  telemetry: z.enum(['keep', 'off', 'on']).optional().describe('keep|off|on (bootstrap).'),
  harness: z.string().optional().describe('Harness id (harnesses, harness_info).'),
  limit: z.number().int().positive().optional().describe(LIMIT_DESC),
  offset: z.number().int().nonnegative().optional().describe(OFFSET_DESC),
  projectRoot: projectRootArg,
});

/**
 * Collapse a wiring result into counts. The per-config rows are useful when a
 * write fails; on the happy path they repeat the same status for every
 * harness and cost more than they say.
 *
 * @param {{detected: string[], wired: Array<Record<string, any>>, planned: boolean, binary: any}} result
 */
export function summarizeWiring(result) {
  const rows = result.wired ?? [];
  const failed = rows.filter((w) => w.status === 'error');
  // A SKIPPED row is not noise: the config exists but could not be merged
  // (unreadable, unparseable, or a format we refuse to rewrite), so the
  // harness is still missing the server. Silence here looks like success.
  const skipped = rows.filter((w) => w.status === 'skipped');
  const summary = {
    detected: result.detected ?? [],
    written: rows.filter((w) => w.status === 'written').length,
    unchanged: rows.filter((w) => w.status === 'unchanged').length,
    planned: rows.filter((w) => w.status === 'planned').length,
    binary: { bin: result.binary?.bin ?? null, source: result.binary?.source ?? null },
  };
  if (failed.length) {
    summary.failed = failed.map((w) => ({ harness: w.harness, path: w.path, detail: w.detail }));
  }
  if (skipped.length) {
    summary.skipped = skipped.map((w) => ({ harness: w.harness, path: w.path, detail: w.detail }));
  }
  return summary;
}

/**
 * What the RUNNING server actually offers, per tool.
 *
 * WHY THIS EXISTS. A client caches the tool catalog it was handed when the
 * session connected. If the server is upgraded afterwards, the client keeps
 * validating against the old schema and rejects a valid action with the old
 * allowed values — while `doctor` (whose own action list never changed)
 * reports the new server version. The two facts look contradictory.
 *
 * This inventory settles it in ONE call: it is the server's own action list,
 * so comparing it with the client's schema says which of the two is stale.
 *
 * @returns {Record<string, string[]>}
 */
export function serverActionInventory() {
  const out = {};
  for (const name of registeredToolNames()) {
    const spec = getToolSpec(name);
    const action = spec?.inputSchema?.shape?.action;
    const values = action?._def?.values ?? action?.options ?? null;
    if (Array.isArray(values)) out[name] = values.slice();
  }
  return out;
}

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerSetupTools(server) {
  registerTool(server, 'archgen_setup', {
    title: 'ArchGen setup',
    description:
      'ArchGen install health and wiring: doctor, bootstrap, install/uninstall MCP, ' +
      'detected harnesses, and harness capabilities.',
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
        // ONE SHAPE, always. The answer used to be the capability row when
        // a harness was named, the detection block when it was not, and a
        // third block when detection threw — so a client had to branch on
        // the RESPONSE to know what it got.
        const base = {
          harness: args.harness ?? null,
          detected: null,
          primary: null,
          capabilities: null,
          harnesses: Object.entries(caps.harnesses ?? {}).map(([id, h]) => ({ id, label: h.label })),
          universal: caps.universal ?? null,
          // ALWAYS present, so the key set does not depend on which branch
          // answered.
          reason: null,
          nextStep: null,
        };
        if (args.harness) {
          // The named harness's row goes INSIDE the envelope, not instead
          // of it.
          return { ...base, harness: args.harness, capabilities: platformCapabilities(caps, args.harness) };
        }
        try {
          const detected = detectHarness(caps, { projectRoot: ctx.projectRoot, home: ctx.home });
          return {
            ...base,
            detected: detected.detected ?? [],
            primary: detected.primary ?? null,
            capabilities: detected.capabilities ?? null,
          };
        } catch (e) {
          return {
            ...base,
            reason: e instanceof Error ? e.message : String(e),
            nextStep: 'Unknown platform: web-search the official MCP + skills docs, propose findings, get user approval.',
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
          // The LOCATION FILTER IS APPLIED. It used to be accepted, echoed
          // and ignored, so `location:'project'` still listed the global
          // config path — and the agent wired the wrong file.
          configs: Object.entries(d.spec.configs ?? {})
            .filter(([loc]) => location === 'both' || loc === location)
            .map(([loc, cfg]) => ({
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
        const status = archgenMcpStatus({ projectRoot: ctx.projectRoot, registry, home: ctx.home, env: ctx.env });
        const codegraph = findCodegraph(ctx.env);
        const checks = [];

        // THE CAPABILITY CONTRACT — the skill declares the server version it
        // needs; this is where a mismatch surfaces instead of failing silently
        // later as "the agent called an action that no longer exists".
        const compat = checkCapability({ skillDir: ctx.skill?.path ?? null, serverVersion: ctx.serverVersion });
        checks.push({
          status: compat.compatible ? 'OK' : 'FAIL',
          msg: !ctx.skill
            ? 'no skill installed — run `npx archgen-skill init`'
            : compat.compatible
              ? `capability contract satisfied (needs archgen-mcp ${compat.required}; running ${compat.running})`
              : `CAPABILITY MISMATCH — ${compat.reason}. Update: npm i -g archgen-mcp@latest`,
        });
        checks.push({
          status: ctx.skill ? 'OK' : 'WARN',
          msg: ctx.skill
            ? `skill installed at ${ctx.skill.path} (${ctx.skill.version ?? 'unknown version'})`
            : 'skill not found — run `npx archgen-skill init` in the project root',
        });
        checks.push({
          status: status.binary.bin ? 'OK' : 'WARN',
          msg: status.binary.bin
            ? `archgen-mcp binary: ${status.binary.bin} (${status.binary.source})`
            : 'archgen-mcp not on PATH — npx fallback will be used',
        });
        checks.push({
          status: codegraph ? 'OK' : 'WARN',
          msg: codegraph
            ? `codegraph ${codegraph.version} at ${codegraph.bin}`
            : 'codegraph not installed — run archgen_codegraph { action: "ensure" }',
        });
        checks.push({
          status: 'OK',
          msg: `node ${process.versions.node} · server ${ctx.serverVersion}`,
        });
        // Only a problem is worth reporting. A healthy install answers with
        // its summary and versions; the five OK rows were the same bytes on
        // every call.
        const issues = checks.filter((c) => c.status !== 'OK');
        const failed = issues.some((c) => c.status === 'FAIL');
        // The RUNNING server's action inventory — the fact that makes a
        // stale CLIENT catalog diagnosable instead of baffling.
        const inventory = serverActionInventory();
        return {
          status: failed ? 'FAIL' : issues.length ? 'WARN' : 'OK',
          // The denominator is the number of checks RUN — the summary used
          // the filtered list's length, so it said "2/5 checks OK" while the
          // payload carried three rows. The caller could not reconcile them.
          summary: `${checks.length - issues.length}/${checks.length} checks OK`,
          checksTotal: checks.length,
          checks: issues,
          versions: {
            skill: ctx.skill?.version ?? null,
            server: ctx.serverVersion,
            codegraph: codegraph?.version ?? null,
          },
          serverActions: inventory,
          serverActionsHint:
            'The actions this server offers. If your tool schema lists fewer, your client is holding a stale catalog — ' +
            'reload the session so it re-fetches the tool list.',
        };
      }

      if (args.action === 'uninstall_mcp') {
        if (!approved) {
          return { written: false, planned: true, detail: 'uninstall_mcp needs approve: true — nothing was removed' };
        }
        // The scope is honoured: removing only the global wiring leaves the
        // project's wiring in place, and vice versa.
        const result = uninstallArchgenMcp(ctx.projectRoot, ctx.home, location, ctx.env);
        // `written` is derived from what was ACTUALLY removed. It used to be
        // hard-coded true, so an uninstall that removed nothing reported
        // success.
        const removed = result.removed ?? [];
        return {
          written: removed.length > 0,
          ...result,
          removedCount: removed.length,
          ...(removed.length === 0 ? { detail: 'nothing was removed — no archgen wiring was found' } : {}),
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
        // The COUNTS, like bootstrap. It used to return the raw per-config
        // rows — an unbounded collection with no total — for the very same
        // operation bootstrap summarised.
        return {
          ...summarizeWiring(res),
          planned: res.wired?.some((w) => w.status === 'planned') === true,
        };
      }

      // bootstrap — wire archgen MCP AND ensure CodeGraph, in one report.
      // A capability mismatch is reported, never silently ignored: wiring a
      // skill to an incompatible server is how a broken install is born.
      const compat = checkCapability({ skillDir: ctx.skill?.path ?? null, serverVersion: ctx.serverVersion });

      // An already-wired install is a NO-OP, not a rewrite. "Wired" must mean
      // the config carries the EXACT entry this server would write — a stale
      // absolute path is present but broken. A dry run asks the real writer,
      // so the no-op decision cannot drift from the write it skips.
      const mcpCheck = wireArchgenMcp({
        projectRoot: ctx.projectRoot,
        registry,
        home: ctx.home,
        location,
        approved: false,
        dryRun: true,
        env: ctx.env,
      });
      const mcpReady = mcpCheck.wired.length > 0 && mcpCheck.wired.every((t) => t.status === 'unchanged');

      // CodeGraph is probed only when the MCP side needs no work: the probe
      // reads configs and runs local status commands, and there is no reason
      // to pay for it on an install that is going to write anyway.
      const cgCheck =
        mcpReady && (args.telemetry ?? 'keep') === 'keep'
          ? await manageCodegraph({
              mode: 'ensure',
              projectRoot: ctx.projectRoot,
              registry,
              location,
              approved: false,
              dryRun: true,
              telemetry: 'keep',
              home: ctx.home,
              env: ctx.env,
            })
          : null;
      if (mcpReady && cgCheck?.alreadyConfigured === true) {
        const cgState = codegraphState({ registry, projectRoot: ctx.projectRoot, home: ctx.home, env: ctx.env, location });
        // The fast path returns the SAME codegraph shape as the slow path. It
        // used to return a third shape (installed/version/indexed/wired),
        // so one fact had two forms depending on which path answered.
        const codegraphFast = {
          ok: true,
          changed: false,
          alreadyConfigured: true,
          cli: { present: Boolean(cgState.cli), version: cgCheck.cli.version ?? cgState.cli?.version ?? null },
          telemetry: { state: 'unknown', action: 'none' },
          index: { action: cgState.indexed ? 'indexed' : 'not-indexed', initialized: cgState.indexed },
        };
        return {
          alreadyConfigured: true,
          compat,
          mcp: {
            detected: mcpCheck.detected ?? [],
            wired: mcpCheck.wired.length,
            binary: { bin: mcpCheck.binary.bin, source: mcpCheck.binary.source },
          },
          codegraph: shapeReport(codegraphFast),
          ok: true,
        };
      }

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
      const mcpSummary = summarizeWiring(mcp);
      // The codegraph report is SHAPED, exactly like archgen_codegraph's.
      // It used to be passed through raw — 11 keys against the other tool's
      // 7 — so one fact had two shapes depending on who asked.
      const codegraphShaped = shapeReport(codegraph);
      return {
        // The SAME outer keys on both paths. `alreadyConfigured` used to
        // exist only on the fast path, so a client had to branch on which
        // path answered.
        alreadyConfigured: false,
        compat,
        mcp: mcpSummary,
        codegraph: codegraphShaped,
        // `ok` is the caller's branch point. A config that could not be
        // merged is still missing the server, so it must not look like
        // success just because CodeGraph succeeded.
        ok: codegraphShaped.ok !== false && !mcpSummary.failed && !mcpSummary.skipped,
      };
    },
  });
}
