// version-stamp.js — the `.archgen-version` stamp contract.
//
// WHY: the VS Code extension reads `<skillRoot>/.archgen-version` to tell an
// outdated skill copy from a current one and warns non-blockingly (missing or
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
