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

/**
 * The working-tree state: path -> content hash (null when the file is gone).
 *
 * The state is the WORKING TREE, not the index: a suite that deletes a
 * tracked file, or writes a new one, mutates the repository even though the
 * index never moved. The previous snapshot listed only the tracked paths
 * and fell back to the INDEX hash for a file that had been deleted, so
 * exactly the mutations this gate exists to catch were invisible to it.
 */
function snapshot() {
  const state = new Map();
  const tracked = gitLines(['ls-files', '-z']);
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard', '-z']);
  for (const path of [...tracked, ...untracked]) {
    state.set(path, currentHash(path));
  }
  return state;
}

/** The paths git reports, one per line. */
function gitLines(args) {
  const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

/** The current content hash of a path (null when it does not exist). */
function currentHash(path) {
  if (!existsSync(join(ROOT, path))) return null;
  try {
    return execFileSync('git', ['hash-object', '--', path], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Compare two snapshots. */
function diff(before, after) {
  const problems = [];
  for (const [path, hash] of before) {
    const now = after.get(path);
    if (now === undefined || now === null) problems.push(`deleted: ${path}`);
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
