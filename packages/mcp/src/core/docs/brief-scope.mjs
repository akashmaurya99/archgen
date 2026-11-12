// brief-scope.mjs — derive the artifact space a dispatch brief is written
// against, and derive EVERY path the brief carries from ONE source.
//
// WHY THIS EXISTS — two defects, one cause (paths were assembled by hand
// instead of resolved):
//
//   1. The brief action demanded `slug` even when the caller had already
//      passed the absolute `tasks.yaml`. That path IS `.archgen/<slug>/
//      tasks.yaml` — the slug is derivable — so the tool asked for the same
//      fact twice in two different shapes, and a caller that omitted `slug`
//      got "needs tasks.yaml, plans dir, slug dir — pass slug" for a brief
//      it had already given everything for.
//
//   2. The emitted brief mixed path vocabularies: `tasks.yaml` was ABSOLUTE
//      while `slug dir` and `plans dir` were PROJECT-RELATIVE. A brief is
//      handed to a sub-agent whose working directory may be a worktree or
//      another repo root; `ctx.contain()` resolves a relative path against
//      the SERVER's project root, so the relative paths in the brief
//      silently pointed at a different tree. A brief whose paths only work
//      from one cwd is a broken brief.
//
// Every path in a brief is now absolute, and every one of them comes from the
// single scope resolved here.
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveSlugInput, ScopeError } from '../plan/scope.mjs';
import { invalidInput } from '../protocol/errors.mjs';
import { isSlug } from '../protocol/slug.mjs';
import { hint } from '../protocol/guidance.mjs';
import { toolCall } from '../protocol/call.mjs';

// The slug is a directory name, never a path: a slug of "../../etc" must not
// be able to steer the brief's paths out of the artifact space.


/**
 * The REAL path of a path that may not exist yet.
 *
 * The scope gate proves paths by realpath, so the brief's paths are real
 * paths. When the leaf does not exist yet — a brief written before the plan
 * lands — the deepest EXISTING ancestor is realpath'd and the remaining
 * segments are re-appended. The result is the path the file WILL have, not
 * a different spelling of the same place.
 *
 * Without this, the same plan produced two different prefixes depending on
 * whether tasks.yaml happened to exist: `/var/...` from the lexical
 * fallback and `/private/var/...` from the realpath branch.
 *
 * @param {string} abs
 * @returns {string}
 */
function realpathNearest(abs) {
  const tail = [];
  let cur = resolve(abs);
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? join(real, ...tail.slice().reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(abs);
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Derive the slug directory from a `tasks.yaml` path WITHOUT touching the
 * filesystem — used when the file does not exist yet (a brief can be written
 * before the plan lands) or when it cannot be realpath-resolved.
 *
 * The shape is EXACTLY the shape `resolveSlugInput` returns — `{root, slug}` —
 * so the two branches cannot disagree about the field names. They did once,
 * and the fallback silently produced `slugDir: undefined`.
 *
 * @param {string} p
 * @returns {{root: string, slug: string}|null}
 */
function deriveFromTasksPath(p) {
  if (basename(p) !== 'tasks.yaml') return null;
  const slugDir = dirname(p);
  const slug = basename(slugDir);
  if (!isSlug(slug)) return null;
  if (basename(dirname(slugDir)) !== '.archgen') return null;
  return { root: realpathNearest(slugDir), slug };
}

/**
 * Derive the slug directory from a `plans` directory path.
 *
 * @param {string} p
 * @returns {{root: string, slug: string}|null}
 */
function deriveFromPlansPath(p) {
  if (basename(p) !== 'plans') return null;
  const slugDir = dirname(p);
  const slug = basename(slugDir);
  if (!isSlug(slug)) return null;
  if (basename(dirname(slugDir)) !== '.archgen') return null;
  return { root: realpathNearest(slugDir), slug };
}

/**
 * Resolve the artifact space a brief is written against.
 *
 * The caller may name the space in any of three ways; they are equivalent and
 * are reconciled here:
 *
 *   - `tasksYaml` — the absolute path to `<slugDir>/tasks.yaml` (strongest:
 *     it names a real file, so the scope is proven, not assumed);
 *   - `planDir`   — the absolute path to `<slugDir>/plans`;
 *   - `slug`      — the slug name alone.
 *
 * @param {{
 *   tasksYaml?: string|null,
 *   planDir?: string|null,
 *   slug?: string|null,
 *   projectRoot: string,
 * }} opts
 * @returns {{slug: string, slugDir: string, plansDir: string, tasksYaml: string, source: 'tasksYaml'|'planDir'|'slug'}}
 */
export function resolveBriefScope(opts) {
  const { tasksYaml = null, planDir = null, slug = null, projectRoot } = opts;
  if (!projectRoot) throw invalidInput(
    'brief scope needs a project root',
    { ...hint({ action: toolCall('archgen_plan', { action: 'brief', kind: 'verifier', tasksYaml: '<tasks.yaml>', planDir: '<planDir>', projectRoot: '<absolute path>' }), reason: "the brief resolves every path against the project root." }) },
  );

  let slugDir = null;
  let resolvedSlug = null;
  let tasksFile = null;
  let source = null;

  if (tasksYaml) {
    let scoped = null;
    try {
      scoped = resolveSlugInput(tasksYaml, projectRoot);
    } catch (e) {
      if (e instanceof ScopeError) {
        throw invalidInput(
          `tasks.yaml must live in .archgen/<slug>/ — ${tasksYaml} does not`,
          { ...hint({ action: toolCall('archgen_plan', { action: 'scaffold', scope: 'LARGE', slug: '<slug>' }), reason: "the task file lives inside the artifact space." }), file: tasksYaml },
        );
      }
      // The file may not exist yet. The path SHAPE still proves the scope.
      scoped = deriveFromTasksPath(tasksYaml);
      if (!scoped) {
        throw invalidInput(
          `cannot read ${tasksYaml} (missing or unreadable)`,
          { ...hint({ action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }), reason: "validate reports what the task file is missing." }), file: tasksYaml },
        );
      }
    }
    slugDir = scoped.root;
    resolvedSlug = scoped.slug;
    // The tasks file is taken from the RESOLVED slug dir, not from the raw
    // path the caller typed. `resolveSlugInput` realpath-resolves, so this is
    // the same file — but it shares one prefix with the slug dir and the
    // plans dir. A brief whose three paths carry two different prefixes
    // (`/var/...` vs `/private/var/...` — the macOS symlink) reads as three
    // different locations to anything comparing them.
    tasksFile = join(slugDir, 'tasks.yaml');
    source = 'tasksYaml';
  } else if (planDir) {
    const scoped = deriveFromPlansPath(planDir);
    if (!scoped) {
      throw invalidInput(
        `plans dir must live in .archgen/<slug>/plans — ${planDir} does not`,
        { ...hint({ action: toolCall('archgen_plan', { action: 'coverage', tasksYaml: '<tasks.yaml>', planDir: '.archgen/<slug>/plans' }), reason: "the plans directory is part of the artifact space." }), file: planDir },
      );
    }
    slugDir = scoped.root;
    resolvedSlug = scoped.slug;
    tasksFile = join(slugDir, 'tasks.yaml');
    source = 'planDir';
  } else if (slug) {
    if (!isSlug(slug)) {
      throw invalidInput(
        `slug '${slug}' is not a valid slug (lowercase, dash-separated)`,
        { ...hint({ action: toolCall('archgen_plan', { action: 'scaffold', scope: 'LARGE', slug: '<slug>' }), reason: "a slug names the artifact space on disk." }), slug },
      );
    }
    slugDir = realpathNearest(join(projectRoot, '.archgen', slug));
    resolvedSlug = slug;
    tasksFile = join(slugDir, 'tasks.yaml');
    source = 'slug';
  } else {
    throw invalidInput(
      'brief needs tasks.yaml, a plans dir, or a slug — pass one of them',
      { ...hint({ action: toolCall('archgen_plan', { action: 'brief', kind: 'verifier', tasksYaml: '<tasks.yaml>', planDir: '<planDir>' }), reason: "a brief needs the plan it briefs." }), action: 'brief',
      missing: ['tasks.yaml', 'slug'], },
    );
  }

  // The two spellings must agree. A caller that passes a tasks.yaml from one
  // slug and the name of another has made a mistake the brief would
  // otherwise paper over.
  if (slug && resolvedSlug && slug !== resolvedSlug) {
    throw invalidInput(
      `slug '${slug}' does not match the artifact space '${resolvedSlug}'`,
      { ...hint({ action: toolCall('archgen_plan', { action: 'scaffold', slug: '<slug>' }), reason: "the slug and the artifact space must be the same one." }), slug,
      actual: resolvedSlug, },
    );
  }

  return {
    slug: resolvedSlug,
    slugDir,
    plansDir: join(slugDir, 'plans'),
    tasksYaml: tasksFile,
    source,
  };
}

/**
 * The template variables a brief is rendered with.
 *
 * Every path is ABSOLUTE. The relative forms are gone: they resolved against
 * whatever cwd the reading agent happened to have.
 *
 * @param {{slug: string, slugDir: string, plansDir: string, tasksYaml: string}} scope
 * @param {{featureRequest?: string|null, topic?: string|null, round?: number|string|null}} extra
 * @returns {Record<string, string>}
 */
export function briefVars(scope, extra = {}) {
  const vars = {
    slug: scope.slug,
    'slug dir': scope.slugDir,
    'plans dir': scope.plansDir,
    'tasks.yaml': scope.tasksYaml,
  };
  if (extra.featureRequest) vars['feature request'] = extra.featureRequest;
  else vars['feature request'] = scope.slug;
  if (extra.topic) vars.topic = extra.topic;
  if (extra.round !== undefined && extra.round !== null && extra.round !== '') vars.round = String(extra.round);
  return vars;
}
