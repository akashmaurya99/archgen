// platform.mjs — the `archgen_platform` tool: the runtime facts about the
// harness this session is running under.
//
// WHY THIS TOOL EXISTS.
//
// The orchestrator used to read those facts from `archgen_setup{action:
// 'harness_info'}` — a tool that ALSO installed packages, wrote harness
// configuration and removed it. Mixing a read-only fact lookup with
// machine-admin actions put a privileged tool in every session's context, and
// the fact lookup itself answered with EVERY harness in the registry plus the
// whole universal table: ~1.2k tokens for one question ("where do skills go
// on this harness?").
//
// This tool answers exactly that question, and nothing else:
//
//   - which harness is this (detected, in the registry's detection order);
//   - where skills go, where its MCP config lives, what its config key is;
//   - whether it can dispatch sub-agents, and how;
//   - whether the project has a CodeGraph index, and which CodeGraph tools
//     are exposed.
//
// It is READ-ONLY. It cannot install, wire, index or remove anything.
import { z } from 'zod/v4';
import { registerTool, projectRootArg } from './_register.mjs';
import { loadAsset } from '../context.mjs';
import { detectHarness, platformCapabilities } from '../core/harness/platform-caps.mjs';
import { codegraphState, codegraphPolicy } from '../core/harness/codegraph-manager.mjs';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { configTargetFor } from '../core/harness/harness-wiring.mjs';

const schema = z.object({
  harness: z.string().optional().describe('Harness id; omit to detect the current one.'),
  projectRoot: projectRootArg,
});

/**
 * The parts of a capability row the agent actually acts on.
 *
 * The full row carries detection markers, every MCP field name and a note
 * per platform — facts the agent uses ONCE, when it configures something.
 * Everything else is noise in every session that asks.
 *
 * @param {any} row the capability row
 * @returns {any} the compact row
 */
function withCanonicalConfig(row, wiring, ctx) {
  if (!row) return null;
  const wiringId = row.wiringId ?? (row.id === 'copilot' ? 'vscode' : row.id);
  const configs = wiring.harnesses?.[wiringId]?.configs;
  if (!configs) return row;
  const merge = (location) => {
    const capability = row.mcpConfig?.[location] ?? null;
    const canonical = configs[location] ?? null;
    if (!capability && !canonical) return null;
    const merged = { ...(capability ?? {}), ...(canonical ?? {}) };
    // The writer stores Copilot's global path relative to its dedicated home.
    // The capability row carries the display-ready absolute-with-home path.
    if (canonical?.home && capability?.path) merged.path = capability.path;
    if (canonical && ctx) {
      const target = configTargetFor(canonical, ctx);
      if (target.path.endsWith('.jsonc') && !canonical.path.endsWith('.jsonc')) {
        merged.path = canonical.path.startsWith('~/')
          ? `~/${relative(ctx.home, target.path).replaceAll('\\', '/')}`
          : relative(ctx.projectRoot, target.path).replaceAll('\\', '/');
      }
    }
    return merged;
  };
  return {
    ...row,
    mcpConfig: {
      project: merge('project'),
      global: merge('global'),
    },
  };
}

const CONFIG_FIELDS = [
  'path', 'key', 'format', 'entry', 'urlField', 'urlFieldAlternative', 'urlRequired',
  'stdioFields', 'environmentKey', 'commandIsArray', 'type', 'trustGated', 'oauth',
];

function compactConfig(config) {
  if (!config) return null;
  // Keep every field the caller needs to construct a valid entry, but omit
  // absent/null metadata instead of paying for nulls in every response.
  return Object.fromEntries(CONFIG_FIELDS.filter((key) => config[key] !== undefined && config[key] !== null).map((key) => [key, config[key]]));
}

function compactCapabilities(row) {
  if (!row) return null;
  return {
    label: row.label ?? null,
    skillPaths: row.skillPaths ?? null,
    mcpConfig: {
      project: compactConfig(row.mcpConfig?.project),
      global: compactConfig(row.mcpConfig?.global),
    },
    mcpCli: row.mcpCli ?? null,
    restart: row.restart ?? null,
    subAgents: row.subAgents ?? null,
    warning: row.warning ?? null,
  };
}

/**
 * The CodeGraph facts a session needs: is there an index, and which tools
 * are exposed?
 *
 * The policy is the EFFECTIVE one — the asset with the environment's
 * overrides applied — not the raw asset. Reading the asset here would make
 * this tool answer a DIFFERENT policy than `archgen_codegraph` reports for
 * the same machine: two tools, two answers for one fact.
 *
 * @param {string} projectRoot
 * @param {Record<string, string|undefined>} env
 * @returns {any}
 */
function codegraphFacts(projectRoot, env) {
  try {
    const policy = codegraphPolicy(env);
    const state = codegraphState({
      registry: loadAsset('harness-mcp.json'),
      projectRoot,
      env,
      location: 'project',
    });
    return {
      indexed: state.indexed === true,
      version: state.cli?.version ?? null,
      tools: policy.tools,
      package: policy.package,
      install: policy.install,
      wire: policy.wire,
      telemetry: policy.telemetry,
    };
  } catch {
    // The CodeGraph policy asset is part of the server package; report the
    // broken policy explicitly instead of presenting an intentional empty list.
    return { indexed: existsSync(join(projectRoot, '.codegraph', 'codegraph.db')), version: null, tools: [], package: null, install: null, wire: null, telemetry: 'off', policyError: true };
  }
}

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerPlatformTools(server) {
  registerTool(server, 'archgen_platform', {
    title: 'ArchGen platform',
    description:
      'The runtime facts about THIS harness: skill paths, MCP config path and key, restart semantics, ' +
      'sub-agent dispatch, and whether the project has a CodeGraph index. Read-only.',
    inputSchema: schema,
    readOnly: true,
    idempotent: true,
    handler: (ctx, args) => {
      const caps = loadAsset('platform-capabilities.json');
      const wiring = loadAsset('harness-mcp.json');

      // A NAMED harness: the registry knows it, so its row is the answer.
      if (args.harness) {
        const row = platformCapabilities(caps, args.harness);
        return {
          harness: row.id ?? args.harness,
          detected: null,
          primary: row.id ?? args.harness,
          capabilities: compactCapabilities(withCanonicalConfig(row, wiring, ctx)),
          codegraph: codegraphFacts(ctx.projectRoot, ctx.env),
          reason: null,
          nextStep: null,
        };
      }

      // No harness named: DETECT this one.
      try {
        const detected = detectHarness(caps, { projectRoot: ctx.projectRoot, home: ctx.home, env: ctx.env }, wiring);
        const primary = detected.primary?.id ?? null;
        const row = primary ? platformCapabilities(caps, primary) : null;
        return {
          harness: primary,
          // The IDS only: the agent needs to know what else is present, not
          // every capability row of every harness on the machine.
          detected: (detected.detected ?? []).map((d) => d.id),
          primary,
          capabilities: compactCapabilities(withCanonicalConfig(row, wiring, ctx)),
          codegraph: codegraphFacts(ctx.projectRoot, ctx.env),
          reason: null,
          nextStep: null,
        };
      } catch (e) {
        return {
          harness: null,
          detected: [],
          primary: null,
          capabilities: null,
          codegraph: codegraphFacts(ctx.projectRoot, ctx.env),
          reason: e instanceof Error ? e.message : String(e),
          nextStep:
            'Unknown platform: web-search the official MCP + skills docs, summarize the findings, and get the user\'s approval before writing anything.',
        };
      }
    },
  });
}
