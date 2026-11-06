// context.mjs — resolves the project root, the installed skill, and the
// server's own assets. Every tool call runs against a Context.
//
// WHY A CONTEXT OBJECT: a model can hand the server any path it likes. The
// context pins the project root ONCE per process (or per explicit override)
// and every path argument is proved to stay inside it before a read or a
// write happens. Nothing in the tool layer touches the filesystem without
// going through here first.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invalidInput } from './core/errors.mjs';
import { containPath } from './core/fs-safety.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** This package's own root (packages/mcp). */
export const SERVER_ROOT = resolve(HERE, '..');

/** This package's assets directory (harness-mcp.json, mcp-template.json, …). */
export const ASSETS_DIR = join(SERVER_ROOT, 'assets');

/** This package's dispatch-brief templates. */
export const BRIEFS_DIR = join(ASSETS_DIR, 'briefs');

/** This package's artifact templates (the canonical source for every shape). */
export const TEMPLATES_DIR = join(ASSETS_DIR, 'templates');

/** The server's own version (packages/mcp/package.json). */
export function serverVersion() {
  try {
    return JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Skill install locations, project-local first.
 *
 * Mirrors references/platforms.md § "Skill install paths". A drift test
 * (packages/mcp/test/core/skill-resolution.test.mjs) asserts this list stays
 * in sync with the doc, so the two can never silently diverge.
 */
export const PROJECT_SKILL_DIRS = [
  '.agents/skills/archgen',
  '.claude/skills/archgen',
  '.github/skills/archgen',
  '.gemini/skills/archgen',
  '.cursor/skills/archgen',
  '.opencode/skills/archgen',
  '.codex/skills/archgen',
  '.kiro/skills/archgen',
  '.trae/skills/archgen',
  '.windsurf/skills/archgen',
];

/** User-global skill locations (same shape, under $HOME). */
export const GLOBAL_SKILL_DIRS = [
  '.agents/skills/archgen',
  '.claude/skills/archgen',
  '.config/opencode/skills/archgen',
  '.gemini/skills/archgen',
  '.copilot/skills/archgen',
  '.codex/skills/archgen',
  '.kiro/skills/archgen',
  '.trae/skills/archgen',
];

/**
 * Locate the installed archgen skill.
 *
 * Resolution order (first hit wins):
 *   1. $ARCHGEN_SKILL_DIR        — explicit override
 *   2. project-local, walking UP from the project root to the filesystem root
 *   3. user-global under $HOME
 *   4. null — the skill is not installed here
 *
 * @param {string} projectRoot absolute project root
 * @param {string} [home] override $HOME (tests)
 * @param {Record<string, string|undefined>} [env] override process.env (tests)
 * @returns {{path: string, version: string|null, scope: 'override'|'project'|'global'}|null}
 */
export function resolveSkill(projectRoot, home = homedir(), env = process.env) {
  const override = env.ARCHGEN_SKILL_DIR;
  if (override) {
    const abs = isAbsolute(override) ? override : resolve(projectRoot, override);
    if (existsSync(join(abs, 'SKILL.md'))) return { path: abs, version: readSkillVersion(abs), scope: 'override' };
  }

  // Walk UP from the project root: a monorepo may install the skill at its root
  // while the agent works in a nested package.
  let dir = resolve(projectRoot);
  for (;;) {
    for (const rel of PROJECT_SKILL_DIRS) {
      const abs = join(dir, rel);
      if (existsSync(join(abs, 'SKILL.md'))) return { path: abs, version: readSkillVersion(abs), scope: 'project' };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (home) {
    for (const rel of GLOBAL_SKILL_DIRS) {
      const abs = join(home, rel);
      if (existsSync(join(abs, 'SKILL.md'))) return { path: abs, version: readSkillVersion(abs), scope: 'global' };
    }
  }

  return null;
}

/**
 * Read the `.archgen-version` stamp written by the installer.
 * @param {string} skillDir
 * @returns {string|null}
 */
export function readSkillVersion(skillDir) {
  try {
    const v = readFileSync(join(skillDir, '.archgen-version'), 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * Load a JSON asset shipped with this package.
 * @param {string} name file name inside assets/
 * @returns {any}
 */
export function loadAsset(name) {
  const p = join(ASSETS_DIR, name);
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    throw invalidInput(`missing server asset '${name}'`, { asset: name });
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw invalidInput(`server asset '${name}' is not valid JSON: ${e.message}`, { asset: name });
  }
}

/**
 * The per-call context: project root + resolved skill + versions.
 */
export class Context {
  /**
   * @param {{projectRoot?: string, home?: string, env?: Record<string, string|undefined>}} [opts]
   */
  constructor(opts = {}) {
    this.env = opts.env ?? process.env;
    this.home = opts.home ?? homedir();
    this.projectRoot = resolve(opts.projectRoot ?? this.env.ARCHGEN_PROJECT_ROOT ?? process.cwd());
    this.skill = resolveSkill(this.projectRoot, this.home, this.env);
    this.serverVersion = serverVersion();
  }

  /**
   * Resolve a caller-supplied path and prove it stays inside the project root.
   * Relative paths are resolved against the project root.
   * @param {string} p
   * @returns {string} absolute path
   */
  contain(p) {
    if (typeof p !== 'string' || p.trim() === '') throw invalidInput('path must be a non-empty string', { path: p });
    return containPath(this.projectRoot, p);
  }

  /**
   * The small metadata block every tool response carries.
   * @returns {{serverVersion: string, skillVersion: string|null, skillPath: string|null, projectRoot: string, warnings: string[]}}
   */
  meta(warnings = []) {
    return {
      serverVersion: this.serverVersion,
      skillVersion: this.skill?.version ?? null,
      skillPath: this.skill?.path ?? null,
      projectRoot: this.projectRoot,
      warnings,
    };
  }
}
