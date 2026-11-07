// skill-roots.mjs — the ONE list of directories a skill can live in.
//
// WHY ONE LIST: the archgen skill and the CAPABILITY skills are installed by
// different mechanisms, but they land in the same kind of place — and each
// used to carry its own private idea of where that place is.
//
//   - The archgen skill was resolved from a list that walked UP from the
//     project root, across several harness directories.
//   - A capability skill was only ever looked for at
//     `<projectRoot>/.agents/skills/<slug>/SKILL.md`.
//
// So a capability skill installed one level up, or in a harness-specific
// directory, was reported as "not installed" by the very tool that had just
// installed it — which is why `archgen_skills{action:'load'}` could say
// "not installed" for a skill sitting on disk.
//
// ONE list, used by both, is the fix. The installer still WRITES to the
// universal `.agents/skills/` store; this list is about READING, and a read
// that misses an installed skill is the expensive failure.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The per-project skill roots, relative to a project directory. */
export const PROJECT_SKILL_ROOTS = [
  '.agents/skills',
  '.claude/skills',
  '.github/skills',
  '.gemini/skills',
  '.cursor/skills',
  '.opencode/skills',
  '.codex/skills',
  '.kiro/skills',
  '.trae/skills',
  '.windsurf/skills',
];

/** The user-global skill roots, relative to $HOME. */
export const GLOBAL_SKILL_ROOTS = [
  '.agents/skills',
  '.claude/skills',
  '.config/opencode/skills',
  '.gemini/skills',
  '.copilot/skills',
  '.codex/skills',
  '.kiro/skills',
  '.trae/skills',
];

/**
 * Every directory a skill with this slug could be in — nearest first.
 *
 * The project chain is walked UP (a monorepo may install the skill at its
 * root while the agent works in a nested package), then the user-global
 * roots are checked.
 *
 * @param {string} projectRoot
 * @param {string} slug the skill's directory name
 * @param {{home?: string|null}} [opts]
 * @returns {Array<{dir: string, scope: 'project'|'global'}>}
 */
export function skillSearchPaths(projectRoot, slug, opts = {}) {
  const home = opts.home ?? null;
  const out = [];
  let dir = resolve(projectRoot);
  for (;;) {
    for (const root of PROJECT_SKILL_ROOTS) out.push({ dir: join(dir, root, slug), scope: 'project' });
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (home) {
    for (const root of GLOBAL_SKILL_ROOTS) out.push({ dir: join(home, root, slug), scope: 'global' });
  }
  return out;
}

/**
 * The first skill directory that actually holds a SKILL.md.
 *
 * @param {string} projectRoot
 * @param {string} slug
 * @param {{home?: string|null}} [opts]
 * @returns {{path: string, scope: 'project'|'global'}|null}
 */
export function findSkillDir(projectRoot, slug, opts = {}) {
  for (const candidate of skillSearchPaths(projectRoot, slug, opts)) {
    if (existsSync(join(candidate.dir, 'SKILL.md'))) {
      return { path: join(candidate.dir, 'SKILL.md'), scope: candidate.scope };
    }
  }
  return null;
}
