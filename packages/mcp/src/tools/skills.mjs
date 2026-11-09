// skills.mjs — the `archgen_skills` tool: capability-skill matching,
// installation and loading.
//
// This tool replaces the skill's FETCH-SKILL PROSE. The agent no longer reads
// a registry, shells out to an installer, or hand-composes a follow-instruction:
// it asks this tool which capability skills a task needs, installs exactly
// those, and gets the file path a worker must follow.
import { z } from 'zod/v4';
import { readFileSync } from 'node:fs';
import { registerTool, projectRootArg, LIMIT_DESC, OFFSET_DESC } from './_register.mjs';
import { loadAsset } from '../context.mjs';
import { invalidInput } from '../core/errors.mjs';
import { hint, teach } from '../core/guidance.mjs';
import { moreMeta, project, withMeta } from '../envelope.mjs';
import {
  matchSkills,
  installSkill,
  loadSkill,
  listInstalled,
  findInstalledSkill,
  followInstruction,
  skillRules,
  skillSections,
  HARNESS_AGENT_IDS,
} from '../core/skill-manager.mjs';

const ACTION_DESC = 'match|install|installed|load|digest|list';

const schema = z.object({
  action: z.enum(['match', 'install', 'installed', 'load', 'digest', 'list']).describe(ACTION_DESC),
  title: z.string().optional().describe('Task title (match).'),
  summary: z.string().optional().describe('Task summary (match).'),
  fileOwnership: z.array(z.string()).optional().describe('Task file globs (match).'),
  skillId: z.string().optional().describe('Skill id or slug.'),
  section: z.string().optional().describe('One skill section (load, digest).'),
  harness: z.string().optional().describe('Target harness (install; default universal).'),
  global: z.boolean().optional().describe('Install for the user, not the project (install).'),
  approve: z.boolean().optional().describe('Required to install; without it returns the plan.'),
  limit: z.number().int().positive().optional().describe(LIMIT_DESC),
  offset: z.number().int().nonnegative().optional().describe(OFFSET_DESC),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerSkillTools(server) {
  registerTool(server, 'archgen_skills', {
    title: 'ArchGen skills',
    description:
      'Match, install, load, and inspect capability skills (UI, accessibility, motion) from the registry; ' +
      'one skill is installed per call.',
    inputSchema: schema,
    readOnly: false,
    destructive: false,
    idempotent: true,
    handler: (ctx, args) => {
      const registry = loadAsset('skill-registry.json');
      const bound = args.limit ?? 50;
      const from = args.offset ?? 0;

      if (args.action === 'list') {
        // ONE row, or the whole registry — but never three copies of a row.
        const rows = registry.skills.map((s) => ({
          id: s.id,
          slug: s.slug,
          family: s.family,
          repo: s.repo,
          purpose: s.purpose,
          policy: s.policy,
          matches: s.matches,
        }));
        if (args.skillId) {
          const one = rows.find((s) => s.id === args.skillId || s.slug === args.skillId);
          if (!one) {
            throw invalidInput(
              teach(`unknown skill '${args.skillId}'`, 'the registry lists every id and slug', "archgen_skills{action:'list'}"),
              hint({ action: "archgen_skills{action:'list'}", reason: 'the registry is the vocabulary.' }),
            );
          }
          return { version: registry.version, installer: registry.installer, skill: one, skills: [one] };
        }
        const p = project(rows, {
          limit: args.limit,
          offset: args.offset,
          next: `archgen_skills{action:'list',limit:${bound},offset:${from + bound}}`,
        });
        return withMeta(
          { version: registry.version, installer: registry.installer, skills: p.items },
          moreMeta({ total: p.total, returned: p.returned, next: p.next, available: { skills: p.total } }),
        );
      }

      if (args.action === 'match') {
        const matched = matchSkills(registry, {
          title: args.title,
          summary: args.summary,
          fileOwnership: args.fileOwnership,
        });
        // ONE copy of each row: the install state rides ON the row, instead of
        // the same row being delivered three times under three keys.
        const rows = matched.map((m) => {
          const found = findInstalledSkill(ctx.projectRoot, m.slug, { home: ctx.home });
          return { ...m, installed: found.installed, path: found.path, scope: found.scope };
        });
        const p = project(rows, {
          limit: args.limit,
          offset: args.offset,
          next: `archgen_skills{action:'match',title:'${args.title ?? ''}',limit:${bound},offset:${from + bound}}`,
        });
        return withMeta(
          {
            matched: p.items,
            // The required ones, by id — the rows are already above.
            required: p.items.filter((m) => m.policy === 'required').map((m) => m.slug),
            installed: p.items.filter((m) => m.installed).map((m) => m.slug),
            note: matched.length
              ? 'Install every required skill before dispatching the worker.'
              : 'No capability domain matched — no external skill is needed.',
          },
          moreMeta({
            total: p.total,
            returned: p.returned,
            next: p.next,
            available: { skills: p.total, required: p.items.filter((m) => m.policy === 'required').length },
          }),
        );
      }

      if (args.action === 'installed') {
        const all = listInstalled({ projectRoot: ctx.projectRoot, registry, home: ctx.home });
        const p = project(all.installed ?? [], {
          limit: args.limit,
          offset: args.offset,
          next: `archgen_skills{action:'installed',limit:${bound},offset:${from + bound}}`,
        });
        return withMeta(
          { installed: p.items },
          moreMeta({ total: p.total, returned: p.returned, next: p.next, available: { skills: p.total } }),
        );
      }

      // install | load
      const wanted = args.skillId;
      if (!wanted) throw invalidInput('skillId is required for this action', { action: args.action });
      const entry =
        registry.skills.find((s) => s.id === wanted || s.slug === wanted) ??
        (registry.routing && (registry.routing.id === wanted || registry.routing.slug === wanted)
          ? registry.routing
          : null);
      if (!entry) {
        throw invalidInput(
          teach(
            `unknown skill '${wanted}'`,
            'the registry lists every id and slug',
            "archgen_skills{action:'list'}",
          ),
          hint({ action: "archgen_skills{action:'list'}", reason: 'the registry is the vocabulary.' }),
        );
      }

      if (args.action === 'digest') {
        // The LENS: a map of the skill's sections, so the agent can see what
        // is in there and pull exactly the one it needs. Same shape as
        // archgen_docs{action:'digest'} — a map, not a copy.
        const found = findInstalledSkill(ctx.projectRoot, entry.slug, { home: ctx.home });
        if (!found.installed || !found.path) {
          return {
            skill: entry.slug,
            installed: false,
            sections: [],
            searchedPaths: found.searchedPaths ?? [],
            hint: 'not installed — install it first: archgen_skills{action:\'install\',skillId:\'' + entry.slug + '\',approve:true}',
          };
        }
        const content = readFileSync(found.path, 'utf8');
        let sections = skillSections(content);
        // ONE section, when the caller named one.
        if (args.section) {
          const wanted = String(args.section).trim().toLowerCase();
          const hit = sections.find(
            (s) =>
              s.slug === args.section ||
              s.title.toLowerCase() === wanted ||
              s.slug.replace(/-{2,}/g, '-') === wanted.replace(/-{2,}/g, '-'),
          );
          if (!hit) {
            throw invalidInput(`no section '${args.section}' in skill '${entry.slug}'`, {
              skillId: entry.slug,
              section: args.section,
              available: sections.map((s) => s.slug),
            });
          }
          sections = [hit];
        }
        const p = project(sections, {
          limit: args.limit,
          offset: args.offset,
          next: `archgen_skills{action:'digest',skillId:'${entry.slug}',limit:${bound},offset:${from + bound}}`,
        });
        return withMeta(
          { skill: entry.slug, installed: true, path: found.path, scope: found.scope, sections: p.items },
          moreMeta({
            total: p.total,
            returned: p.returned,
            next: p.next,
            available: { sections: p.total },
            more: `archgen_skills{action:'load',skillId:'${entry.slug}',section:'<the section you need>'}`,
          }),
        );
      }

      if (args.action === 'load') {
        const found = findInstalledSkill(ctx.projectRoot, entry.slug, { home: ctx.home });
        const loaded = loadSkill({ projectRoot: ctx.projectRoot, slug: entry.slug, home: ctx.home });
        const rules = loaded.loaded ? skillRules(loaded.content) : { rules: '', count: 0, headings: [] };
        const sections = loaded.loaded ? skillSections(loaded.content) : [];
        const result = {
          skill: entry.slug,
          purpose: entry.purpose,
          domain: entry.domain ?? entry.family ?? 'Capability',
          loaded: loaded.loaded,
          path: loaded.path,
          scope: loaded.scope,
          // The RAW CONTENT IS NOT RETURNED. It used to be: the file arrived
          // three times in one call — as `content`, as the extracted `rules`
          // and as the section index. The rules are what the agent must obey
          // and the index is what it may pull; the file itself is one call
          // away (`section:'<slug>'`), and the agent is told where it is.
          rules: rules.rules,
          ruleCount: rules.count,
          sections: sections.map((s) => ({
            slug: s.slug,
            title: s.title,
            line: s.line,
            endLine: s.endLine,
            normative: s.normative,
          })),
          followInstruction: loaded.loaded ? followInstruction({ slug: entry.slug, path: loaded.path, domain: entry.domain }) : null,
          hint: loaded.loaded
            ? null
            : 'not installed — install it first: archgen_skills{action:\'install\',skillId:\'' + entry.slug + '\',approve:true}',
        };
        // Where the tool looked matters only when it found nothing.
        if (!loaded.loaded) result.searchedPaths = loaded.searchedPaths ?? [];

        // ONE section — the agent's lens, the same way archgen_docs serves
        // one section of an artifact.
        if (loaded.loaded && args.section) {
          const wanted = String(args.section).trim();
          const hit =
            sections.find((s) => s.slug === wanted) ??
            sections.find((s) => s.title.toLowerCase() === wanted.toLowerCase()) ??
            sections.find((s) => s.slug.replace(/-{2,}/g, '-') === wanted.replace(/-{2,}/g, '-'));
          if (!hit) {
            throw invalidInput(
              `no section '${args.section}' in skill '${entry.slug}'`,
              { skillId: entry.slug, section: args.section, available: sections.map((s) => s.slug) },
            );
          }
          const body = loaded.content.split('\n').slice(hit.line - 1, hit.endLine).join('\n');
          return { ...result, section: hit.slug, sectionTitle: hit.title, sectionText: body };
        }
        const p = project(result.sections, {
          limit: args.limit,
          offset: args.offset,
          next: `archgen_skills{action:'load',skillId:'${entry.slug}',limit:${bound},offset:${from + bound}}`,
        });
        return withMeta(
          { ...result, sections: p.items },
          moreMeta({
            total: p.total,
            returned: p.returned,
            next: p.next,
            available: { sections: p.total },
            more: `archgen_skills{action:'load',skillId:'${entry.slug}',section:'<the section you need>'}`,
          }),
        );
      }

      return installSkill({
        registry,
        entry,
        projectRoot: ctx.projectRoot,
        harness: args.harness ?? 'universal',
        global: args.global === true,
        approved: args.approve === true,
        home: ctx.home,
        env: ctx.env,
      });
    },
  });
}

export { HARNESS_AGENT_IDS };
