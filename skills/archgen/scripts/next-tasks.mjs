#!/usr/bin/env node
// next-tasks.mjs — topological wave resolver for tasks.yaml.
// Usage: node next-tasks.mjs <tasks.yaml>
// stdout: JSON {waves:[[{id,title,status,file_ownership}]], blockedByFailure:[ids]}
// Exit codes: 0 ok · 2 cycle · 3 ownership conflict in a wave · 4 invalid file
import { readFileSync } from 'node:fs';
import { parseYaml } from './lib/yaml.mjs';
import { buildGraph, findCycle, computeWaves, findOwnershipConflict, GraphError } from './lib/graph.mjs';

const [, , file] = process.argv;
if (!file) { console.error('usage: next-tasks.mjs <tasks.yaml>'); process.exit(4); }

let data;
try {
  ({ data } = parseYaml(readFileSync(file, 'utf8'), { filename: file }));
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(4);
}
const tasks = data?.tasks;
if (!Array.isArray(tasks)) { console.error(`${file}: missing 'tasks:' sequence`); process.exit(4); }

try {
  const { byId, prerequisites } = buildGraph(tasks);

  const cycle = findCycle(prerequisites);
  if (cycle.length) {
    console.error(`dependency cycle detected: ${cycle.join(' -> ')}`);
    process.exit(2);
  }

  const { waves, blockedByFailure } = computeWaves(byId, prerequisites);

  for (const wave of waves) {
    const conflict = findOwnershipConflict(wave);
    if (conflict) {
      console.error(`file_ownership conflict in same wave: glob '${conflict.glob}' claimed by '${conflict.a}' and '${conflict.b}'`);
      process.exit(3);
    }
  }

  const out = {
    waves: waves.map((w) => w.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      file_ownership: t.file_ownership,
    }))),
    blockedByFailure,
  };
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  if (e instanceof GraphError) { console.error(e.message); process.exit(4); }
  throw e;
}
