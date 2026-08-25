// init.js — project-local skill install + AGENTS.md/CLAUDE.md context files.
//
// `archgen init` makes a repository SELF-CONTAINED: the skill is copied into
// .agents/skills/archgen (committed to git, team-shared) and mirrored at
// .claude/skills/archgen for Claude Code; AGENTS.md + CLAUDE.md carry a
// managed pointer block so every agent harness auto-discovers the workflow.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderBlock, upsertBlock } from './block.js';

const CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md'];

/** Resolve the bundled skill directory (works from npm package and repo checkout). */
export function resolveSkillSource(packageRoot) {
  const candidates = [
    join(packageRoot, 'vendor', 'skills', 'archgen'),
    join(packageRoot, '..', '..', 'skill'), // dev: running from packages/cli inside the monorepo
  ];
  for (const c of candidates) if (existsSync(join(c, 'SKILL.md'))) return c;
  throw new Error('bundled archgen skill not found (expected vendor/skills/archgen)');
}

/**
 * Initialize a project: copy the skill locally + write context pointers.
 * @param {string} projectDir target repo root
 * @param {string} packageRoot dir containing this CLI package
 * @returns {{skillCopies: string[], contextFiles: string[], createdContextFiles: string[]}}
 */
export function initProject(projectDir, packageRoot) {
  const root = resolve(projectDir);
  const source = resolveSkillSource(packageRoot);

  // 1. Skill copies — real files (not symlinks) so git carries them for the team.
  const agentsSkills = join(root, '.agents', 'skills', 'archgen');
  const claudeSkills = join(root, '.claude', 'skills', 'archgen');
  mkdirSync(agentsSkills, { recursive: true });
  cpSync(source, agentsSkills, { recursive: true });
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  cpSync(agentsSkills, claudeSkills, { recursive: true });

  // 2. Context pointer files — managed blocks, user content preserved.
  const block = renderBlock('.agents/skills/archgen');
  const contextFiles = [];
  const created = [];
  for (const name of CONTEXT_FILES) {
    const p = join(root, name);
    const existed = existsSync(p);
    const next = upsertBlock(existed ? readFileSync(p, 'utf8') : '', block);
    writeFileSync(p, next);
    contextFiles.push(name);
    if (!existed) created.push(name);
  }

  return { skillCopies: [agentsSkills, claudeSkills], contextFiles, createdContextFiles: created };
}
