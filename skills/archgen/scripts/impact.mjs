#!/usr/bin/env node
// impact.mjs — reverse-dependency query: what is affected if <target> changes?
// Usage: node impact.mjs <tasks.yaml> <taskId-or-artifactPath>
// stdout: JSON {direct:[taskIds], transitive:[taskIds], artifacts:[paths]}
import { readFileSync } from 'node:fs';
import { parseYaml } from './lib/yaml.mjs';

const [, , file, target] = process.argv;
if (!file || !target) { console.error('usage: impact.mjs <tasks.yaml> <taskId-or-artifactPath>'); process.exit(4); }

const { data } = parseYaml(readFileSync(file, 'utf8'), { filename: file });
const tasks = data?.tasks;
if (!Array.isArray(tasks)) { console.error(`${file}: missing 'tasks:' sequence`); process.exit(4); }

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
  if (seeds.length === 0) { console.error(`no task claims '${target}' (not an id, artifact, or ownership glob)`); process.exit(4); }
}

// Reverse edges: dependents[prereq] = tasks that depend on it.
const dependents = new Map();
for (const t of tasks) {
  for (const dep of t.depends_on ?? []) {
    if (!dependents.has(dep)) dependents.set(dep, new Set());
    dependents.get(dep).add(t.id);
  }
}

const direct = new Set();
const transitive = new Set();
const frontier = [...seeds];
while (frontier.length) {
  const cur = frontier.pop();
  for (const dep of dependents.get(cur) ?? []) {
    if (seeds.includes(dep)) continue; // seeds themselves are not "affected"
    if (direct.size === 0 && !transitive.has(dep)) direct.add(dep);
    else if (!direct.has(dep)) transitive.add(dep);
    else continue;
    frontier.push(dep);
  }
}
// Fix directness: direct = immediate dependents of seeds only.
direct.clear();
for (const s of seeds) for (const d of dependents.get(s) ?? []) direct.add(d);
transitive.clear();
{
  const seen = new Set([...seeds, ...direct]);
  const f = [...direct];
  while (f.length) {
    const cur = f.pop();
    for (const d of dependents.get(cur) ?? []) {
      if (seen.has(d)) continue;
      seen.add(d); transitive.add(d); f.push(d);
    }
  }
}

// Artifacts owned by affected tasks (what files the ripple touches).
const artifacts = new Set();
for (const id of [...direct, ...transitive]) {
  for (const a of byId.get(id)?.artifacts ?? []) artifacts.add(a);
}

console.log(JSON.stringify({
  direct: [...direct].sort(),
  transitive: [...transitive].sort(),
  artifacts: [...artifacts].sort(),
}, null, 2));
