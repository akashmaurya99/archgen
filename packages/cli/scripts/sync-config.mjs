// sync-config.mjs — propagate the canonical version to every derived surface.
//
// WHY THIS FILE EXISTS. The version lives in ONE place — archgen.config.json.
// Every other surface that carries a version (the skill's config, the SKILL.md
// frontmatter, the CLI's and the MCP server's package.json) DERIVES it from
// that file. A hand-written copy of a version is a release chore and a drift
// source: it is wrong at the next release, nobody notices, and the fix is a
// manual edit nobody remembers to make.
//
// So this script writes the derived surfaces from the canonical one, and
// `--check` refuses to write — which is what CI runs, so a drifted file can
// never ship.
//
// It also enforces the CAPABILITY CONTRACT: the skill declares the MCP server
// version it needs, and that requirement must be satisfiable by THIS release.
// The check runs BEFORE anything is written, so a bad requirement never leaves
// a half-synced tree behind.

/**
 * Read the skill's declared capability requirement from its frontmatter:
 * `metadata.requires.archgen_mcp` (e.g. ">=x.y.z"). Returns null when the
 * skill declares none.
 *
 * WHY A SECOND READER. The MCP server's `core/compat.mjs` reads the same
 * block, and this script cannot import it: the CLI package is published and
 * must work when it is copied ALONE, with no server beside it. So the two
 * readers exist — and a parity test in internal/test/ holds them to the same
 * answers, so the drift that duplication invites cannot ship.
 */
export function readRequiresMcp(raw) {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  if (!fm) return null;
  const m = /^[ \t]+archgen_mcp:[ \t]*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm[1]);
  return m ? m[1].trim() : null;
}

/**
 * Does `version` satisfy the requirement `spec`? Supports `>=`, `>`, `<=`, `<`,
 * `=`, `^` and `~` over MAJOR.MINOR.PATCH — the same forms the MCP server's
 * `core/compat.mjs` accepts. An unparseable requirement is treated as NOT
 * satisfied: it must never pass vacuously.
 */
export function serverSatisfies(version, spec) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)\.(\d+)\.(\d+)/.exec(String(spec ?? '').trim());
  if (!m) return false;
  const op = m[1] ?? '=';
  const want = { major: +m[2], minor: +m[3], patch: +m[4] };
  const hm = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!hm) return false;
  const have = { major: +hm[1], minor: +hm[2], patch: +hm[3] };
  const cmp = (a, b) => (a.major !== b.major ? a.major - b.major : a.minor !== b.minor ? a.minor - b.minor : a.patch - b.patch);
  switch (op) {
    case '>=': return cmp(have, want) >= 0;
    case '>': return cmp(have, want) > 0;
    case '<=': return cmp(have, want) <= 0;
    case '<': return cmp(have, want) < 0;
    case '^': return have.major === want.major && cmp(have, want) >= 0;
    case '~': return have.major === want.major && have.minor === want.minor && cmp(have, want) >= 0;
    default: return cmp(have, want) === 0;
  }
}
// sync-config.mjs — propagate the canonical archgen.config.json into every
// derived location so the version can never drift again.
//
// Derived targets (each left byte-identical when already correct → idempotent):
//   (a) skill/archgen.config.json     verbatim pretty-printed copy of canonical
//   (b) skill/SKILL.md                ONLY the frontmatter `metadata.version` line
//   (c) packages/cli/package.json     the "version" field
//   (d) packages/mcp/package.json     the "version" field (when present — the
//       published CLI payload ships without the MCP package)
//
// All writes are atomic (temp sibling file + rename). Run automatically via
// `prepublishOnly` and `npm run sync`; run standalone via `npm run sync:config`.
//
// `--check` writes nothing: it exits 1 and lists every drifted target, for use
// as a CI gate (npm run sync:check) so drift fails the build instead of being
// silently repaired by the next sync run.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseConfig } from '../lib/config.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..', '..', '..'); // repo root

/** Atomic write: temp sibling + rename, so readers never see partial files. */
export function writeFileAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

/**
 * Rewrite ONLY the `version:` line inside the YAML frontmatter of SKILL.md.
 * Preserves BOM, CRLF/LF conventions, and every other byte of the file.
 * @param {string} raw SKILL.md contents
 * @param {string} version MAJOR.MINOR.PATCH to set
 * @returns {string} new contents
 */
export function setFrontmatterVersion(raw, version) {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  if (!fm) throw new Error('skill/SKILL.md has no YAML frontmatter block');
  const lineRe = /^[ \t]+version:[ \t]*[^\r\n]*/m; // indented => metadata.version
  if (!lineRe.test(fm[1])) throw new Error('skill/SKILL.md frontmatter has no metadata.version line');
  const nextBody = body.replace(lineRe, `  version: ${version}`);
  return (bom ? '\uFEFF' : '') + nextBody;
}

/**
 * Rewrite ONLY the top-level "version" field of a package.json, preserving
 * every other byte — hand-formatted files (compact one-line objects) must not
 * be reflowed by a version bump.
 * Top-level keys carry the file's base indent (the indent of the first key
 * after the opening brace); nested keys indent deeper, so they never match.
 * @param {string} raw package.json contents
 * @param {string} version MAJOR.MINOR.PATCH to set
 * @returns {string} new contents
 */

export function setPackageVersion(raw, version) {  const lines = raw.split('\n');
  let base = null;
  for (const line of lines) {
    const m = /^([ \t]*)"[^"]+"[ \t]*:/.exec(line);
    if (m) { base = m[1]; break; }
  }
  if (base === null) throw new Error('package.json has no top-level fields');
  const esc = base.replace(/\\/g, '\\\\').replace(/\t/g, '\\t');
  const idx = lines.findIndex((l) => new RegExp(`^${esc}"version"[ \\t]*:`).test(l));
  if (idx === -1) throw new Error('package.json has no top-level "version" field');
  lines[idx] = lines[idx].replace(/("version"[ \t]*:[ \t]*)"[^"]*"/, `$1"${version}"`);
  return lines.join('\n');
}

/**
 * Sync all derived targets against <root>/archgen.config.json.
 * @param {{root?: string, check?: boolean}} opts repo root (defaults to this
 *   checkout's root); `check: true` reports drift without writing anything
 * @returns {string[]} sync mode: files actually rewritten; check mode:
 *   drifted targets (empty array === everything in sync)
 */
export function syncConfig({ root = DEFAULT_ROOT, check = false } = {}) {
  const rootDir = resolve(root);
  const cfg = parseConfig(readFileSync(join(rootDir, 'archgen.config.json'), 'utf8'), join(rootDir, 'archgen.config.json'));
  const touched = [];

  // (0) THE CAPABILITY CONTRACT — checked FIRST, before anything is written.
  //
  // `metadata.requires.archgen_mcp` is a HUMAN decision, not a derived fact:
  // it says "the oldest server this skill can talk to", so the sync never
  // rewrites it (a skill may keep working against an older server). But a
  // declaration the CURRENT server cannot satisfy is a broken release — the
  // skill would call a tool that does not exist. Fail fast, before any write.
  const skillMdPath = join(rootDir, 'skill', 'SKILL.md');
  const rawMd = readFileSync(skillMdPath, 'utf8');
  const requiresMcp = readRequiresMcp(rawMd);
  if (requiresMcp && !serverSatisfies(cfg.version, requiresMcp)) {
    throw new Error(
      `skill/SKILL.md requires archgen-mcp ${requiresMcp}, but this release is ${cfg.version} — ` +
        'raise metadata.requires.archgen_mcp or lower the release version',
    );
  }

  // (a) derived skill copy
  const skillCfgPath = join(rootDir, 'skill', 'archgen.config.json');
  const desiredCfg = JSON.stringify(cfg, null, 2) + '\n';
  if (!existsSync(skillCfgPath) || readFileSync(skillCfgPath, 'utf8') !== desiredCfg) {
    if (!check) writeFileAtomic(skillCfgPath, desiredCfg);
    touched.push('skill/archgen.config.json');
  }

  // (b) SKILL.md frontmatter metadata.version line only
  const nextMd = setFrontmatterVersion(rawMd, cfg.version);
  if (nextMd !== rawMd) {
    if (!check) writeFileAtomic(skillMdPath, nextMd);
    touched.push('skill/SKILL.md (metadata.version)');
  }

  // (c) CLI package.json version field
  const pkgPath = join(rootDir, 'packages', 'cli', 'package.json');
  const rawPkg = readFileSync(pkgPath, 'utf8');
  const nextPkg = setPackageVersion(rawPkg, cfg.version);
  if (nextPkg !== rawPkg) {
    if (!check) writeFileAtomic(pkgPath, nextPkg);
    touched.push('packages/cli/package.json (version)');
  }

  // (d) MCP server package.json version field — exist-conditional: the
  // published CLI payload ships without the MCP package.
  const mcpPkgPath = join(rootDir, 'packages', 'mcp', 'package.json');
  if (existsSync(mcpPkgPath)) {
    const rawMcp = readFileSync(mcpPkgPath, 'utf8');
    const nextMcp = setPackageVersion(rawMcp, cfg.version);
    if (nextMcp !== rawMcp) {
      if (!check) writeFileAtomic(mcpPkgPath, nextMcp);
      touched.push('packages/mcp/package.json (version)');
    }
  }

  // (e) the committed lockfiles' version fields.
  //
  // A lockfile whose version disagrees with its package.json makes `npm ci`
  // REFUSE to install ("can only install packages when your package.json and
  // package-lock.json are in sync"). That is a release that fails on the
  // runner, so it is caught HERE — before any publish — rather than in CI.
  //
  // The lockfile is written by npm, not by this script, so it is REPORTED,
  // not rewritten: the fix is
  //   npm --prefix <dir> install --package-lock-only --no-audit --no-fund
  // packages/cli has no lockfile by design (zero-dependency) — skipped.
  for (const [dir, lockRel] of [
    ['packages/mcp', 'packages/mcp/package-lock.json'],
  ]) {
    const lockPath = join(rootDir, lockRel);
    if (!existsSync(lockPath)) continue;
    const pkgPath = join(rootDir, dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkgVersion = readPackageVersion(readFileSync(pkgPath, 'utf8'));
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const versions = [lock.version, lock.packages?.['']?.version].filter((v) => typeof v === 'string');
    if (versions.some((v) => v !== pkgVersion)) {
      touched.push(
        `${lockRel} (version ${versions.join('/')} != ${dir}/package.json ${pkgVersion}) — ` +
          `fix: npm --prefix ${dir} install --package-lock-only --no-audit --no-fund`,
      );
    }
  }

  return touched;
}

/** The top-level "version" field of a package.json, as a string. */
function readPackageVersion(raw) {
  const m = /"version"\s*:\s*"([^"]+)"/.exec(raw);
  return m ? m[1] : '';
}

function main() {
  const args = process.argv.slice(2);
  let root = DEFAULT_ROOT;
  const ri = args.indexOf('--root');
  if (ri !== -1 && args[ri + 1]) root = resolve(args[ri + 1]);
  const check = args.includes('--check');
  const touched = syncConfig({ root, check });
  if (check) {
    if (touched.length) {
      console.error(
        'sync-config --check: version drift from archgen.config.json (fix: npm --prefix packages/cli run sync:config):\n  ' +
          touched.join('\n  '),
      );
      process.exitCode = 1;
    } else {
      console.log('sync-config --check: all derived versions match archgen.config.json');
    }
    return;
  }
  console.log(touched.length ? 'sync-config: updated:\n  ' + touched.join('\n  ') : 'sync-config: already in sync');
}

// Node realpath-resolves import.meta.url, but process.argv[1] keeps its
// as-typed form; where the script is launched through a symlinked path
// (macOS /tmp and /var/folders -> /private/...) a plain equality never matches
// and main() would silently never run. Resolve argv[1] the same way first.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
  } catch {
    return false;
  }
}
if (invokedDirectly()) main();
