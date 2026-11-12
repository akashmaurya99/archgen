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
import { routingSentence } from '../core/protocol/routing.mjs';
import { loadAsset } from '../context.mjs';
import { invalidInput } from '../core/protocol/errors.mjs';
import { hint, teach } from '../core/protocol/guidance.mjs';
import { toolCall } from '../core/protocol/call.mjs';
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
} from '../core/skill/skill-manager.mjs';

/**
 * The arguments each action takes. An argument that belongs to another
 * action is a typed error, not a silent no-op.
 */
const SKILLS_ACTION_ARGS = {
  match: ['title', 'summary', 'fileOwnership', 'limit', 'offset'],
  install: ['skillId', 'harness', 'global', 'approve', 'limit', 'offset'],
  installed: ['limit', 'offset'],
  load: ['skillId', 'section', 'limit', 'offset'],
  digest: ['skillId', 'section', 'limit', 'offset'],
  list: ['skillId', 'limit', 'offset'],
};

const schema = z.object({
  action: z.enum(['match', 'install', 'installed', 'load', 'digest', 'list']),
  title: z.string().optional().describe('Task title.'),
  summary: z.string().optional().describe('Task summary.'),
  fileOwnership: z.array(z.string()).optional().describe('Task file globs.'),
  skillId: z.string().optional().describe('Skill id or slug.'),
  section: z.string().optional().describe('One skill section.'),
  harness: z.string().optional().describe('Target harness; default universal.'),
  global: z.boolean().optional().describe('Install for the user, not the project.'),
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
    actionArgs: SKILLS_ACTION_ARGS,
    title: 'ArchGen skills',
    description:
      'Match, install, load, and inspect capability skills (UI, accessibility, motion) from the registry; ' +
      'one skill is installed per call. ' +
      routingSentence(SKILLS_ACTION_ARGS),
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
              teach(`unknown skill '${args.skillId}'`, 'the registry lists every id and slug', toolCall('archgen_skills', { action: 'list' })),
              hint({ action: toolCall('archgen_skills', { action: 'list' }), reason: 'the registry is the vocabulary.' }),
            );
          }
          return { version: registry.version, installer: registry.installer, skill: one, skills: [one] };
        }
        const p = project(rows, {
          limit: args.limit,
          offset: args.offset,
          next: toolCall('archgen_skills', { action: 'list', limit: bound, offset: from + bound }),
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
          // The continuation carries EVERY argument that drives the match.
          // It used to carry only the title, so a task matched on its summary
          // or its file ownership produced an EMPTY next page — the agent
          // followed the tool's own cursor and got nothing.
          next: toolCall('archgen_skills', { action: 'match', title: args.title ?? '', summary: args.summary ?? '', fileOwnership: args.fileOwnership ?? [], limit: bound, offset: from + bound }),
        });
        // The required and installed lists are computed from the WHOLE match
        // set, not from the page. They used to be computed from the page, so
        // `limit: 1` reported one required skill when three matched — and
        // the note still said "install every required skill".
        const required = rows.filter((m) => m.policy === 'required').map((m) => m.slug);
        const installed = rows.filter((m) => m.installed).map((m) => m.slug);
        return withMeta(
          {
            matched: p.items,
            required,
            installed,
            note: matched.length
              ? `Install every required skill before dispatching the worker.${required.length ? '' : ' (none is required)'}`
              : 'No capability domain matched — no external skill is needed.',
          },
          moreMeta({
            total: p.total,
            returned: p.returned,
            next: p.next,
            available: { skills: p.total, required: required.length, installed: installed.length },
          }),
        );
      }

      if (args.action === 'installed') {
        const all = listInstalled({ projectRoot: ctx.projectRoot, registry, home: ctx.home });
        const p = project(all.installed ?? [], {
          limit: args.limit,
          offset: args.offset,
          next: toolCall('archgen_skills', { action: 'installed', limit: bound, offset: from + bound }),
        });
        return withMeta(
          { installed: p.items },
          moreMeta({ total: p.total, returned: p.returned, next: p.next, available: { skills: p.total } }),
        );
      }

      // install | load
      const wanted = args.skillId;
      if (!wanted) {
        throw invalidInput(
          'skillId is required for this action',
          {
            ...hint({
              action: toolCall('archgen_skills', { action: 'list' }),
              reason: 'the registry lists every skill.',
            }),
            action: args.action,
          },
        );
      }
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
            toolCall('archgen_skills', { action: 'list' }),
          ),
          hint({ action: toolCall('archgen_skills', { action: 'list' }), reason: 'the registry is the vocabulary.' }),
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
            hint: 'not installed — install it first: ' + toolCall('archgen_skills', { action: 'install', skillId: entry.slug, approve: true }),
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
            throw invalidInput(
              `no section '${args.section}' in skill '${entry.slug}'`,
              {
                ...hint({
                  action: toolCall('archgen_skills', { action: 'digest', skillId: '<skill id>' }),
                  reason: 'the digest is the map of the sections of a skill.',
                }),
                skillId: entry.slug,
                section: args.section,
                available: sections.map((s) => s.slug),
              },
            );
          }
          // The named section IS the answer. The page projection used to
          // slice it away when `offset > 0`, so the call returned an empty
          // list with ok:true and no hint.
          return {
            skill: entry.slug,
            installed: true,
            path: found.path,
            scope: found.scope,
            section: hit.slug,
            sections: [hit],
          };
        }
        const p = project(sections, {
          limit: args.limit,
          offset: args.offset,
          next: toolCall('archgen_skills', { action: 'digest', skillId: entry.slug, limit: bound, offset: from + bound }),
        });
        return withMeta(
          { skill: entry.slug, installed: true, path: found.path, scope: found.scope, sections: p.items },
          moreMeta({
            total: p.total,
            returned: p.returned,
            next: p.next,
            available: { sections: p.total },
            more: toolCall('archgen_skills', { action: 'load', skillId: entry.slug, section: '<the section you need>' }),
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
            : 'not installed — install it first: ' + toolCall('archgen_skills', { action: 'install', skillId: entry.slug, approve: true }),
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
              `no section '${args.section}' in skill '${entry.slug}'`, { ...hint({ action: toolCall('archgen_skills', { action: 'digest', skillId: '<skill id>' }), reason: "the digest is the map of a skill's sections." }), skillId: entry.slug, section: args.section, available: sections.map((s) => s.slug) });
          }
          const body = loaded.content.split('\n').slice(hit.line - 1, hit.endLine).join('\n');
          return { ...result, section: hit.slug, sectionTitle: hit.title, sectionText: body };
        }
        const p = project(result.sections, {
          limit: args.limit,
          offset: args.offset,
          next: toolCall('archgen_skills', { action: 'load', skillId: entry.slug, limit: bound, offset: from + bound }),
        });
        return withMeta(
          { ...result, sections: p.items },
          moreMeta({
            total: p.total,
            returned: p.returned,
            next: p.next,
            available: { sections: p.total },
            more: toolCall('archgen_skills', { action: 'load', skillId: entry.slug, section: '<the section you need>' }),
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
