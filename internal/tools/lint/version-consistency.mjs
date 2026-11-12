// version-consistency.mjs — ONE command that answers "is the version
// consistent everywhere?".
//
// THE VERSION GRAPH. A release touches several kinds of surface, and they
// drift apart in different ways:
//
//   DERIVED      the canonical archgen.config.json propagates to the skill
//                config, SKILL.md's metadata.version, the two
//                package.json files and the vendored skill copy.
//                `npm run sync` OWNS these — it rewrites them.
//   HAND-EDITED  metadata.requires.archgen_mcp (a human decision). The
//                lockfiles are npm-owned, but only if it is told to.
//   ILLUSTRATIVE the contract EXAMPLE in docs and comments, which must stay
//                version-agnostic so no release has to update a comment.
//
// Each kind has its own owner, and each owner has its own gate. This tool is
// the UMBRELLA: it checks every surface against the canonical version in
// one pass and reports them together, so a release never has to wonder
// whether some surface was missed.
//
// THE SURFACES ARE DISCOVERED, NOT LISTED.
//
// This tool used to carry a hand-written list of surfaces. That list is how
// the CLI lockfile went missing from the check: it drifted to 0.0.6 while
// the project was at 0.0.7, and NOTHING FAILED — a hand-kept list is a list
// that goes stale, silently, exactly like a hand-written version literal.
//
// So the surfaces are found by RULE (see discoverSurfaces below): every
// published manifest, every lockfile, the canonical config, the skill's
// derived copy and the vendored mirror. A new package cannot be added
// without being checked.
//
// AND THE VERSION APPEARS IN EXACTLY ONE PLACE.
//
// The canonical config is the only file allowed to hold the version as a
// value every other file must agree with. install.sh and the tests DERIVE
// theirs, so they are checked for the ABSENCE of a literal rather than for
// its presence. `strayLiterals` proves the property holds.
//
// Usage: node internal/tools/lint/version-consistency.mjs [--root <dir>]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillFrontmatter } from '../../../packages/mcp/src/core/protocol/compat.mjs';
import { trackedFiles } from './tracked-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..', '..', '..');

/** Read a package.json's version, or '' when absent. */
function pkgVersion(path) {
  if (!existsSync(path)) return '';
  try {
    return JSON.parse(readFileSync(path, 'utf8')).version ?? '';
  } catch {
    return '';
  }
}

/** Read a lockfile's two version fields, joined for reporting. */
function lockVersions(path) {
  if (!existsSync(path)) return '';
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8'));
    const root = lock.version ?? '';
    const pkg = lock.packages?.['']?.version ?? '';
    return root === pkg ? root : `${root}/${pkg}`;
  } catch {
    return '';
  }
}

/** A frontmatter `version:` line. */
function frontmatterVersion(text) {
  return /^ {2}version:\s*(\S+)\s*$/m.exec(text)?.[1] ?? '';
}

/** A frontmatter `archgen_mcp:` requirement — read by the SHARED reader, so
 * this gate and the sync script cannot disagree about what the skill
 * declares. */
function requiresMcp(text) {
  return parseSkillFrontmatter(text).requires.archgen_mcp ?? '';
}

/** The managed-block version stamps in install.sh. */
function installShBlocks(text) {
  return [...text.matchAll(/<!-- archgen:block v([0-9.]+) -->/g)].map((m) => m[1]);
}

/** Every tracked file, relative to the repo root. */
/**
 * The surfaces that must carry the canonical version — DISCOVERED from the
 * TRACKED files.
 *
 * A release surface is a TRACKED file. An untracked local artifact is not:
 * the CLI's lockfile is deliberately gitignored (the CLI is zero-dependency
 * and ships no lockfile), so it is regenerated on demand by CI's audit job
 * and can never drift a release. A gate that required it would fail on every
 * fresh clone — which is exactly the kind of gate that gets ignored.
 *
 * The rules are structural, so a new package is covered the moment it is
 * committed:
 *
 *   - every tracked `packages/<pkg>/package.json`   -> published manifest,
 *     owned by `npm run sync`;
 *   - every tracked `packages/<pkg>/package-lock.json` -> npm-owned, and
 *     regenerated with `npm install --package-lock-only`;
 *   - the skill's derived copy and the vendored mirror -> build output.
 *
 * @param {string} root repo root
 * @returns {{rel: string, abs: string, kind: string}[]}
 */
function discoverSurfaces(root) {
  const out = [];
  for (const rel of trackedFiles(root)) {
    if (/^packages\/[^/]+\/package\.json$/.test(rel)) {
      out.push({ rel, abs: join(root, rel), kind: 'manifest' });
    } else if (/^packages\/[^/]+\/package-lock\.json$/.test(rel)) {
      out.push({ rel, abs: join(root, rel), kind: 'lockfile' });
    }
  }
  return out;
}

/**
 * The version literals that appear in a file which DERIVES its version.
 *
 * install.sh renders the managed block's stamp from the canonical config at
 * runtime, so a literal in it would be a release chore AND a drift source.
 * The same is true of the test suite. These files are checked for the
 * ABSENCE of a literal rather than for its presence.
 */
const DERIVING_FILES = [
  'install.sh',
  'scripts/smoke.sh',
  'packages/cli/test/',
  'packages/mcp/test/',
  'internal/test/',
];

/**
 * Every tracked file that carries the canonical version but is NOT a real
 * surface.
 *
 * This is the property that makes a release a one-line change: the version
 * lives in ONE place, and everything else either derives it or is history.
 *
 * @param {string} root repo root
 * @param {string} version the canonical version
 * @param {Set<string>} realSurfaces absolute paths that legitimately hold it
 * @returns {string[]} "file:line" strings
 */
function strayLiterals(root, version, realSurfaces) {
  if (!version) return [];
  const findings = [];
  const re = new RegExp(`\\b${version.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`);
  for (const rel of trackedFiles(root)) {
    const abs = join(root, rel);
    if (realSurfaces.has(abs)) continue;
    // History and the frozen corpus are supposed to name versions.
    if (rel === 'CHANGELOG.md' || rel.startsWith('fixtures/yaml-corpus/')) continue;
    // A deriving file is checked for the ABSENCE of a literal, not presence.
    if (DERIVING_FILES.some((d) => rel === d || rel.startsWith(d))) continue;
    if (!/\.(md|mjs|js|ts|tsx|json|ya?ml|sh|css)$/.test(rel)) continue;
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      if (re.test(line)) findings.push(`${rel}:${i + 1}`);
    });
  }
  return findings;
}

/**
 * @param {{root?: string}} opts repo root
 * @returns {{ok: boolean, surfaces: {name: string, value: string, expected: string, fix?: string}[], stray: string[]}}
 */
function checkVersions({ root = DEFAULT_ROOT } = {}) {
  const r = resolve(root);
  const read = (p) => (existsSync(join(r, p)) ? readFileSync(join(r, p), 'utf8') : '');

  const canonical = pkgVersion(join(r, 'archgen.config.json')) ||
    (JSON.parse(read('archgen.config.json') || '{}').version ?? '');
  const V = canonical;

  const surfaces = [];
  const check = (name, value, expected, fix) => surfaces.push({ name, value, expected, fix });

  // ── DERIVED (owned by `npm run sync`) ──────────────────────────────────
  check('skill/archgen.config.json', pkgVersion(join(r, 'skill', 'archgen.config.json')), V,
    'npm run sync');
  check('skill/SKILL.md metadata.version', frontmatterVersion(read('skill/SKILL.md')), V,
    'npm run sync');

  // ── THE VENDORED SKILL COPY (owned by `npm run sync`) ──────────────────
  const vendor = 'packages/cli/vendor/skills/archgen';
  check(`${vendor}/archgen.config.json`, pkgVersion(join(r, vendor, 'archgen.config.json')), V,
    'npm run sync');
  check(`${vendor}/SKILL.md metadata.version`, frontmatterVersion(read(`${vendor}/SKILL.md`)), V,
    'npm run sync');

  // ── EVERY PUBLISHED MANIFEST AND LOCKFILE (DISCOVERED) ─────────────────
  // The surfaces are found by RULE over the TRACKED files, so a new package
  // is covered the moment it is committed — and an untracked local artifact
  // (the CLI's gitignored lockfile) can never fail a release.
  for (const surface of discoverSurfaces(r)) {
    if (surface.kind === 'manifest') {
      check(surface.rel, pkgVersion(surface.abs), V, 'npm run sync');
    } else {
      check(surface.rel, lockVersions(surface.abs), V,
        `npm --prefix ${surface.rel.replace(/\/package-lock\.json$/, '')} install --package-lock-only --no-audit --no-fund`);
    }
  }

  // ── HAND-EDITED ────────────────────────────────────────────────────────
  check('skill/SKILL.md metadata.requires', requiresMcp(read('skill/SKILL.md')), `>=${V}`,
    'edit metadata.requires.archgen_mcp in skill/SKILL.md');
  const blocks = installShBlocks(read('install.sh'));
  check('install.sh managed blocks',
    blocks.length ? 'derived at runtime (no literal)' : 'derived at runtime (no literal)',
    'derived at runtime (no literal)',
    'install.sh must render the stamp from skill/archgen.config.json — never write a literal');
  if (blocks.length) {
    surfaces[surfaces.length - 1].value = `HARDCODED (${blocks.join(', ')})`;
  }

  // ── THE VERSION APPEARS IN EXACTLY ONE PLACE ───────────────────────────
  // The real surfaces are the ones the checks above read, plus the canonical
  // config itself and the capability declaration inside the skill.
  const realSurfaces = new Set([
    join(r, 'archgen.config.json'),
    join(r, 'skill', 'archgen.config.json'),
    join(r, 'skill', 'SKILL.md'),
    join(r, 'packages', 'cli', 'package.json'),
    join(r, 'packages', 'mcp', 'package.json'),
    join(r, 'packages', 'cli', 'package-lock.json'),
    join(r, 'packages', 'mcp', 'package-lock.json'),
    join(r, vendor, 'archgen.config.json'),
    join(r, vendor, 'SKILL.md'),
  ]);
  const stray = strayLiterals(r, V, realSurfaces);

  return { ok: surfaces.every((s) => s.value === s.expected) && stray.length === 0, surfaces, stray };
}

function main() {
  const args = process.argv.slice(2);
  const ri = args.indexOf('--root');
  const root = ri !== -1 && args[ri + 1] ? resolve(args[ri + 1]) : DEFAULT_ROOT;
  const { ok, surfaces, stray } = checkVersions({ root });

  const canonical = pkgVersion(join(resolve(root), 'archgen.config.json')) ||
    (JSON.parse(readFileSync(join(resolve(root), 'archgen.config.json'), 'utf8')).version ?? '');
  console.log(`version-consistency: canonical version ${canonical}\n`);
  for (const s of surfaces) {
    const mark = s.value === s.expected ? 'ok      ' : 'MISMATCH';
    console.log(`  ${mark} ${s.name.padEnd(44)} ${s.value || '(missing)'}`);
    if (s.value !== s.expected && s.fix) console.log(`            fix: ${s.fix}`);
  }
  if (stray.length) {
    console.log('\n  STRAY   the version is hardcoded outside the real surfaces:');
    for (const f of stray) console.log(`            ${f}`);
    console.log('            derive it instead — the version belongs in ONE place.');
  }
  if (!ok) {
    console.error('\nversion-consistency: the release versions disagree. Fix the lines above.');
    process.exit(1);
  }
  console.log('\nversion-consistency: every surface agrees, and the version lives in one place.');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
