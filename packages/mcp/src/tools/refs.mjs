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
import { registerTool, projectRootArg, LIMIT_DESC, OFFSET_DESC } from './_register.mjs';
import { ASSETS_DIR } from '../context.mjs';
import { indexTopic, readTopic, searchTopic, listTopics, REF_TOPICS } from '../core/refs.mjs';
import { invalidInput } from '../core/errors.mjs';
import { toolCall } from '../core/call.mjs';
import { moreMeta, project, withMeta } from '../envelope.mjs';
import { hint } from '../core/guidance.mjs';

const ACTION_DESC = 'list|index|read|search';

/**
 * The arguments each action takes. An argument that belongs to another
 * action is a typed error, not a silent no-op.
 */
const REFS_ACTION_ARGS = {
  list: ['limit', 'offset'],
  index: ['topic', 'section', 'limit', 'offset'],
  read: ['topic', 'section', 'limit', 'offset'],
  search: ['topic', 'token', 'limit', 'offset'],
};

const schema = z.object({
  action: z.enum(['list', 'index', 'read', 'search']).describe(ACTION_DESC),
  topic: z.enum(REF_TOPICS).optional().describe('Reference topic (index, read, search).'),
  section: z.string().optional().describe('One section; "*" = whole topic; omit for the index.'),
  token: z.string().optional().describe('Token to find (search).'),
  limit: z.number().int().positive().optional().describe(LIMIT_DESC),
  offset: z.number().int().nonnegative().optional().describe(OFFSET_DESC),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerRefTools(server) {
  registerTool(server, 'archgen_refs', {
    actionArgs: REFS_ACTION_ARGS,
    title: 'ArchGen references',
    description:
      "Read archgen's protocol references (interview, artifacts, orchestration, platforms, MCP/skills) " +
      'by section, never whole files.',
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
        // `listTopics` returns an ARRAY. It used to be read as
        // `listTopics(roots).topics` — undefined — so the whole reference
        // discovery surface returned `[]` with ok:true and meta.total:0. The
        // agent could not discover which protocol documents exist.
        const all = listTopics(roots);
        const p = project(all, {
          limit: args.limit,
          offset: args.offset,
          next: toolCall('archgen_refs', { action: 'list', limit: bound, offset: from + bound }),
        });
        return withMeta(
          { topics: p.items },
          moreMeta({
            total: p.total,
            returned: p.returned,
            next: p.next,
            available: { topics: p.total },
            more: toolCall('archgen_refs', { action: 'index', topic: '<the topic you need>' }),
          }),
        );
      }

      if (!args.topic) {
        throw invalidInput(
          `topic is required for '${args.action}'`,
          { ...hint({ action: toolCall('archgen_refs', { action: 'index', topic: 'orchestration' }), reason: "the topics are listed there." }), action: args.action, known: REF_TOPICS },
        );
      }

      if (args.action === 'index') {
        // '*' means "the whole topic" for `read`; for `index` it means "the
        // whole section list". Passing it through used to produce
        // NOT_FOUND: no section '*' — the schema advertised it, the tool
        // refused it.
        const narrowed = args.section === '*' ? null : args.section ?? null;
        const indexed = indexTopic(args.topic, { ...roots, section: narrowed });
        const p = project(indexed.sections, {
          limit: args.limit,
          offset: args.offset,
          next: toolCall('archgen_refs', { action: 'index', topic: args.topic, limit: bound, offset: from + bound }),
        });
        return withMeta(
          { ...indexed, sections: p.items },
          moreMeta({
            total: p.total,
            returned: p.returned,
            next: p.next,
            available: { sections: p.total },
            more: toolCall('archgen_refs', { action: 'read', topic: args.topic, section: '<the section you need>' }),
          }),
        );
      }

      if (args.action === 'search') {
        if (!args.token) throw invalidInput(
          'search requires token',
          { ...hint({ action: toolCall('archgen_refs', { action: 'search', topic: 'orchestration', token: '<token>' }), reason: "search needs a token." }), action: args.action },
        );
        const found = searchTopic(args.topic, args.token, roots);
        const p = project(found.sections, {
          limit: args.limit,
          offset: args.offset,
          next: toolCall('archgen_refs', { action: 'search', topic: args.topic, token: args.token, limit: bound, offset: from + bound }),
        });
        return withMeta(
          { ...found, sections: p.items },
          moreMeta({
            total: p.total,
            returned: p.returned,
            next: p.next,
            available: { sections: p.total, matches: found.matchCount },
            more: toolCall('archgen_refs', { action: 'read', topic: args.topic, section: '<the section you need>' }),
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
        next: toolCall('archgen_refs', { action: 'read', topic: args.topic, section: '<the section you need>', limit: bound, offset: from + bound }),
      });
      return withMeta(
        { ...read, sections: p.items },
        moreMeta({
          total: p.total,
          returned: p.returned,
          next: p.next,
          available: { sections: p.total },
          more: toolCall('archgen_refs', { action: 'read', topic: args.topic, section: '<the section you need>' }),
        }),
      );
    },
  });
}
