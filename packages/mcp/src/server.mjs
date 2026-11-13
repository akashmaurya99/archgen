// server.mjs — the MCP server factory.
//
// THE CATALOG IS THE PRODUCT AS MUCH AS THE CODE IS. Every client injects
// every tool's name, description and schema into the model's context on
// every request — the catalog is a permanent context tax. That is why there
// are EIGHT domain tools with short action enums instead of one thin tool per
// capability: 8 well-described tools cost roughly half what 15 do, and the
// model faces one obvious choice per domain instead of fifteen near-misses.
//
// The procedural detail that used to live in the skill's prose now lives
// behind `archgen_help`, which the model calls only when it needs it.
//
// THE PROFILE IS THE PRIVILEGE BOUNDARY. A session publishes ONE profile's
// tools. `lean` (the default) is the data plane — planning, execution,
// documents, capabilities, references, help and the runtime platform facts.
// `full` adds the control plane: the admin tools that install software and
// write harness configuration.
//
// The admin tools are REGISTERED either way, so the CLI facade and the admin
// commands reach the same handlers; a profile decides what the MODEL can see.
import { McpServer } from '@modelcontextprotocol/server';
import { registerPlanTools } from './tools/plan.mjs';
import { registerTaskTools } from './tools/tasks.mjs';
import { registerDocTools } from './tools/docs.mjs';
import { registerRegistryTools } from './tools/registry.mjs';
import { registerCodegraphTools } from './tools/codegraph.mjs';
import { registerSetupTools } from './tools/setup.mjs';
import { registerHelpTools } from './tools/help.mjs';
import { registerSkillTools } from './tools/skills.mjs';
import { registerRefTools } from './tools/refs.mjs';
import { registerPlatformTools } from './tools/platform.mjs';
import { registerEnvelopeResource } from './tools/_register.mjs';
import { serverVersion } from './context.mjs';
import { resolveProfile, setActiveProfile, toolNames } from './core/protocol/profiles.mjs';

/**
 * Build the archgen MCP server.
 *
 * @param {{profile?: string}} [opts] `profile` overrides $ARCHGEN_TOOL_PROFILE.
 * @returns {McpServer}
 */
export function createServer(opts = {}) {
  setActiveProfile(resolveProfile(opts.profile));

  const server = new McpServer({
    name: 'archgen',
    version: serverVersion(),
  });

  registerPlanTools(server);
  registerTaskTools(server);
  registerDocTools(server);
  registerRegistryTools(server);
  registerCodegraphTools(server);
  registerSetupTools(server);
  registerSkillTools(server);
  registerRefTools(server);
  registerHelpTools(server);
  registerPlatformTools(server);

  // The FULL result envelope, published ONCE. The per-tool output schema is
  // the compact one, so the catalog does not repeat the same contract on
  // every tool.
  registerEnvelopeResource(server);

  return server;
}

/**
 * Every tool the server knows — including the ones the active profile does
 * not publish. The schema, routing and action gates walk this list, because
 * an admin tool still has to be correct even when only the CLI can call it.
 */
export const TOOL_NAMES = [
  'archgen_plan',
  'archgen_tasks',
  'archgen_docs',
  'archgen_registry',
  'archgen_codegraph',
  'archgen_setup',
  'archgen_skills',
  'archgen_refs',
  'archgen_help',
  'archgen_platform',
];

/**
 * The tools the ACTIVE PROFILE publishes — the ones a client injects into
 * the model's context. This is the catalog the model-facing surface is
 * measured against.
 *
 * @param {string} [profile]
 * @returns {string[]}
 */
export function exposedToolNames(profile) {
  return toolNames(profile);
}
