// docs.mjs — the `archgen_docs` tool: navigate the markdown artifacts under
// `.archgen/<slug>/`.
import { z } from 'zod/v4';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { registerTool, projectRootArg } from './_register.mjs';
import { docIndex } from '../core/doc-navigator.mjs';
import { invalidInput } from '../core/errors.mjs';
import { hint, teach } from '../core/guidance.mjs';

const ACTION_DESC = 'index | digest | section | refs | map | validate — see archgen_help.';

const schema = z.object({
  action: z.enum(['index', 'digest', 'section', 'refs', 'map', 'validate']).describe(ACTION_DESC),
  slugDir: z
    .string()
    .optional()
    .describe('Absolute path to the .archgen/<slug>/ directory. Defaults to the active slug under the project root.'),
  token: z.string().optional().describe('The token to look for (refs, map).'),
  section: z.string().optional().describe('Section path, optionally path#anchor (section).'),
  file: z.string().optional().describe('Scope to one document (repo-root-relative or slug-relative).'),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerDocTools(server) {
  registerTool(server, 'archgen_docs', {
    title: 'ArchGen docs',
    description:
      'Navigate the markdown artifacts of an archgen plan without pulling whole files into context. ' +
      'Prefer digest + section over reading a document end to end.',
    inputSchema: schema,
    readOnly: true,
    idempotent: true,
    handler: (ctx, args) => {
      const slugDir = resolveSlugDir(ctx, args.slugDir);
      switch (args.action) {
        case 'index':
          return docIndex(slugDir, { mode: 'overview', file: args.file ?? null, projectRoot: ctx.projectRoot });
        case 'digest':
          return docIndex(slugDir, { mode: 'digest', file: args.file ?? null, projectRoot: ctx.projectRoot });
        case 'validate':
          return docIndex(slugDir, { mode: 'validate', file: args.file ?? null, projectRoot: ctx.projectRoot });
        case 'refs':
          if (!args.token) throw invalidInput('refs requires a token', { action: args.action });
          return docIndex(slugDir, { mode: 'refs', token: args.token, file: args.file ?? null, projectRoot: ctx.projectRoot });
        case 'map':
          if (!args.token) throw invalidInput('map requires a token', { action: args.action });
          return docIndex(slugDir, { mode: 'map', token: args.token, file: args.file ?? null, projectRoot: ctx.projectRoot });
        case 'section':
          if (!args.section) throw invalidInput('section requires a section path', { action: args.action });
          return docIndex(slugDir, { mode: 'section', section: args.section, file: args.file ?? null, projectRoot: ctx.projectRoot });
        default:
          throw invalidInput(`unknown action '${args.action}'`, { action: args.action });
      }
    },
  });
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
