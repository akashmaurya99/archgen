// impact-analyzer.mjs — reverse-dependency query: what is affected if
// <target> changes?
//
// Extracted verbatim from skill/scripts/impact.mjs (deleted in the MCP-first
// cutover). Output shape is byte-identical to the old script's stdout JSON:
//   { direct: [taskIds], transitive: [taskIds], artifacts: [paths] }
import { readFileSync } from 'node:fs';
import { parseYaml } from './yaml.mjs';
import { invalidInput, notFound } from './errors.mjs';

/**
 * Compute the blast radius of a task id or artifact path.
 *
 * @param {string} file absolute path to tasks.yaml
 * @param {string} target a task id, or an artifact/ownership path claimed by tasks
 * @returns {{direct: string[], transitive: string[], artifacts: string[]}}
 */
export function analyzeImpact(file, target) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw invalidInput(`cannot read ${file} (missing or unreadable)`, { file });
  }
  let data;
  try {
    ({ data } = parseYaml(raw, { filename: file }));
  } catch (e) {
    throw invalidInput(`${file}: unparseable YAML (${String(e?.message ?? e).replace(/^[^:]*:\d+:\s*/, '')})`, {
      file,
    });
  }
  const tasks = data?.tasks;
  if (!Array.isArray(tasks)) throw invalidInput(`${file}: missing 'tasks:' sequence`, { file });

  // Resolve target to a seed set of task ids.
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let seeds;
  if (byId.has(target)) {
    seeds = [target];
  } else {
    // Artifact-path mode: any task whose artifacts[] or file_ownership[] covers it.
    seeds = tasks
      .filter((t) => (t.artifacts ?? []).includes(target) || (t.file_ownership ?? []).includes(target))
      .map((t) => t.id);
    if (seeds.length === 0) {
      throw notFound(`no task claims '${target}' (not an id, artifact, or ownership glob)`, { target });
    }
  }

  // Reverse edges: dependents[prereq] = tasks that depend on it.
  const dependents = new Map();
  for (const t of tasks) {
    for (const dep of t.depends_on ?? []) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep).add(t.id);
    }
  }

  // Direct = immediate dependents of seeds; transitive = everything beyond.
  const direct = new Set();
  const transitive = new Set();
  for (const s of seeds) for (const d of dependents.get(s) ?? []) direct.add(d);
  {
    const seen = new Set([...seeds, ...direct]);
    const f = [...direct];
    while (f.length) {
      const cur = f.pop();
      for (const d of dependents.get(cur) ?? []) {
        if (seen.has(d)) continue;
        seen.add(d);
        transitive.add(d);
        f.push(d);
      }
    }
  }

  // Artifacts owned by affected tasks (what files the ripple touches).
  const artifacts = new Set();
  for (const id of [...direct, ...transitive]) {
    for (const a of byId.get(id)?.artifacts ?? []) artifacts.add(a);
  }

  return {
    direct: [...direct].sort(),
    transitive: [...transitive].sort(),
    artifacts: [...artifacts].sort(),
  };
}
