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
//
// THE RESOLVER IS NOT THIS FILE'S. `resolvePlanScope` (core/plan/plan-scope.mjs)
// owns "which artifact space is this call about" for EVERY plan action — the
// floor, the coverage report and the brief alike. It used to live here, and
// the floor grew its OWN derivation beside it: one read the caller's raw
// `planDir`, the other derived the slug dir from it. Two derivations, two
// directories, one report — and a confidently false one when they disagreed.
// One owner, one scope, every action.
import { realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { resolvePlanScope } from '../plan/plan-scope.mjs';
import { invalidInput } from '../protocol/errors.mjs';
import { hint } from '../protocol/guidance.mjs';
import { toolCall } from '../protocol/call.mjs';

// The slug is a directory name, never a path: a slug of "../../etc" must not
// be able to steer the brief's paths out of the artifact space.


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
    { ...hint({ action: toolCall('archgen_plan', { action: 'brief', kind: 'verifier', tasksYaml: '<tasks.yaml>', planDir: '<planDir>', projectRoot: '<absolute path>' }), reason: 'the brief resolves every path against the project root.' }) },
  );

  // THE ONE RESOLVER. Every plan action resolves its artifact space through
  // `resolvePlanScope`, so a brief and the floor that judges it read the
  // SAME space — and a path that does not prove one is refused in both, with
  // the same message.
  const scope = resolvePlanScope({ tasksYaml, planDir, slug, projectRoot, action: 'brief' });

  // THE BRIEF'S OWN HYGINE: the space lives in `.archgen/<slug>/`.
  //
  // The floor does not insist on it — a CI gate may point at a checked-out
  // plan anywhere, and the audit reads that space's own files. A brief is
  // different: it is handed to a sub-agent whose working directory may be a
  // worktree or another repo root, so its paths must name archgen's OWN
  // artifact space, not any directory that happens to hold a tasks.yaml.
  if (basename(dirname(scope.slugDir)) !== '.archgen') {
    throw invalidInput(
      `the artifact space must live in .archgen/<slug>/ — ${scope.slugDir} does not`,
      {
        ...hint({
          action: toolCall('archgen_plan', { action: 'scaffold', scope: 'LARGE', slug: '<slug>' }),
          reason: 'the task file lives inside the artifact space.',
        }),
        file: scope.slugDir,
      },
    );
  }

  // The two spellings must agree. A caller that passes a tasks.yaml from one
  // slug and the name of another has made a mistake the brief would
  // otherwise paper over.
  if (slug && scope.slug !== slug) {
    throw invalidInput(
      `slug '${slug}' does not match the artifact space '${scope.slug}'`,
      { ...hint({ action: toolCall('archgen_plan', { action: 'scaffold', slug: '<slug>' }), reason: 'the slug and the artifact space must be the same one.' }), slug,
      actual: scope.slug, },
    );
  }

  return {
    slug: scope.slug,
    slugDir: scope.slugDir,
    plansDir: scope.plansDir,
    tasksYaml: scope.tasksFile,
    source: scope.source,
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
