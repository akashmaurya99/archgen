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
import { serverVersion } from './context.mjs';

/**
 * Build the archgen MCP server.
 * @returns {McpServer}
 */
export function createServer() {
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

  return server;
}

/** The tool names this server exposes — used by the budget check and tests. */
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
];
