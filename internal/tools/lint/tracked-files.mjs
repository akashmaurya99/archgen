// tracked-files.mjs — the files git tracks, for the repo's own gates.
//
// WHY THIS FILE EXISTS.
//
// Three gates needed "the files this repository contains", and each wrote
// the same eight lines. A gate that reads a DIFFERENT set of files than
// the gate beside it is a gate whose results cannot be compared — and a
// copy of the reader is how the copies drift.
//
// Git is the source of truth, not the working tree: an untracked local
// artifact (a stray node_modules, a coverage report, a CodeGraph index) is
// machine state, not part of the repository. A gate that fired on the
// machine it ran on would be a gate that gets ignored.
import { execFileSync } from 'node:child_process';

/**
 * Every file git tracks, relative to the repository root.
 *
 * @param {string} root the repository root
 * @returns {string[]} the tracked paths, relative to the root
 */
export function trackedFiles(root) {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}
