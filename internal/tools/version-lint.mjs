// version-lint.mjs — no release may ever pin a version in an example.
//
// THE PROBLEM THIS SOLVES, ONCE AND FOR ALL.
//
// A concrete version in a doc or a comment is a version that is wrong at the
// next release — and nobody notices: the doc still renders, the code still
// works, and the number is simply stale. Worse, it turns every release into
// a chore ("go and update the comments again and again"), and the chore gets
// skipped, and now there are FIVE copies of the contract example disagreeing
// with each other.
//
// THE RULE, PRECISE ON PURPOSE.
//
// A version literal may appear in:
//
//   THE REAL SURFACES      the canonical archgen.config.json and everything
//                          derived from it (the sync script owns those), the
//                          skill's real capability declaration, the
//                          lockfiles, the package manifests.
//   HISTORY                the CHANGELOGs — history is supposed to name
//                          versions.
//   TEST DATA              the suites compare versions against versions —
//                          an older version against a minimum is the
//                          assertion, so those literals are the point.
//   FROZEN SAMPLES         the shared YAML corpus is a fixed parser-parity
//                          fixture, not a sample of what this release emits.
//
// It may NOT appear in an ILLUSTRATIVE surface: docs, READMEs, reference
// assets, source comments, the manual-test script. Those show the SHAPE of
// something, and the shape does not have a version.
//
// The forbidden pattern is derived from the canonical version's MAJOR.MINOR,
// so the gate adapts as the project moves (0.0.x now, 1.2.x later) without
// ever needing an edit.
//
// Usage: node internal/tools/version-lint.mjs [--root <dir>]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..', '..');

/** File types that can carry prose or comments. */
const SCANNED = /\.(md|mjs|js|ts|tsx|json|ya?ml|sh|css)$/;

/** Paths whose version literals are legitimate. */
const ALLOWED = [
  // The canonical source and the real capability declaration + its copy.
  'archgen.config.json',
  'skill/',
  'packages/cli/vendor/',
  // History.
  'CHANGELOG.md',
  // The frozen parser-parity corpus.
  'fixtures/yaml-corpus/',
  // Manifests and lockfiles: their version IS the release.
  'package.json',
  'package-lock.json',
];

/** Paths excluded from the scan entirely (tests are data, not prose). */
const SKIP = [
  'packages/mcp/test/',
  'packages/cli/test/',
  'packages/extension/test/',
  'internal/test/',
];

/**
 * Lines that are a REAL version surface even inside a scanned file: the
 * managed-block stamp install.sh writes, and a manifest/frontmatter version
 * field. Everything else in the same file is prose.
 */
const ALLOWED_LINE = [
  /<!--\s*archgen:block\s+v\d+\.\d+\.\d+\s*-->/,
  /^\s*"?version"?\s*:\s*"?\d+\.\d+\.\d+"?\s*,?\s*$/,
  /^\s*version:\s*\d+\.\d+\.\d+\s*$/,
];

/**
 * The all-zero version is the semver sentinel for "unknown" — it is a
 * constant, not a release. `semverOr(pkg.version, '0.0.0')` means "no
 * version available", and it never changes.
 */
const UNKNOWN_SENTINEL = '0.0.0';

/** A version literal: dotted digits, with an optional pre-release suffix. */
const VERSION = /(?:^|[^\w.])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![\w.])/g;

/**
 * The canonical version's MAJOR.MINOR — the series this project is in.
 * @param {string} root repo root
 * @returns {string} e.g. "0.0"
 */
export function currentSeries(root = DEFAULT_ROOT) {
  const cfg = JSON.parse(readFileSync(join(root, 'archgen.config.json'), 'utf8'));
  const [major, minor] = String(cfg.version ?? '').split('.');
  return `${major}.${minor}`;
}

/**
 * Every tracked file, relative to the repo root.
 * Using git's index (rather than walking the disk) means build artifacts,
 * node_modules and other untracked state are never scanned.
 */
function trackedFiles(root) {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * @param {{root?: string}} opts repo root
 * @returns {{file: string, line: number, value: string}[]} violations
 */
export function lintVersions({ root = DEFAULT_ROOT } = {}) {
  const rootDir = resolve(root);
  const series = currentSeries(rootDir);
  const violations = [];

  for (const rel of trackedFiles(rootDir)) {
    if (!SCANNED.test(rel)) continue;
    if (SKIP.some((s) => rel.startsWith(s))) continue;
    if (ALLOWED.some((a) => rel === a || rel.endsWith(a) || rel.startsWith(a))) continue;

    const text = readFileSync(join(rootDir, rel), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (ALLOWED_LINE.some((re) => re.test(line))) return;
      VERSION.lastIndex = 0;
      let m;
      while ((m = VERSION.exec(line)) !== null) {
        const v = m[1];
        if (v === UNKNOWN_SENTINEL) continue;
        if (v.startsWith(`${series}.`)) {
          violations.push({ file: rel, line: i + 1, value: v });
        }
      }
    });
  }
  return violations;
}

function main() {
  const args = process.argv.slice(2);
  const ri = args.indexOf('--root');
  const root = ri !== -1 && args[ri + 1] ? resolve(args[ri + 1]) : DEFAULT_ROOT;
  const series = currentSeries(root);
  const violations = lintVersions({ root });

  if (violations.length) {
    console.error(
      `version-lint: a ${series}.x version is pinned in an ILLUSTRATIVE surface.\n` +
        'Examples show a shape, not a release. A pinned version is wrong at the\n' +
        'next release, nobody notices, and it makes every release a chore of\n' +
        'updating comments by hand.\n',
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.value}`);
    }
    console.error(
      '\nWrite the shape instead: "archgen vX.Y.Z" for a generator stamp,\n' +
        '">=x.y.z" for a capability requirement, "the installed version" for a\n' +
        'version seen at runtime. The REAL surfaces keep concrete versions and\n' +
        'are owned by the sync script and the capability-contract gate.',
    );
    process.exit(1);
  }
  console.log(`version-lint: no ${series}.x version is pinned in any illustrative surface.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
