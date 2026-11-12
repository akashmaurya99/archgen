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
import { hint } from './guidance.mjs';
import { toolCall } from './call.mjs';

/** Parse a semver-ish version into comparable parts. */
export function parseVersion(v) {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\s*$/.exec(String(v ?? ''));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

/**
 * Compare two versions: -1 / 0 / 1.
 *
 * An unparseable version THROWS. The question "which of these is newer?"
 * has no answer when one of them is not a version, and answering "0" — the
 * old behaviour — said "they are the same", which is false and quietly
 * wrong. `satisfies` answers a different question ("does this version meet
 * this requirement?") and handles an unknown version as "meets nothing".
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) {
    throw invalidInput(
      `cannot compare versions: '${a}' and '${b}' are not both versions`,
      { ...hint({ action: toolCall('archgen_setup', { action: 'doctor' }), reason: "the skill and the server must agree on a version." }), a, b },
    );
  }
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
  if (!m) throw invalidInput(
    `unparseable version requirement '${spec}'`,
    { ...hint({ action: toolCall('archgen_setup', { action: 'doctor' }), reason: "the skill declares the server version it needs." }), requirement: spec },
  );
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
 * Read the `metadata.requires` block out of a skill's frontmatter TEXT.
 *
 * The frontmatter is not a YAML DOCUMENT, so it is parsed line-wise:
 * indentation defines the block. `requires:` opens it and every MORE-indented
 * line below it is a member.
 *
 * ONE reader: the CLI's sync script and the repository's version gate each
 * had their own regex, and they disagreed — one accepted an unquoted value,
 * the other required double quotes, so a requirement written either way was
 * visible to one gate and invisible to the other.
 *
 * @param {string} text the file's contents
 * @returns {{requires: Record<string, string>, version: string|null}}
 */
export function parseSkillFrontmatter(text) {
  const result = { requires: {}, version: null };
  if (!text) return result;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!fm) return result;
  const front = fm[1];

  const version = /^\s*version:\s*(\S+)\s*$/m.exec(front);
  if (version) result.version = version[1].replace(/^["']|["']$/g, '');

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
 * Read the `metadata.requires` block out of an installed skill's SKILL.md.
 *
 * @param {string} skillDir the installed skill root
 * @returns {{requires: Record<string, string>, version: string|null}}
 */
export function readSkillRequirements(skillDir) {
  if (!skillDir) return { requires: {}, version: null };
  const skillMd = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) return { requires: {}, version: null };
  try {
    return parseSkillFrontmatter(readFileSync(skillMd, 'utf8'));
  } catch {
    return { requires: {}, version: null };
  }
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
