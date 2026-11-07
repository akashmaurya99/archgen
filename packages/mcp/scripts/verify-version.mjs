#!/usr/bin/env node
// verify-version.mjs — refuse to publish a version that is not the release.
//
// The version is single-sourced in <repo-root>/archgen.config.json, and the
// CLI's sync script derives every package.json from it. This script is the
// LAST gate before publish: if the package's version has drifted from the
// canonical one, the publish FAILS here rather than shipping a version
// nobody can match up with the skill and the CLI.
//
// It verifies; it does not write. The canonical writer is
// packages/cli/scripts/sync-config.mjs — one writer, one source.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(PKG_DIR, '..', '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const pkg = readJson(join(PKG_DIR, 'package.json'));
const canonical = readJson(join(REPO_ROOT, 'archgen.config.json'));

if (pkg.version !== canonical.version) {
  console.error(
    `archgen-mcp version ${pkg.version} does not match the canonical ${canonical.version} ` +
      `(archgen.config.json).\n  Fix with: npm --prefix packages/cli run sync`,
  );
  process.exit(1);
}

console.log(`archgen-mcp ${pkg.version} matches the canonical version.`);
