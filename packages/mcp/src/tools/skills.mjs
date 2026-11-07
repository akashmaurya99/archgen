// skills.mjs — the `archgen_skills` tool: capability-skill matching,
// installation and loading.
//
// This tool replaces the skill's FETCH-SKILL PROSE. The agent no longer reads
// a registry, shells out to an installer, or hand-composes a follow-instruction:
// it asks this tool which capability skills a task needs, installs exactly
// those, and gets the file path a worker must follow.
import { z } from 'zod/v4';
import { readFileSync } from 'node:fs';
import { registerTool, projectRootArg } from './_register.mjs';
import { loadAsset } from '../context.mjs';
import { invalidInput } from '../core/errors.mjs';
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

const ACTION_DESC =
  'match = which capability skills a task needs; ' +
  'install = install ONE capability skill (needs approve); ' +
  'installed = what is already installed; ' +
  'load = read a skill SKILL.md (or ONE section of it) for prompt injection; ' +
  'digest = the section index of an installed skill; ' +
  'list = the registry.';

const schema = z.object({
  action: z.enum(['match', 'install', 'installed', 'load', 'digest', 'list']).describe(ACTION_DESC),
  title: z.string().optional().describe('Task title (match).'),
  summary: z.string().optional().describe('Task summary (match).'),
  fileOwnership: z.array(z.string()).optional().describe('Task file_ownership globs (match).'),
  skillId: z.string().optional().describe('Registry skill id or slug (install, load, digest).'),
  section: z.string().optional().describe('One section of the skill (load). Omit for the whole skill.'),
  harness: z.string().optional().describe('Harness id to install for (install). Defaults to universal.'),
  global: z.boolean().optional().describe('Install for the user instead of the project (install).'),
  approve: z.boolean().optional().describe('Required to install. Without it you get the plan and nothing is written.'),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerSkillTools(server) {
  registerTool(server, 'archgen_skills', {
    title: 'ArchGen skills',
    description:
      'Match a task against the capability-skill registry, install exactly the matched skill, and load its ' +
      'SKILL.md for prompt injection. Use before dispatching a worker whose work touches a registered capability ' +
      'domain (UI, accessibility, motion, design systems…).',
    inputSchema: schema,
    readOnly: false,
    destructive: false,
    idempotent: true,
    handler: (ctx, args) => {
      const registry = loadAsset('skill-registry.json');

      if (args.action === 'list') {
        return {
          version: registry.version,
          installer: registry.installer,
          skills: registry.skills.map((s) => ({
            id: s.id,
            slug: s.slug,
            family: s.family,
            repo: s.repo,
            purpose: s.purpose,
            policy: s.policy,
            matches: s.matches,
          })),
        };
      }

      if (args.action === 'match') {
        const matched = matchSkills(registry, {
          title: args.title,
          summary: args.summary,
          fileOwnership: args.fileOwnership,
        });
        return {
          matched,
          required: matched.filter((m) => m.policy === 'required'),
          installed: matched.map((m) => {
            const found = findInstalledSkill(ctx.projectRoot, m.slug, { home: ctx.home });
            return { ...m, installed: found.installed, path: found.path, scope: found.scope };
          }),
          note: matched.length
            ? 'Install every required skill before dispatching the worker.'
            : 'No capability domain matched — no external skill is needed.',
        };
      }

      if (args.action === 'installed') {
        return { installed: listInstalled({ projectRoot: ctx.projectRoot, registry, home: ctx.home }) };
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
        throw invalidInput(`unknown skill '${wanted}' — call archgen_skills { action: 'list' }`, { skillId: wanted });
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
            hint: 'not installed — call archgen_skills { action: "install" } first',
          };
        }
        const content = readFileSync(found.path, 'utf8');
        return {
          skill: entry.slug,
          installed: true,
          path: found.path,
          scope: found.scope,
          sections: skillSections(content),
        };
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
          ...loaded,
          // The normative rules, and the section index — the agent decides
          // what to pull from here.
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
          hint: loaded.loaded ? null : 'not installed — call archgen_skills { action: "install" } first',
        };

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
        return result;
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
