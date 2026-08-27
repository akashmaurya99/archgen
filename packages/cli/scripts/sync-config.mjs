// sync-config.mjs — propagate the canonical archgen.config.json into every
// derived location so the version can never drift again.
//
// Derived targets (each left byte-identical when already correct → idempotent):
//   (a) skill/archgen.config.json     verbatim pretty-printed copy of canonical
//   (b) skill/SKILL.md                ONLY the frontmatter `metadata.version` line
//   (c) packages/cli/package.json     the "version" field
//   (d) packages/extension/package.json  the "version" field (when present —
//       published CLI layouts and test fixtures ship without the extension)
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
 * every other byte — hand-formatted files (compact one-line objects in the
 * extension manifest) must not be reflowed by a version bump.
 * Top-level keys carry the file's base indent (the indent of the first key
 * after the opening brace); nested keys indent deeper, so they never match.
 * @param {string} raw package.json contents
 * @param {string} version MAJOR.MINOR.PATCH to set
 * @returns {string} new contents
 */
export function setPackageVersion(raw, version) {
  const lines = raw.split('\n');
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

  // (a) derived skill copy
  const skillCfgPath = join(rootDir, 'skill', 'archgen.config.json');
  const desiredCfg = JSON.stringify(cfg, null, 2) + '\n';
  if (!existsSync(skillCfgPath) || readFileSync(skillCfgPath, 'utf8') !== desiredCfg) {
    if (!check) writeFileAtomic(skillCfgPath, desiredCfg);
    touched.push('skill/archgen.config.json');
  }

  // (b) SKILL.md frontmatter metadata.version line only
  const skillMdPath = join(rootDir, 'skill', 'SKILL.md');
  const rawMd = readFileSync(skillMdPath, 'utf8');
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

  // (d) extension package.json version field — exist-conditional: published
  // CLI layouts and test fixtures ship without the extension package.
  const extPkgPath = join(rootDir, 'packages', 'extension', 'package.json');
  if (existsSync(extPkgPath)) {
    const rawExt = readFileSync(extPkgPath, 'utf8');
    const nextExt = setPackageVersion(rawExt, cfg.version);
    if (nextExt !== rawExt) {
      if (!check) writeFileAtomic(extPkgPath, nextExt);
      touched.push('packages/extension/package.json (version)');
    }
  }

  return touched;
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
