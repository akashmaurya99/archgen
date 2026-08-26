// sync-config.mjs — propagate the canonical archgen.config.json into every
// derived location so the version can never drift again.
//
// Derived targets (each left byte-identical when already correct → idempotent):
//   (a) skill/archgen.config.json     verbatim pretty-printed copy of canonical
//   (b) skill/SKILL.md                ONLY the frontmatter `metadata.version` line
//   (c) packages/cli/package.json     the "version" field
//
// All writes are atomic (temp sibling file + rename). Run automatically via
// `prepublishOnly` and `npm run sync`; run standalone via `npm run sync:config`.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
 * Sync all derived targets against <root>/archgen.config.json.
 * @param {{root?: string}} opts repo root (defaults to this checkout's root)
 * @returns {string[]} human-readable list of files actually rewritten
 */
export function syncConfig({ root = DEFAULT_ROOT } = {}) {
  const rootDir = resolve(root);
  const cfg = parseConfig(readFileSync(join(rootDir, 'archgen.config.json'), 'utf8'), join(rootDir, 'archgen.config.json'));
  const changed = [];

  // (a) derived skill copy
  const skillCfgPath = join(rootDir, 'skill', 'archgen.config.json');
  const desiredCfg = JSON.stringify(cfg, null, 2) + '\n';
  if (!existsSync(skillCfgPath) || readFileSync(skillCfgPath, 'utf8') !== desiredCfg) {
    writeFileAtomic(skillCfgPath, desiredCfg);
    changed.push('skill/archgen.config.json');
  }

  // (b) SKILL.md frontmatter metadata.version line only
  const skillMdPath = join(rootDir, 'skill', 'SKILL.md');
  const rawMd = readFileSync(skillMdPath, 'utf8');
  const nextMd = setFrontmatterVersion(rawMd, cfg.version);
  if (nextMd !== rawMd) {
    writeFileAtomic(skillMdPath, nextMd);
    changed.push('skill/SKILL.md (metadata.version)');
  }

  // (c) CLI package.json version field
  const pkgPath = join(rootDir, 'packages', 'cli', 'package.json');
  const rawPkg = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(rawPkg);
  if (pkg.version !== cfg.version) {
    pkg.version = cfg.version;
    const out = JSON.stringify(pkg, null, 2) + '\n';
    if (out !== rawPkg) {
      writeFileAtomic(pkgPath, out);
      changed.push('packages/cli/package.json (version)');
    }
  }

  return changed;
}

function main() {
  const args = process.argv.slice(2);
  let root = DEFAULT_ROOT;
  const ri = args.indexOf('--root');
  if (ri !== -1 && args[ri + 1]) root = resolve(args[ri + 1]);
  const changed = syncConfig({ root });
  console.log(changed.length ? 'sync-config: updated:\n  ' + changed.join('\n  ') : 'sync-config: already in sync');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
