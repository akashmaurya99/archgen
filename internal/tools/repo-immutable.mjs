// repo-immutable.mjs — prove the test suites never mutate the repository.
//
// A test suite that silently deletes a tracked file is a catastrophe that
// looks like a green run. This gate makes that impossible: it snapshots the
// tracked-file hashes, runs the suites, and fails if anything tracked
// disappeared, changed, or appeared.
//
// The comparison is BEFORE vs AFTER — not against HEAD — because a working
// tree under development is legitimately dirty.
//
// Usage: node internal/tools/repo-immutable.mjs -- <command...>
//   With no command it only verifies that the tree is unchanged since the
//   snapshot was taken at process start (useful as a post-hoc assertion).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/** The tracked-file state: path -> blob hash (missing files are absent). */
function snapshot() {
  const out = execFileSync('git', ['ls-files', '-s'], { cwd: ROOT, encoding: 'utf8' });
  const state = new Map();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [meta, path] = line.split('\t');
    if (!path) continue;
    state.set(path, meta.split(/\s+/)[1] ?? '');
  }
  // Include the working-tree hash, not the index hash: a suite that modifies
  // a file in place must be caught even though `git ls-files` still lists the
  // ORIGINAL blob.
  for (const path of state.keys()) {
    state.set(path, currentHash(path) || state.get(path));
  }
  return state;
}

/** The current content hash of a tracked path ('' when absent). */
function currentHash(path) {
  if (!existsSync(join(ROOT, path))) return '';
  try {
    return execFileSync('git', ['hash-object', '--', path], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Compare two snapshots. */
function diff(before, after) {
  const problems = [];
  for (const [path, hash] of before) {
    const now = after.get(path);
    if (now === undefined) problems.push(`deleted: ${path}`);
    else if (now !== hash) problems.push(`modified: ${path}`);
  }
  for (const path of after.keys()) {
    if (!before.has(path)) problems.push(`created: ${path}`);
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const sep = args.indexOf('--');
  const command = sep === -1 ? [] : args.slice(sep + 1);

  const before = snapshot();

  if (command.length) {
    console.log(`repo-immutable: running <${command.join(' ')}> …`);
    const r = spawnSync(command[0], command.slice(1), { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`repo-immutable: the command failed (exit ${r.status})`);
      process.exit(r.status ?? 1);
    }
  }

  const problems = diff(before, snapshot());
  if (problems.length) {
    console.error('repo-immutable: the test suites mutated the repository:');
    for (const p of problems) console.error(`  ${p}`);
    console.error('Restore with: git checkout -- <paths>');
    process.exit(1);
  }
  console.log('repo-immutable: the repository is unchanged.');
}

main();
