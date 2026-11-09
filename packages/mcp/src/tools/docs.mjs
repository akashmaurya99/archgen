// docs.mjs — the `archgen_docs` tool: navigate the markdown artifacts under
// `.archgen/<slug>/`.
import { z } from 'zod/v4';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { registerTool, projectRootArg, LIMIT_DESC, OFFSET_DESC } from './_register.mjs';
import { docIndex } from '../core/doc-navigator.mjs';
import { invalidInput } from '../core/errors.mjs';
import { hint, teach } from '../core/guidance.mjs';
import { moreMeta, project, withMeta } from '../envelope.mjs';

const ACTION_DESC = 'index|digest|section|refs|map|validate';

const schema = z.object({
  action: z.enum(['index', 'digest', 'section', 'refs', 'map', 'validate']).describe(ACTION_DESC),
  slugDir: z.string().optional().describe('Absolute .archgen/<slug>/ dir; defaults to the active slug.'),
  token: z.string().optional().describe('Token to find (refs, map).'),
  section: z.string().optional().describe('Section slug, path, or path#anchor.'),
  file: z.string().optional().describe('Scope to one document.'),
  limit: z.number().int().positive().optional().describe(LIMIT_DESC),
  offset: z.number().int().nonnegative().optional().describe(OFFSET_DESC),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerDocTools(server) {
  registerTool(server, 'archgen_docs', {
    title: 'ArchGen docs',
    description:
      'Navigate an archgen plan\'s markdown by section — digest, section, map, refs, index, validate — ' +
      'without loading whole files.',
    inputSchema: schema,
    readOnly: true,
    idempotent: true,
    handler: (ctx, args) => {
      const slugDir = resolveSlugDir(ctx, args.slugDir);
      const bound = args.limit ?? 50;
      const from = args.offset ?? 0;
      switch (args.action) {
        case 'index': {
          const overview = docIndex(slugDir, { mode: 'overview', file: args.file ?? null, projectRoot: ctx.projectRoot });
          return bounded('files', overview.data, args, `archgen_docs{action:'index',slugDir:'${slugDir}',limit:${bound},offset:${from + bound}}`, {
            files: (overview.data.files ?? []).length,
            more: `archgen_docs{action:'section',slugDir:'${slugDir}',section:'<the section you need>'}`,
          });
        }
        case 'digest': {
          const digest = docIndex(slugDir, { mode: 'digest', file: args.file ?? null, projectRoot: ctx.projectRoot });
          return bounded('files', digest.data, args, `archgen_docs{action:'digest',slugDir:'${slugDir}',limit:${bound},offset:${from + bound}}`, {
            files: (digest.data.files ?? []).length,
            more: `archgen_docs{action:'section',slugDir:'${slugDir}',section:'<the section you need>'}`,
          });
        }
        case 'validate': {
          return docIndex(slugDir, { mode: 'validate', file: args.file ?? null, projectRoot: ctx.projectRoot });
        }
        case 'refs': {
          if (!args.token) throw invalidInput('refs requires a token', { action: args.action });
          const refs = docIndex(slugDir, { mode: 'refs', token: args.token, file: args.file ?? null, projectRoot: ctx.projectRoot });
          return bounded('matches', refs.data, args, `archgen_docs{action:'refs',slugDir:'${slugDir}',token:'${args.token}',limit:${bound},offset:${from + bound}}`, {
            matches: (refs.data.matches ?? []).length,
          });
        }
        case 'map': {
          if (!args.token) throw invalidInput('map requires a token', { action: args.action });
          const map = docIndex(slugDir, { mode: 'map', token: args.token, file: args.file ?? null, projectRoot: ctx.projectRoot });
          return bounded('sections', map.data, args, `archgen_docs{action:'map',slugDir:'${slugDir}',token:'${args.token}',limit:${bound},offset:${from + bound}}`, {
            sections: (map.data.sections ?? []).length,
            matches: map.data.matchCount ?? undefined,
            more: `archgen_docs{action:'section',slugDir:'${slugDir}',section:'<the section you need>'}`,
          });
        }
        case 'section': {
          if (!args.section) throw invalidInput('section requires a section path', { action: args.action });
          return docIndex(slugDir, { mode: 'section', section: args.section, file: args.file ?? null, projectRoot: ctx.projectRoot });
        }
        default:
          throw invalidInput(`unknown action '${args.action}'`, { action: args.action });
      }
    },
  });
}

/**
 * Bound a collection-shaped answer, and report what was left.
 *
 * The agent is told how many items exist, how many it got, and the exact
 * call that returns the next slice — so a bound never hides data.
 *
 * @param {string} key the payload key the collection sits in
 * @param {object} data the payload
 * @param {any} args
 * @param {string} next the exact next call
 * @param {object} available what else exists
 */
function bounded(key, data, args, next, available) {
  const items = data?.[key] ?? [];
  const p = project(items, { limit: args.limit, offset: args.offset, next });
  return withMeta({ ...data, [key]: p.items }, moreMeta({ total: p.total, returned: p.returned, next: p.next, available }));
}

/**
 * Resolve the slug directory: explicit argument, else the most recently
 * modified `.archgen/<slug>/` under the project root.
 * @param {import('../context.mjs').Context} ctx
 * @param {string|undefined} explicit
 */
export function resolveSlugDir(ctx, explicit) {
  if (explicit) return ctx.contain(explicit);
  const active = activeSlugDir(ctx);
  if (!active) {
    throw invalidInput(
      teach(
        `no .archgen/<slug>/ directory under ${ctx.projectRoot}`,
        'scaffold returns file CONTENT and writes nothing, so write it first',
        "archgen_plan{action:'scaffold',scope:'LARGE',slug:'<slug>'}",
      ),
      hint({
        action: "archgen_plan{action:'scaffold',scope:'LARGE',slug:'<slug>'}",
        reason: 'scaffold returns content; you write it.',
      }),
    );
  }
  return active;
}

/**
 * Find the active `.archgen/<slug>/` directory (most recently modified).
 * @param {import('../context.mjs').Context} ctx
 * @returns {string|null}
 */
export function activeSlugDir(ctx) {
  const archgenDir = join(ctx.projectRoot, '.archgen');
  if (!existsSync(archgenDir)) return null;
  let best = null;
  let bestMtime = -1;
  for (const ent of readdirSync(archgenDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = join(archgenDir, ent.name);
    if (!existsSync(join(dir, 'tasks.yaml'))) continue;
    let mtime = 0;
    try {
      mtime = statSync(join(dir, 'tasks.yaml')).mtimeMs;
    } catch {
      continue;
    }
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = dir;
    }
  }
  return best;
}
