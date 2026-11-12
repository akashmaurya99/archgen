// repo-root.mjs — where the tests are running, and what that means.
//
// WHY THIS FILE EXISTS. The published npm package ships NEITHER the corpora
// nor the references, so the gates that read them must SKIP there. They
// skipped whenever the file was ABSENT — so deleting the corpus from the
// repository turned the corpus's own gate GREEN. A gate that cannot fail is
// worse than no gate: it looks like coverage.
//
// The distinction is the REPOSITORY, not the file. In the repository the
// corpora must be there, and a missing one is a FAILURE.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The repository root — four levels up from packages/mcp/test/support/.
 *
 * WHY FOUR: this file lives in test/support/, so the climb is
 * support -> test -> mcp -> packages -> <repo root>. The count is stated
 * here once, and every test that needs the root imports it from here —
 * so a test's own location can change without changing what it resolves.
 */
export const REPO_ROOT = join(HERE, '..', '..', '..', '..');

/** The corpus and demo fixtures. */
export const FIXTURES = join(REPO_ROOT, 'fixtures');

/**
 * Whether the tests are running in the repository.
 *
 * @returns {boolean}
 */
export function inRepo() {
  return existsSync(join(REPO_ROOT, 'archgen.config.json')) && existsSync(FIXTURES);
}

/**
 * Assert that a corpus the repository owns is present.
 *
 * @param {string} path the corpus directory
 * @param {string} what what the corpus is, for the message
 */
export function requireCorpus(path, what) {
  assert.ok(existsSync(path), `${what} must be present in the repository — a deleted corpus must not turn its own gate green`);
}
