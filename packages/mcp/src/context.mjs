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
import { invalidInput } from './core/protocol/errors.mjs';
import { assertWithinRoot, containPath } from './core/fs/fs-safety.mjs';
import { skillSearchPaths } from './core/skill/skill-roots.mjs';
import { readSkillRequirements } from './core/protocol/compat.mjs';
import { hint } from './core/protocol/guidance.mjs';
import { toolCall } from './core/protocol/call.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** This package's own root (packages/mcp). */
const SERVER_ROOT = resolve(HERE, '..');

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

  // The project chain (walking UP) and the user-global roots come from the
  // ONE skill-root list, so the archgen skill and the capability skills are
  // resolved against the same places.
  for (const candidate of skillSearchPaths(projectRoot, 'archgen', { home })) {
    if (existsSync(join(candidate.dir, 'SKILL.md'))) {
      return { path: candidate.dir, version: readSkillVersion(candidate.dir), scope: candidate.scope };
    }
  }

  return null;
}

/**
 * The version of an installed skill.
 *
 * ONE source, and it is the SKILL itself: the `metadata.version` in the
 * frontmatter of SKILL.md. It is there in every install mode — a copied
 * store, a symlink to the packaged skill, a git checkout — and it cannot
 * disagree with the skill it describes.
 *
 * The `.archgen-version` stamp is the FALLBACK, for a store from before the
 * frontmatter carried a version. The stamp is validated as plain semver:
 * the CLI's reader rejects a non-semver stamp, and this one used to accept
 * any text, so the same file answered "dev" here and "missing" there.
 *
 * @param {string} skillDir
 * @returns {string|null}
 */
export function readSkillVersion(skillDir) {
  if (!skillDir) return null;
  const fromSkill = readSkillRequirements(skillDir).version;
  if (fromSkill && /^\d+\.\d+\.\d+/.test(fromSkill)) return fromSkill;
  try {
    const v = readFileSync(join(skillDir, '.archgen-version'), 'utf8').trim();
    return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
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
    throw invalidInput(
      `missing server asset '${name}'`,
      { ...hint({ action: toolCall('archgen_setup', { action: 'doctor' }), reason: "the server package is incomplete \u2014 reinstall archgen-mcp." }), asset: name },
    );
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw invalidInput(
      `server asset '${name}' is not valid JSON: ${e.message}`,
      { ...hint({ action: toolCall('archgen_setup', { action: 'doctor' }), reason: "the server package is incomplete \u2014 reinstall archgen-mcp." }), asset: name },
    );
  }
}

/**
 * The per-call context: project root + resolved skill + versions.
 *
 * THE ANCHOR. `anchorRoot` is the boundary the server works inside. It is
 * set when the server starts — the directory the server was launched in, or
 * the project the CLI named — and it does NOT change per call.
 *
 * `projectRoot` selects a directory INSIDE the anchor. It is a selector, not
 * a boundary: naming a different root cannot move the edge of what the
 * server may read or write. Before this, every containment check was
 * relative to a root the MODEL chose, so the guard defended nothing — a
 * model that named `/etc` simply moved the boundary to `/etc`.
 */
export class Context {
  /**
   * @param {{projectRoot?: string, anchorRoot?: string, home?: string, env?: Record<string, string|undefined>}} [opts]
   */
  constructor(opts = {}) {
    this.env = opts.env ?? process.env;
    this.home = opts.home ?? homedir();
    // The anchor is the server's DECLARED root: what the server was started
    // with. The cwd is only the fallback for a server started without one.
    this.anchorRoot = resolve(
      opts.anchorRoot ?? opts.projectRoot ?? this.env.ARCHGEN_PROJECT_ROOT ?? process.cwd(),
    );
    this.projectRoot = resolve(opts.projectRoot ?? this.anchorRoot);
    this.skill = resolveSkill(this.projectRoot, this.home, this.env);
    this.serverVersion = serverVersion();
  }

  /**
   * A context for a directory inside the anchor.
   *
   * The candidate is resolved and proved to be inside the anchor; a path
   * outside it is refused with PERMISSION_DENIED. The returned context
   * keeps the SAME anchor, so containment checks made with it cannot be
   * widened either.
   *
   * @param {string} candidate
   * @returns {Context}
   */
  withProjectRoot(candidate) {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw invalidInput(
        'projectRoot must be a non-empty string',
        { ...hint({ action: toolCall('archgen_setup', { action: 'doctor', projectRoot: '<absolute path>' }), reason: "the project root is the anchor every path resolves against." }), projectRoot: candidate },
      );
    }
    const abs = resolve(this.anchorRoot, candidate);
    assertWithinRoot(this.anchorRoot, abs);
    return new Context({
      projectRoot: abs,
      anchorRoot: this.anchorRoot,
      env: this.env,
      home: this.home,
    });
  }

  /**
   * Resolve a caller-supplied path and prove it stays inside the project root.
   * Relative paths are resolved against the project root.
   * @param {string} p
   * @returns {string} absolute path
   */
  contain(p) {
    if (typeof p !== 'string' || p.trim() === '') throw invalidInput(
      'path must be a non-empty string',
      { ...hint({ action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>', projectRoot: '<absolute path>' }), reason: "a path is the unit every artifact is addressed by." }), path: p },
    );
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
