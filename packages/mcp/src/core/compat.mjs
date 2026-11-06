// compat.mjs — the capability contract between the skill and this server.
//
// The skill calls this server's tools. That is a DEPENDENCY, and an
// undeclared dependency is a latent outage: a skill at v1 driving a server at
// v2 whose action names changed fails SILENTLY — the agent calls a removed
// action and improvises.
//
// So the skill declares what it needs, and this module checks it:
//
//   skill/SKILL.md frontmatter
//     metadata:
//       requires:
//         archgen_mcp: ">=x.y.z"
//
// `doctor` reports the mismatch; `bootstrap` warns before wiring; CI refuses
// to ship a skill whose declared minimum exceeds the server's version.
//
// The comparator is deliberately minimal: the contract is a MINIMUM version,
// not a range algebra. A range solver here would be complexity nobody asked
// for, and an unparseable requirement must FAIL LOUD rather than pass
// vacuously.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invalidInput } from './errors.mjs';

/** Parse a semver-ish version into comparable parts. */
export function parseVersion(v) {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\s*$/.exec(String(v ?? ''));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

/** Compare two versions: -1 / 0 / 1. Unparseable versions compare as equal. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  return 0;
}

/**
 * Does `version` satisfy the requirement `spec`?
 *
 * Supported forms: `>=x.y.z`, `>x.y.z`, `x.y.z` (exact), `^x.y.z`
 * (same major), `~x.y.z` (same major+minor). Anything else is REJECTED —
 * an unparseable requirement must never pass vacuously.
 *
 * @param {string} version the running version
 * @param {string} spec the declared requirement
 */
export function satisfies(version, spec) {
  const raw = String(spec ?? '').trim();
  if (!raw) return true; // no requirement declared
  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!m) throw invalidInput(`unparseable version requirement '${spec}'`, { requirement: spec });
  const op = m[1] ?? '=';
  const want = { major: +m[2], minor: +m[3], patch: +m[4] };
  const have = parseVersion(version);
  if (!have) return false; // an unparseable running version satisfies nothing
  const cmp = (a, b) => (a.major !== b.major ? a.major - b.major : a.minor !== b.minor ? a.minor - b.minor : a.patch - b.patch);
  switch (op) {
    case '>=':
      return cmp(have, want) >= 0;
    case '>':
      return cmp(have, want) > 0;
    case '<=':
      return cmp(have, want) <= 0;
    case '<':
      return cmp(have, want) < 0;
    case '^':
      return have.major === want.major && cmp(have, want) >= 0;
    case '~':
      return have.major === want.major && have.minor === want.minor && cmp(have, want) >= 0;
    default:
      return cmp(have, want) === 0;
  }
}

/**
 * Read the `metadata.requires` block out of an installed skill's SKILL.md.
 *
 * @param {string} skillDir the installed skill root
 * @returns {{requires: Record<string, string>, version: string|null}}
 */
export function readSkillRequirements(skillDir) {
  const result = { requires: {}, version: null };
  if (!skillDir) return result;
  const skillMd = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) return result;
  let text;
  try {
    text = readFileSync(skillMd, 'utf8');
  } catch {
    return result;
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return result;
  const front = fm[1];

  const version = /^\s*version:\s*(\S+)\s*$/m.exec(front);
  if (version) result.version = version[1].replace(/^["']|["']$/g, '');

  // The `requires:` block lives under `metadata:` — a flat YAML subset, so it
  // is parsed line-wise rather than with the YAML parser (the frontmatter is
  // not a document). Indentation defines the block: `requires:` opens it, and
  // every MORE-indented line below it is a member.
  const lines = front.split(/\r?\n/);
  const indentOf = (l) => l.length - l.trimStart().length;
  let inMetadata = false;
  let metadataIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\s+$/, '');
    if (raw.trim() === '') continue;
    const indent = indentOf(raw);
    const trimmed = raw.trim();

    if (!inMetadata) {
      if (trimmed === 'metadata:') {
        inMetadata = true;
        metadataIndent = indent;
      }
      continue;
    }
    // A line at or left of `metadata:`'s own indent ends the metadata block.
    if (indent <= metadataIndent) {
      inMetadata = false;
      continue;
    }
    if (trimmed === 'requires:') {
      const requiresIndent = indent;
      for (let j = i + 1; j < lines.length; j++) {
        const member = lines[j].replace(/\s+$/, '');
        if (member.trim() === '') continue;
        const memberIndent = indentOf(member);
        if (memberIndent <= requiresIndent) break;
        const m = /^([A-Za-z0-9_-]+):\s*["']?([^"']+?)["']?\s*$/.exec(member.trim());
        if (m) result.requires[m[1]] = m[2].trim();
      }
      break;
    }
  }
  return result;
}

/**
 * Check the installed skill against this server.
 *
 * @param {{skillDir: string|null, serverVersion: string}} opts
 * @returns {{compatible: boolean, required: string|null, running: string, reason: string|null}}
 */
export function checkCapability(opts) {
  const { skillDir, serverVersion } = opts;
  const { requires } = readSkillRequirements(skillDir);
  const spec = requires.archgen_mcp ?? null;
  if (!spec) {
    return { compatible: true, required: null, running: serverVersion, reason: null };
  }
  let ok = false;
  try {
    ok = satisfies(serverVersion, spec);
  } catch (e) {
    return {
      compatible: false,
      required: spec,
      running: serverVersion,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
  return {
    compatible: ok,
    required: spec,
    running: serverVersion,
    reason: ok ? null : `the installed skill requires archgen-mcp ${spec}, but this server is ${serverVersion}`,
  };
}
