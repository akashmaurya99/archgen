// config.js — loader for the single-source-of-truth archgen.config.json.
//
// WHY: the version, managed-block marker strings, and well-known filenames
// were hardcoded independently in block.js, store.js, install.js, install.sh,
// and SKILL.md frontmatter — and drifted (SKILL.md advertised 1.0.0 while the
// CLI shipped 0.0.x). The canonical file lives at <repo-root>/archgen.config.json;
// a byte-identical derived copy ships inside the published npm package at
// vendor/skills/archgen/archgen.config.json (kept in sync by
// scripts/sync-config.mjs + scripts/sync-vendor.mjs).
//
// Resolution is module-relative (cwd-independent), tried in order:
//   1. ../../../archgen.config.json                  — monorepo checkout
//   2. ../vendor/skills/archgen/archgen.config.json  — published package layout
// The first readable candidate wins; a candidate that exists but cannot be
// parsed/validated fails LOUDLY rather than silently falling through to a
// possibly stale copy. Cached per process.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/cli/lib

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Candidate canonical-config paths for a given lib directory. */
export function configCandidates(baseDir = HERE) {
  return [
    resolve(baseDir, '../../../archgen.config.json'),
    resolve(baseDir, '../vendor/skills/archgen/archgen.config.json'),
  ];
}

/**
 * Parse + validate raw config JSON text.
 * @param {string} text file contents
 * @param {string} sourcePath path used in error messages
 */
export function parseConfig(text, sourcePath) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    throw new Error(`cannot load ${sourcePath}: invalid JSON (${e.message})`);
  }
  const bad = (msg) => new Error(`cannot load ${sourcePath}: ${msg}`);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw bad('expected a JSON object');
  if (typeof cfg.version !== 'string' || !SEMVER_RE.test(cfg.version)) {
    throw bad(`"version" must be MAJOR.MINOR.PATCH, got ${JSON.stringify(cfg.version ?? null)}`);
  }
  if (typeof cfg.skillName !== 'string' || !cfg.skillName) throw bad('"skillName" must be a non-empty string');
  const m = cfg.markers;
  if (!m || typeof m !== 'object') throw bad('"markers" object is required');
  for (const k of ['start', 'end', 'featuresStart', 'featuresEnd']) {
    if (typeof m[k] !== 'string' || !m[k]) throw bad(`"markers.${k}" must be a non-empty string`);
  }
  const f = cfg.files;
  if (!f || typeof f !== 'object') throw bad('"files" object is required');
  for (const k of ['stamp', 'projectManifest', 'globalManifest', 'backupDir']) {
    if (typeof f[k] !== 'string' || !f[k]) throw bad(`"files.${k}" must be a non-empty string`);
  }
  return cfg;
}

/**
 * Resolve + parse the canonical config relative to `baseDir` (a lib dir).
 * @returns {object} the validated config object
 */
export function loadConfigFrom(baseDir) {
  const candidates = configCandidates(baseDir);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    let text = '';
    try {
      text = readFileSync(p, 'utf8');
    } catch (e) {
      throw new Error(`cannot load ${p}: ${e.message}`);
    }
    return parseConfig(text, p);
  }
  throw new Error(
    'archgen config not found. Expected one of:\n' +
      candidates.map((c) => '  - ' + c).join('\n') +
      '\nIn a repository checkout archgen.config.json lives at the repo root; ' +
      'in the published package it is vendored at vendor/skills/archgen/. ' +
      'Run `npm run sync:config` inside packages/cli to (re)generate both.',
  );
}

let cached = null;

/** Load the canonical config for this process (cached after first call). */
export function loadConfig() {
  if (!cached) cached = loadConfigFrom(HERE);
  return cached;
}
