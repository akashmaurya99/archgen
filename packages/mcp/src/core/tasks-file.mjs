// tasks-file.mjs — resolve THE task file, so no action has to be told its path.
//
// WHY THIS EXISTS.
//
// The task file is not an independent fact: it is always `.archgen/<slug>/
// tasks.yaml` inside the project the call is about. Every action that reads
// it used to DEMAND the path as an argument, so:
//
//   1. A caller that knew the project but not the slug could not call the
//      tool at all — the path was the only way in, and it was derivable.
//   2. The worker contract told workers to call
//      `archgen_tasks{action:'set_status', taskId, status}` — the call it
//      taught was the call the tool REFUSED ("tasksYaml is required"), so a
//      worker that obeyed the contract exactly failed on the last step of
//      every task.
//   3. A published continuation carried the caller's own `tasksYaml` — which
//      was `undefined` when the caller had not passed one — so the tool's own
//      "next call" was a call that could not work.
//
// One resolver, used by every action of every tool that reads a task file:
// the explicit path wins; otherwise the artifact space is resolved from the
// project. The choice is always REPORTED (the payload names the file), and an
// ambiguous project (several artifact spaces) is reported as a warning — never
// a silent choice.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { invalidInput } from './errors.mjs';
import { hint, teach } from './guidance.mjs';
import { toolCall } from './call.mjs';
import { isSlug } from './slug.mjs';

/**
 * Every task file in the project's artifact spaces.
 *
 * The ORDER is the rule: the most recently modified `tasks.yaml` first, the
 * slug name breaking a tie. It is the same rule `archgen_docs` uses to pick
 * the active slug directory, so the whole server agrees on which plan is
 * active — one rule, one answer.
 *
 * @param {string} projectRoot
 * @returns {Array<{file: string, slugDir: string, slug: string, mtimeMs: number}>}
 */
export function taskFileCandidates(projectRoot) {
  const root = join(projectRoot, '.archgen');
  if (!existsSync(root)) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const slugDir = join(root, ent.name);
    const file = join(slugDir, 'tasks.yaml');
    if (!existsSync(file)) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue; // the file vanished between the check and the stat
    }
    out.push({ file, slugDir, slug: ent.name, mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.slug.localeCompare(b.slug));
  return out;
}

/**
 * The active artifact space: the slug directory of the active task file.
 *
 * @param {string} projectRoot
 * @returns {string|null}
 */
export function activeSlugDir(projectRoot) {
  return taskFileCandidates(projectRoot)[0]?.slugDir ?? null;
}

/**
 * Resolve the task file an action reads.
 *
 * The precedence is explicit and total:
 *
 *   1. `tasksYaml` — the caller's own path (already contained by the caller).
 *      A SLUG DIRECTORY is accepted here too: the graph action has always
 *      taken "a slug directory or a tasks.yaml path", and the two spell one
 *      file.
 *   2. `slugDir`  — `<slugDir>/tasks.yaml`.
 *   3. `slug`     — `<projectRoot>/.archgen/<slug>/tasks.yaml`.
 *   4. `planDir`  — the plans directory of an artifact space; its parent is
 *      the slug directory.
 *   5. the active artifact space under `<projectRoot>/.archgen/`.
 *
 * @param {{
 *   tasksYaml?: string|null,
 *   slugDir?: string|null,
 *   slug?: string|null,
 *   planDir?: string|null,
 *   projectRoot: string,
 *   action?: string|null,
 * }} opts
 * @returns {{file: string, source: 'tasksYaml'|'slugDir'|'slug'|'planDir'|'active', candidates: string[], ambiguous: boolean}}
 */
export function resolveTasksFile(opts) {
  const {
    tasksYaml = null,
    slugDir = null,
    slug = null,
    planDir = null,
    projectRoot,
    action = null,
  } = opts;

  if (tasksYaml) {
    // A slug directory names the same file one level down.
    if (existsSync(tasksYaml) && statSync(tasksYaml).isDirectory()) {
      const file = join(tasksYaml, 'tasks.yaml');
      if (!existsSync(file)) {
        throw invalidInput(
          teach(
            `no tasks.yaml in ${tasksYaml}`,
            'the task file lives at <slugDir>/tasks.yaml',
            toolCall('archgen_plan', { action: 'validate', tasksYaml: '<slugDir>/tasks.yaml' }),
          ),
          hint({
            action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<slugDir>/tasks.yaml' }),
            reason: 'validate reports what the task file is missing.',
          }),
          { slugDir: tasksYaml, action },
        );
      }
      return { file, source: 'slugDir', candidates: [], ambiguous: false };
    }
    return { file: tasksYaml, source: 'tasksYaml', candidates: [], ambiguous: false };
  }

  if (slugDir) {
    const file = join(slugDir, 'tasks.yaml');
    if (!existsSync(file)) {
      throw invalidInput(
        teach(
          `no tasks.yaml in ${slugDir}`,
          'the task file lives at <slugDir>/tasks.yaml',
          toolCall('archgen_plan', { action: 'validate', tasksYaml: '<slugDir>/tasks.yaml' }),
        ),
        hint({
          action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<slugDir>/tasks.yaml' }),
          reason: 'validate reports what the task file is missing.',
        }),
        { slugDir, action },
      );
    }
    return { file, source: 'slugDir', candidates: [], ambiguous: false };
  }

  if (slug) {
    if (!isSlug(slug)) {
      throw invalidInput(
        `slug '${slug}' is not a valid slug (lowercase, dash-separated)`,
        hint({
          action: toolCall('archgen_plan', { action: 'scaffold', scope: 'LARGE', slug: '<slug>' }),
          reason: 'a slug names the artifact space on disk.',
        }),
        { slug, action },
      );
    }
    const dir = join(projectRoot, '.archgen', slug);
    const file = join(dir, 'tasks.yaml');
    if (!existsSync(file)) {
      throw invalidInput(
        teach(
          `no tasks.yaml at ${file}`,
          'the artifact space of that slug has no task file yet',
          toolCall('archgen_plan', { action: 'scaffold', scope: 'LARGE', slug }),
        ),
        hint({
          action: toolCall('archgen_plan', { action: 'scaffold', scope: 'LARGE', slug }),
          reason: 'scaffold returns content; you write it.',
        }),
        { slug, action },
      );
    }
    return { file, source: 'slug', candidates: [], ambiguous: false };
  }

  if (planDir) {
    // The plans directory of an artifact space: `<...>/.archgen/<slug>/plans`.
    // Its parent is the slug directory — but only when the shape proves it.
    const parent = dirname(planDir);
    if (basename(planDir) === 'plans' && basename(dirname(parent)) === '.archgen') {
      const file = join(parent, 'tasks.yaml');
      if (existsSync(file)) {
        return { file, source: 'planDir', candidates: [], ambiguous: false };
      }
    }
  }

  const found = taskFileCandidates(projectRoot);
  if (!found.length) {
    throw invalidInput(
      teach(
        `no .archgen/<slug>/tasks.yaml under ${projectRoot}`,
        'scaffold returns file CONTENT and writes nothing, so write the plan first',
        toolCall('archgen_plan', { action: 'scaffold', scope: 'LARGE', slug: '<slug>' }),
      ),
      hint({
        action: toolCall('archgen_plan', { action: 'scaffold', scope: 'LARGE', slug: '<slug>' }),
        reason: 'scaffold returns content; you write it.',
      }),
      { projectRoot, action },
    );
  }

  const active = found[0];
  return {
    file: active.file,
    source: 'active',
    candidates: found.map((f) => f.file),
    ambiguous: found.length > 1,
  };
}

/**
 * The warning for a task file that was RESOLVED rather than named.
 *
 * A project with several artifact spaces has more than one plan; the tool
 * picks the active one and says so. The agent can then name the file itself
 * when the choice matters.
 *
 * @param {{file: string, candidates: string[]}} resolved
 * @returns {string|null}
 */
export function resolutionWarning(resolved) {
  if (!resolved.ambiguous) return null;
  return (
    `the task file was RESOLVED to ${resolved.file} — this project has ${resolved.candidates.length} artifact spaces ` +
    `(${resolved.candidates.join(', ')}); pass tasksYaml to name one.`
  );
}
