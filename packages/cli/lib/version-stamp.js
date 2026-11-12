// version-stamp.js — the `.archgen-version` stamp contract.
//
// WHY: the MCP server reads `<skillRoot>/.archgen-version` to tell an
// outdated skill copy from a current one and reports it (missing or
// unparseable content means "unknown (legacy)" — a pre-stamp install). The
// CLI is the only writer: every operation that lays down skill files (init,
// global install in symlink AND --copy mode, update via its init/doctor
// refresh) rewrites the stamp with the CLI's own package version.
//
// Format: EXACTLY `MAJOR.MINOR.PATCH\n`, utf8, no BOM. Readers elsewhere trim
// before validating, so CRLF/whitespace is tolerated on read — this writer
// never produces it. Absent file and invalid content both read as null.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VERSION_FILE, assertNotSymlink } from './store.js';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * The version an installed skill declares in its OWN frontmatter.
 *
 * The frontmatter is present in every install mode — a copied store, a
 * symlink to the packaged skill, a git checkout — and it cannot disagree
 * with the skill it describes. The stamp is the fallback, for a store from
 * before the frontmatter carried a version.
 *
 * @param {string} skillRoot
 * @returns {string|null}
 */
export function readDeclaredVersion(skillRoot) {
  if (!skillRoot) return null;
  let raw;
  try {
    raw = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  const m = /^\s*version:\s*["']?([\d]+\.[\d]+\.[\d]+)["']?\s*$/m.exec(raw);
  return m ? m[1] : null;
}

/**
 * The version of an installed skill: what the skill declares, else its stamp.
 *
 * @param {string} skillRoot
 * @returns {string|null}
 */
export function readInstalledVersion(skillRoot) {
  return readDeclaredVersion(skillRoot) ?? readStamp(skillRoot);
}

/**
 * Read the stamp from a skill root (the directory containing SKILL.md).
 * @returns {string|null} the trimmed `MAJOR.MINOR.PATCH` string, or null when
 *   the stamp is absent, unreadable, or not plain semver ("unknown").
 */
export function readStamp(skillRoot) {
  if (!skillRoot) return null;
  let raw;
  try {
    raw = readFileSync(join(skillRoot, VERSION_FILE), 'utf8');
  } catch {
    return null; // absent (legacy pre-stamp install) or unreadable
  }
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const v = body.trim();
  return SEMVER_RE.test(v) ? v : null;
}

/**
 * Write/refresh the stamp inside a skill root. Idempotent: overwriting an
 * existing stamp with the same version yields byte-identical content.
 * Creates parent directories as needed.
 */
export function writeStamp(skillRoot, version) {
  const p = join(skillRoot, VERSION_FILE);
  assertNotSymlink(skillRoot);
  mkdirSync(dirname(p), { recursive: true });
  assertNotSymlink(p);
  writeFileSync(p, version + '\n', 'utf8');
}
