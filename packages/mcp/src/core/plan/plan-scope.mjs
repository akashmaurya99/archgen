// plan-scope.mjs — the ONE owner of "which artifact space is this call about".
//
// WHY THIS EXISTS — one defect, three causes.
//
// The floor reads the artifact space from TWO places, and each place derived
// the space from the caller's `planDir` on its own:
//
//   checkPlanCoverage(planDir, …)   → reads the files in `planDir`
//   auditPlan({slugDir: …})         → reads `slugDir/architecture.yaml`,
//                                     `slugDir/plans`, `slugDir/answers.yaml`
//
// The two derivations agree ONLY when `basename(planDir) === 'plans'` — the
// documented shape. When a caller passed the slug directory instead
// (`.archgen/<slug>`), the coverage half read the slug dir's markdown — the
// SURVEY doc, `codebase-map.md`, as if it were the plan — and the audit half
// read `dirname(planDir)` — the `.archgen` directory, one level too high.
//
// The result was a report that was confident and FALSE: "no architecture.yaml"
// (it existed), "the plan records no profile" (it did), "TASK-01 is not
// mentioned in any plan file" (it was). A gate that lies about the project is
// worse than a gate that refuses: it sends an agent to rewrite a correct
// plan.
//
// WHY A RESOLVER AND NOT A CHECK.
//
// A check would ask "is this planDir shaped right?" at each call site. Three
// call sites already existed and two of them did not ask, so the next action
// would not ask either. The fix that lasts is structural: the scope is
// RESOLVED ONCE, at the boundary, and every consumer is handed the resolved
// directories. A consumer cannot re-derive the space, so it cannot disagree
// with another consumer.
//
// So this module is the single source of the four paths a plan call needs:
//
//   slugDir   — the artifact space root (the directory that HOLDS tasks.yaml)
//   plansDir  — `<slugDir>/plans`          (DERIVED, never the raw argument)
//   tasksFile — the task file of THIS space
//   slug      — the artifact space's name
//
// THE RULE, IN ONE LINE: the task file and the plans directory must name the
// SAME artifact space. The task file is the anchor (it is a real file, so the
// space is proven, not assumed); the plans directory must be the `plans`
// directory beside it.
//
// The caller's paths are PROOFS of the scope, not paths to be read: they are
// checked against that rule, and the scope is rebuilt from what they prove.
// A path that proves nothing is refused with the exact call that would.
//
// Where the space LIVES is not this module's business. `.archgen/<slug>/` is
// where archgen puts it, and the brief action insists on it (a brief is
// handed to a sub-agent whose working directory may be another tree). The
// floor does not: a CI gate may point at a checked-out plan anywhere, and
// the audit reads that space's own `architecture.yaml`, `plans/` and
// `answers.yaml` — which is exactly what it did before.
import { basename, dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { invalidInput } from '../protocol/errors.mjs';
import { hint, teach } from '../protocol/guidance.mjs';
import { toolCall } from '../protocol/call.mjs';

/**
 * The REAL path of a path that may not exist yet.
 *
 * The scope is proven by realpath when the path exists, and by its SHAPE
 * when it does not (a brief can be written before the plan lands). The two
 * branches must spell the same place, or two consumers of one scope read two
 * different trees — the macOS `/var` vs `/private/var` split.
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
 * The scope of a KNOWN artifact space.
 *
 * The boundary resolver (`resolvePlanScope`) PROVES a scope from the paths a
 * caller typed. This builds one from a directory that is already known to BE
 * the artifact space — the test fixtures, and any internal caller that holds
 * the space rather than a path to it.
 *
 * The two paths are DERIVED here exactly as the resolver derives them, so a
 * scope built either way names the same two directories.
 *
 * @param {string} slugDir the artifact space root
 * @param {string} [tasksFile] the task file — defaults to `<slugDir>/tasks.yaml`
 * @returns {{slug: string, slugDir: string, plansDir: string, tasksFile: string, source: string}}
 */
export function scopeFor(slugDir, tasksFile = join(resolve(slugDir), 'tasks.yaml')) {
  const abs = resolve(slugDir);
  return {
    slug: basename(abs),
    slugDir: abs,
    plansDir: join(abs, 'plans'),
    tasksFile,
    source: 'slugDir',
  };
}

/**
 * Resolve the artifact space a plan call is about.
 *
 * The caller's paths are PROOFS, not inputs: they are checked against the
 * rule, and the scope is rebuilt from what they prove. A path that proves
 * nothing is refused, with the exact call that would.
 *
 * @param {{
 *   tasksYaml?: string|null,
 *   planDir?: string|null,
 *   slug?: string|null,
 *   projectRoot: string,
 *   action?: string|null,
 * }} opts
 * @returns {{slug: string, slugDir: string, plansDir: string, tasksFile: string, source: 'tasksYaml'|'planDir'|'slug'}}
 */
export function resolvePlanScope(opts) {
  const { tasksYaml = null, planDir = null, slug = null, projectRoot, action = null } = opts;
  if (!projectRoot) {
    throw invalidInput(
      'a plan call needs a project root',
      {
        ...hint({
          action: toolCall('archgen_plan', { action: action ?? 'verify', tasksYaml: '<tasks.yaml>', planDir: '<planDir>', projectRoot: '<absolute path>' }),
          reason: 'every path resolves against the project root.',
        }),
        action,
      },
    );
  }

  // THE ANCHOR: the task file. It is a real file, so the space it lives in
  // is proven — not assumed from a path shape.
  let slugDir = null;
  let tasksFile = null;
  let source = null;

  if (tasksYaml) {
    tasksFile = realpathNearest(tasksYaml);
    slugDir = dirname(tasksFile);
    source = 'tasksYaml';
  }

  // THE PLANS DIRECTORY must be the one beside the task file. The rule is
  // RELATIONAL, not positional: the floor reads `plans/` beside `tasks.yaml`,
  // so a plans dir anywhere else is a different space — or no space at all.
  if (planDir) {
    const plansSlugDir = realpathNearest(dirname(planDir));
    const plansName = basename(resolve(planDir));
    if (plansName !== 'plans') {
      throw invalidInput(
        `plans dir must be the 'plans' directory beside the task file — ${planDir} is not one`,
        {
          ...hint({
            action: toolCall('archgen_plan', { action: action ?? 'verify', tasksYaml: '<tasks.yaml>', planDir: '<slugDir>/plans' }),
            reason: 'the plans directory is part of the artifact space.',
          }),
          file: planDir,
        },
      );
    }
    if (slugDir && plansSlugDir !== slugDir) {
      throw invalidInput(
        `the tasks file and the plans dir name different artifact spaces — ${slugDir} and ${plansSlugDir}`,
        {
          ...hint({
            action: toolCall('archgen_plan', { action: action ?? 'verify', tasksYaml: join(slugDir, 'tasks.yaml'), planDir: join(plansSlugDir, 'plans') }),
            reason: 'one call reads one artifact space.',
          }),
          action,
          tasksSlugDir: slugDir,
          plansSlugDir,
        },
      );
    }
    if (!slugDir) {
      slugDir = plansSlugDir;
      tasksFile = join(slugDir, 'tasks.yaml');
      source = 'planDir';
    }
  }

  if (!slugDir && slug) {
    slugDir = realpathNearest(join(projectRoot, '.archgen', slug));
    tasksFile = join(slugDir, 'tasks.yaml');
    source = 'slug';
  }

  if (!slugDir) {
    throw invalidInput(
      teach(
        'a plan call needs a task file, a plans dir, or a slug — pass one of them',
        'the artifact space is what the call reads, so it has to be named',
        toolCall('archgen_plan', { action: action ?? 'verify', tasksYaml: '.archgen/<slug>/tasks.yaml', planDir: '.archgen/<slug>/plans' }),
      ),
      {
        ...hint({
          action: toolCall('archgen_plan', { action: action ?? 'verify', tasksYaml: '<tasks.yaml>', planDir: '<planDir>' }),
          reason: 'name the artifact space the call reads.',
        }),
        action,
        missing: ['tasksYaml', 'planDir', 'slug'],
      },
    );
  }

  return {
    slug: basename(slugDir),
    slugDir,
    // DERIVED, never the raw argument: the plans directory of THIS space.
    plansDir: join(slugDir, 'plans'),
    // The task file of THIS space — the anchor when it was named, and the
    // one beside the plans dir when it was not.
    tasksFile: tasksFile ?? join(slugDir, 'tasks.yaml'),
    source,
  };
}
