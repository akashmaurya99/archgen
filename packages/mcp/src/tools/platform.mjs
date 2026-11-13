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
import { join } from 'node:path';

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
function compactCapabilities(row) {
  if (!row) return null;
  const mcp = row.mcpConfig ?? {};
  const project = mcp.project ?? null;
  const global = mcp.global ?? null;
  return {
    label: row.label ?? null,
    skillPaths: row.skillPaths ?? null,
    mcpConfig: {
      project: project ? { path: project.path, key: project.key, format: project.format ?? null, urlField: project.urlField ?? null } : null,
      global: global ? { path: global.path, key: global.key, format: global.format ?? null, urlField: global.urlField ?? null } : null,
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
    // The CodeGraph policy asset is part of the server package; a missing one
    // is a broken install, and the platform facts are still worth answering.
    return { indexed: existsSync(join(projectRoot, '.codegraph')), version: null, tools: [], package: null, install: null, wire: null, telemetry: 'off' };
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

      // A NAMED harness: the registry knows it, so its row is the answer.
      if (args.harness) {
        const row = platformCapabilities(caps, args.harness);
        return {
          harness: row.id ?? args.harness,
          detected: null,
          primary: row.id ?? args.harness,
          capabilities: compactCapabilities(row),
          codegraph: codegraphFacts(ctx.projectRoot, ctx.env),
          reason: null,
          nextStep: null,
        };
      }

      // No harness named: DETECT this one.
      try {
        const detected = detectHarness(caps, { projectRoot: ctx.projectRoot, home: ctx.home });
        const primary = detected.primary?.id ?? null;
        const row = primary ? platformCapabilities(caps, primary) : null;
        return {
          harness: primary,
          // The IDS only: the agent needs to know what else is present, not
          // every capability row of every harness on the machine.
          detected: (detected.detected ?? []).map((d) => d.id),
          primary,
          capabilities: compactCapabilities(row),
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
