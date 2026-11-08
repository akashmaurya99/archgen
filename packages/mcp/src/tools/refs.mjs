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
import { moreMeta, project, withMeta } from '../envelope.mjs';

const ACTION_DESC =
  'list = every reference topic with its section count; ' +
  'index = the section list of one topic; ' +
  'read = ONE section (no section = the index; section:"*" = the whole topic); ' +
  'search = the sections mentioning a token.';

const schema = z.object({
  action: z.enum(['list', 'index', 'read', 'search']).describe(ACTION_DESC),
  topic: z.enum(REF_TOPICS).optional().describe('Which reference (index, read, search).'),
  section: z
    .string()
    .optional()
    .describe('One section (read, index). "*" = the whole topic. Omit for the section index.'),
  token: z.string().optional().describe('The token to look for (search).'),
  limit: z.number().int().positive().optional().describe('Max items to return. Default 50.'),
  offset: z.number().int().nonnegative().optional().describe('Skip this many items.'),
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
      // The caller's bound, echoed into the exact next call so the agent
      // never has to build the pagination itself.
      const bound = args.limit ?? 50;
      const from = args.offset ?? 0;

      if (args.action === 'list') {
        const p = project(listTopics(roots).topics, {
          limit: args.limit,
          offset: args.offset,
          next: `archgen_refs{action:'list',limit:${bound},offset:${from + bound}}`,
        });
        return withMeta(
          { topics: p.items },
          moreMeta({ total: p.total, returned: p.returned, next: p.next, available: { topics: p.total } }),
        );
      }

      if (!args.topic) {
        throw invalidInput(`topic is required for '${args.action}'`, { action: args.action, known: REF_TOPICS });
      }

      if (args.action === 'index') {
        const indexed = indexTopic(args.topic, { ...roots, section: args.section ?? null });
        const p = project(indexed.sections, {
          limit: args.limit,
          offset: args.offset,
          next: `archgen_refs{action:'index',topic:'${args.topic}',limit:${bound},offset:${from + bound}}`,
        });
        return withMeta(
          { ...indexed, sections: p.items },
          moreMeta({
            total: p.total,
            returned: p.returned,
            next: p.next,
            available: { sections: p.total },
            more: `archgen_refs{action:'read',topic:'${args.topic}',section:'<the section you need>'}`,
          }),
        );
      }

      if (args.action === 'search') {
        if (!args.token) throw invalidInput('search requires token', { action: args.action });
        const found = searchTopic(args.topic, args.token, roots);
        const p = project(found.sections, {
          limit: args.limit,
          offset: args.offset,
          next: `archgen_refs{action:'search',topic:'${args.topic}',token:'${args.token}',limit:${bound},offset:${from + bound}}`,
        });
        return withMeta(
          { ...found, sections: p.items },
          moreMeta({
            total: p.total,
            returned: p.returned,
            next: p.next,
            available: { sections: p.total, matches: found.matchCount },
            more: `archgen_refs{action:'read',topic:'${args.topic}',section:'<the section you need>'}`,
          }),
        );
      }

      // read — ONE section by default; the index when no section is named;
      // the whole topic only when the caller says '*'.
      const read = readTopic(args.topic, { ...roots, section: args.section ?? null });
      if (read.whole || read.text !== undefined) return read;
      const p = project(read.sections, {
        limit: args.limit,
        offset: args.offset,
        next: `archgen_refs{action:'read',topic:'${args.topic}',section:'<the section you need>',limit:${bound},offset:${from + bound}}`,
      });
      return withMeta(
        { ...read, sections: p.items },
        moreMeta({
          total: p.total,
          returned: p.returned,
          next: p.next,
          available: { sections: p.total },
          more: `archgen_refs{action:'read',topic:'${args.topic}',section:'<the section you need>'}`,
        }),
      );
    },
  });
}
