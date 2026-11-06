// refs.mjs — the `archgen_refs` tool: load archgen's protocol documents.
//
// The reference documents are the ORCHESTRATOR's judgment layer: how to
// interview, what artifacts to write, how to dispatch workers, what this
// platform can do. They live with the MCP server (so they are always the same
// version as the tools they describe) and are served HERE, section by section.
//
// `code-standards.md` is the exception: it is read by WORKER sub-agents, which
// may have no MCP tools — so it stays a plain file in the skill directory and
// the worker contract points at it.
import { z } from 'zod/v4';
import { join } from 'node:path';
import { registerTool, projectRootArg } from './_register.mjs';
import { ASSETS_DIR } from '../context.mjs';
import { indexTopic, readTopic, searchTopic, listTopics, REF_TOPICS } from '../core/refs.mjs';

const ACTION_DESC =
  'list = every reference topic with its section count; ' +
  'index = the section list of one topic; ' +
  'read = ONE section (or the whole topic); ' +
  'search = the sections mentioning a token.';

const schema = z.object({
  action: z.enum(['list', 'index', 'read', 'search']).describe(ACTION_DESC),
  topic: z.enum(REF_TOPICS).optional().describe('Which reference (index, read, search).'),
  section: z.string().optional().describe('Section slug or heading (read). Omit for the whole topic.'),
  token: z.string().optional().describe('The token to look for (search).'),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerRefTools(server) {
  registerTool(server, 'archgen_refs', {
    title: 'ArchGen references',
    description:
      "Load archgen's own protocol documents — the interview playbook, the artifact rules, the dispatch and " +
      'gate protocols, the platform capability notes and the MCP/skill policies. Pull SECTIONS, never whole ' +
      'files: call index for a topic, then read the section you need.',
    inputSchema: schema,
    readOnly: true,
    idempotent: true,
    handler: (ctx, args) => {
      const roots = { assetsDir: join(ASSETS_DIR, 'references'), skillDir: ctx.skill?.path ?? null };

      if (args.action === 'list') return { topics: listTopics(roots) };

      if (!args.topic) {
        throw invalidInput(`topic is required for '${args.action}'`, { action: args.action, known: REF_TOPICS });
      }

      if (args.action === 'index') return indexTopic(args.topic, roots);
      if (args.action === 'search') {
        if (!args.token) throw invalidInput('search requires token', { action: args.action });
        return searchTopic(args.topic, args.token, roots);
      }
      // read
      return readTopic(args.topic, { ...roots, section: args.section ?? null });
    },
  });
}
