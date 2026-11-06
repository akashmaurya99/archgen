// resume-snapshot.mjs — writes `.archgen/<slug>/.agent/resume.md`.
//
// WHY THIS IS A TOOL: the skill's Hard rule 6 used to ask the agent to
// hand-write a ten-line resume snapshot after every wave. That is exactly
// the kind of state the agent must NOT reconstruct from memory — a compaction
// would silently corrupt it. Deriving it from tasks.yaml makes it
// deterministic and re-derivable: the snapshot is a pure function of the
// plan's current state.
//
// The file is the primary re-entry artifact after any context compaction.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { invalidInput } from './errors.mjs';
import { writeFileAtomic } from './fs-safety.mjs';

/**
 * Build the resume snapshot body from a parsed plan.
 * @param {string} slug
 * @param {any[]} tasks
 * @param {any[]} waves resolved waves
 * @returns {string}
 */
/**
 * The wave execution resumes at, 1-based.
 *
 * When every wave is done there is no NEXT wave, so the resume point is the
 * LAST wave — not one past the end of the list. The file and the tool
 * response used two different formulas, so the snapshot could say "wave 3 of
 * 2" while the response said wave 2.
 */
export function resumeWaveIndex(waves, statusOf) {
  const active = waves.findIndex((w) => w.some((t) => statusOf(t) !== 'done'));
  return active === -1 ? waves.length : active + 1;
}

export function renderResume(slug, tasks, waves) {
  const byId = new Map(tasks.map((t) => [t?.id, t]));
  const statusOf = (t) => String(t?.status ?? 'pending');

  const done = tasks.filter((t) => statusOf(t) === 'done').map((t) => t.id);
  const failed = tasks.filter((t) => statusOf(t) === 'failed').map((t) => t.id);
  const blocked = tasks.filter((t) => statusOf(t) === 'blocked').map((t) => t.id);
  const running = tasks.filter((t) => statusOf(t) === 'running').map((t) => t.id);

  // The first wave that still has work in it is where execution resumes.
  const activeWaveIndex = waves.findIndex((w) => w.some((t) => statusOf(t) !== 'done'));
  const remaining = waves[activeWaveIndex] ?? [];

  const lines = [];
  lines.push(`# Resume — ${slug}`);
  lines.push('');
  lines.push(`- slug: ${slug}`);
  lines.push(`- wave: ${resumeWaveIndex(waves, statusOf)} of ${waves.length}`);
  lines.push(`- done: ${done.length ? done.join(', ') : 'none'}`);
  lines.push(`- failed: ${failed.length ? failed.join(', ') : 'none'}`);
  lines.push(`- blocked: ${blocked.length ? blocked.join(', ') : 'none'}`);
  lines.push(`- running: ${running.length ? running.join(', ') : 'none'}`);
  lines.push('- next: call archgen_tasks { action: "next" } — it resolves the frontier from tasks.yaml');
  lines.push('');
  lines.push('## Remaining tasks and the plan sections they own');
  lines.push('');
  if (remaining.length === 0) {
    lines.push('_No remaining wave._');
  } else {
    for (const t of remaining) {
      const owned = (byId.get(t.id)?.artifacts ?? []).filter((a) => typeof a === 'string' && a.endsWith('.md'));
      const sections = owned.length ? owned.join(', ') : '_(no plan section declared)_';
      lines.push(`- **${t.id}** — ${t.title ?? ''}`);
      lines.push(`  - status: ${statusOf(t)}`);
      lines.push(`  - owns: ${sections}`);
      lines.push(`  - files: ${(byId.get(t.id)?.file_ownership ?? []).join(', ') || '—'}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Write the resume snapshot for a slug.
 *
 * @param {string} slugDir absolute `.archgen/<slug>/` directory
 * @param {any[][]} waves resolved waves
 * @returns {{path: string, waveIndex: number, done: string[], failed: string[], blocked: string[], remaining: string[]}}
 */
export function writeResumeSnapshot(slugDir, waves) {
  const tasksFile = join(slugDir, 'tasks.yaml');
  let raw;
  try {
    raw = readFileSync(tasksFile, 'utf8');
  } catch {
    throw invalidInput(`cannot read ${tasksFile} (missing or unreadable)`, { file: tasksFile });
  }
  let data;
  try {
    ({ data } = parseYaml(raw, { filename: tasksFile }));
  } catch (e) {
    throw invalidInput(String(e?.message ?? e), { file: tasksFile });
  }
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const slug = slugDir.split(/[\\/]/).filter(Boolean).pop() ?? 'unknown';

  const body = renderResume(slug, tasks, waves);
  const out = join(slugDir, '.agent', 'resume.md');
  mkdirSync(dirname(out), { recursive: true });
  writeFileAtomic(out, body);

  const statusOf = (t) => String(t?.status ?? 'pending');
  const activeWaveIndex = waves.findIndex((w) => w.some((t) => statusOf(t) !== 'done'));
  return {
    path: out,
    waveIndex: resumeWaveIndex(waves, statusOf),
    done: tasks.filter((t) => statusOf(t) === 'done').map((t) => t.id),
    failed: tasks.filter((t) => statusOf(t) === 'failed').map((t) => t.id),
    blocked: tasks.filter((t) => statusOf(t) === 'blocked').map((t) => t.id),
    remaining: (waves[activeWaveIndex] ?? []).map((t) => t.id),
  };
}


