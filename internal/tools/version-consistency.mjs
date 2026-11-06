// version-consistency.mjs — ONE command that answers "is the version
// consistent everywhere?".
//
// THE VERSION GRAPH. A release touches several kinds of surface, and they
// drift apart in different ways:
//
//   DERIVED      the canonical archgen.config.json propagates to the skill
//                config, SKILL.md's metadata.version, the three
//                package.json files and the vendored skill copy.
//                `npm run sync` OWNS these — it rewrites them.
//   HAND-EDITED  metadata.requires.archgen_mcp (a human decision), the
//                install.sh managed-block headers, and the lockfiles (npm
//                owns them, but only if it is told to).
//   ILLUSTRATIVE the contract EXAMPLE in docs and comments, which must stay
//                version-agnostic so no release has to update a comment.
//
// Each kind has its own owner, and each owner has its own gate. This tool
// is the UMBRELLA: it checks every surface against the canonical version in
// one pass and reports them together, so a release never has to wonder
// whether some surface was missed.
//
// Usage: node internal/tools/version-consistency.mjs [--root <dir>]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..', '..');

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

/** A frontmatter `archgen_mcp:` requirement. */
function requiresMcp(text) {
  return /archgen_mcp:\s*"([^"]+)"/.exec(text)?.[1] ?? '';
}

/** The managed-block version stamps in install.sh. */
function installShBlocks(text) {
  return [...text.matchAll(/<!-- archgen:block v([0-9.]+) -->/g)].map((m) => m[1]);
}

/**
 * @param {{root?: string}} opts repo root
 * @returns {{ok: boolean, surfaces: {name: string, value: string, expected: string, fix?: string}[]}}
 */
export function checkVersions({ root = DEFAULT_ROOT } = {}) {
  const r = resolve(root);
  const read = (p) => (existsSync(join(r, p)) ? readFileSync(join(r, p), 'utf8') : '');

  const canonical = pkgVersion(join(r, 'archgen.config.json')) ||
    (JSON.parse(read('archgen.config.json') || '{}').version ?? '');
  const V = canonical;

  const surfaces = [];
  const check = (name, value, expected, fix) => surfaces.push({ name, value, expected, fix });

  // ── DERIVED (owned by `npm run sync`) ──────────────────────────────────
  check('skill/archgen.config.json', pkgVersion(join(r, 'skill/archgen.config.json')), V,
    'npm run sync');
  check('skill/SKILL.md metadata.version', frontmatterVersion(read('skill/SKILL.md')), V,
    'npm run sync');
  check('packages/cli/package.json', pkgVersion(join(r, 'packages/cli/package.json')), V,
    'npm run sync');
  check('packages/mcp/package.json', pkgVersion(join(r, 'packages/mcp/package.json')), V,
    'npm run sync');
  check('packages/extension/package.json', pkgVersion(join(r, 'packages/extension/package.json')), V,
    'npm run sync');

  // ── THE VENDORED SKILL COPY (owned by `npm run sync`) ──────────────────
  const vendor = 'packages/cli/vendor/skills/archgen';
  check(`${vendor}/archgen.config.json`, pkgVersion(join(r, vendor, 'archgen.config.json')), V,
    'npm run sync');
  check(`${vendor}/SKILL.md metadata.version`, frontmatterVersion(read(`${vendor}/SKILL.md`)), V,
    'npm run sync');

  // ── HAND-EDITED ────────────────────────────────────────────────────────
  check('skill/SKILL.md metadata.requires', requiresMcp(read('skill/SKILL.md')), `>=${V}`,
    'edit metadata.requires.archgen_mcp in skill/SKILL.md');
  const blocks = installShBlocks(read('install.sh'));
  const badBlocks = blocks.filter((b) => b !== V);
  check('install.sh managed blocks', blocks.length ? blocks.join(', ') : '(none)', 
    blocks.length ? blocks.map(() => V).join(', ') : '(none)',
    'update the <!-- archgen:block vX.Y.Z --> headers in install.sh');
  if (badBlocks.length) {
    // The joined value already reports the mismatch; keep the per-block
    // detail for the reader.
    surfaces[surfaces.length - 1].value += ` (stale: ${badBlocks.join(', ')})`;
  }
  check('packages/mcp/package-lock.json', lockVersions(join(r, 'packages/mcp/package-lock.json')), V,
    'npm --prefix packages/mcp install --package-lock-only --no-audit --no-fund');
  check('packages/extension/package-lock.json', lockVersions(join(r, 'packages/extension/package-lock.json')), V,
    'npm --prefix packages/extension install --package-lock-only --no-audit --no-fund');

  return { ok: surfaces.every((s) => s.value === s.expected), surfaces };
}

function main() {
  const args = process.argv.slice(2);
  const ri = args.indexOf('--root');
  const root = ri !== -1 && args[ri + 1] ? resolve(args[ri + 1]) : DEFAULT_ROOT;
  const { ok, surfaces } = checkVersions({ root });

  const canonical = pkgVersion(join(resolve(root), 'archgen.config.json')) ||
    (JSON.parse(readFileSync(join(resolve(root), 'archgen.config.json'), 'utf8')).version ?? '');
  console.log(`version-consistency: canonical version ${canonical}\n`);
  for (const s of surfaces) {
    const mark = s.value === s.expected ? 'ok      ' : 'MISMATCH';
    console.log(`  ${mark} ${s.name.padEnd(44)} ${s.value || '(missing)'}`);
    if (s.value !== s.expected && s.fix) console.log(`            fix: ${s.fix}`);
  }
  if (!ok) {
    console.error('\nversion-consistency: the release versions disagree. Fix the lines above.');
    process.exit(1);
  }
  console.log('\nversion-consistency: every surface agrees.');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
