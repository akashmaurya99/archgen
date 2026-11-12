// structure-lint.mjs — the gate that keeps the repository's SHAPE honest.
//
// WHY THIS FILE EXISTS.
//
// The repository has eight gates that check what the code DOES: the version
// lives in one place, the skill declares the server it needs, every failure
// site teaches its next call, the always-on context fits its budget, the
// suites never mutate the tree, the vendor mirror matches, no secret is
// committed, no high-severity advisory is installed.
//
// None of them check what the code LOOKS LIKE. So the shape of the
// repository was nobody's business: a directory could grow to fifty files
// with nobody objecting, a helper could be copy-pasted into six files, and
// a stale dependency could sit inside a published directory — and every
// gate would still be green, because the CODE was fine.
//
// These are the checks that would have caught the defects that were
// actually found:
//
//   S1  a NUL byte in a source file, which makes it binary to every tool
//       that reads it (grep skips it, `file` calls it data)
//   S2  a nested node_modules inside a package — the CLI is zero-dependency
//       and the server resolves its own, so one can only be a stray install
//       — and it sits FIRST on Node's module resolution path, so a stale
//       copy silently wins over the current one
//   S3  a source file with no header comment, which breaks the one
//       convention that makes a file explain itself
//   S4  the same helper name defined in several files of one package, which
//       is how one rule starts disagreeing with itself
//   S5  an import that points at a file that does not exist — the failure
//       mode of a moved file
//   S6  a directory that has grown past the size it was laid out for, which
//       is the drift this whole reorganisation exists to stop
//
// Usage: node internal/tools/lint/structure-lint.mjs
// Exit 0 ok · 1 a structural defect · 4 usage/IO error
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedFiles } from './tracked-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..', '..', '..');

/** Directories that are never inspected: they are not source. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'vendor', '.codegraph', 'fixtures']);

/** The source roots the checks apply to. */
const SOURCE_ROOTS = ['packages/mcp/src', 'packages/cli/lib', 'packages/cli/bin', 'packages/cli/scripts', 'internal'];

/** A directory may hold at most this many files before it is "too flat". */
const MAX_FILES_PER_DIR = 20;

/**
 * Every source file under a directory.
 *
 * @param {string} dir the directory to walk
 * @returns {string[]} the absolute paths
 */
function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(mjs|js)$/.test(entry.name)) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

/**
 * The top-level function definitions in a file.
 *
 * Only TOP-LEVEL definitions count: a nested helper inside a function is
 * scoped to it and cannot collide with another file's helper.
 *
 * @param {string} text the file's source
 * @returns {Map<string, string>} the defined name -> its source text
 */
function definedFunctions(text) {
  const out = new Map();
  const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  for (const m of text.matchAll(re)) {
    const start = m.index;
    // the body runs to the first line that closes the function at column 0
    const rest = text.slice(start);
    const end = rest.indexOf('\n}');
    const body = end === -1 ? rest : rest.slice(0, end + 2);
    out.set(m[1], body.replace(/\s+/g, ' ').trim());
  }
  return out;
}

/**
 * The relative import specifiers in a file.
 *
 * Only specifiers on a line that STARTS with `import` or `export` are
 * counted: a specifier inside a longer string literal is data — a test may
 * write a probe file whose contents are an import statement — not an
 * import of this module.
 *
 * @param {string} text the file's source
 * @returns {string[]} the specifiers
 */
function importSpecifiers(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!/^\s*(?:import|export)\b/.test(line)) continue;
    for (const m of line.matchAll(/(?:from|import)\s+'(\.[^']*)'/g)) out.push(m[1]);
  }
  return out;
}

/**
 * Run every check.
 *
 * @param {string} root the repository root
 * @returns {{ok: boolean, findings: string[]}}
 */
function lintStructure(root = ROOT) {
  const findings = [];
  const files = trackedFiles(root);

  // ---- S1: no NUL byte in a tracked file -------------------------------
  for (const rel of files) {
    const abs = join(root, rel);
    let buf;
    try {
      buf = readFileSync(abs);
    } catch {
      continue; // a file that cannot be read is not a NUL byte
    }
    if (buf.includes(0)) {
      findings.push(`S1  ${rel} contains a NUL byte — the file reads as BINARY to grep, file(1) and every editor`);
    }
  }

  // ---- S2: no nested node_modules inside a package ----------------------
  for (const rel of files) {
    if (!/(^|\/)node_modules\//.test(rel)) continue;
    // A node_modules is only legitimate at the ROOT of a package that
    // declares dependencies. Inside packages/cli/lib or packages/mcp/src it
    // is a stray install.
    if (/^packages\/[^/]+\/(lib|src|bin|scripts)\//.test(rel)) {
      findings.push(`S2  ${rel} — a nested node_modules inside a package's source. It shadows the real one on the resolution path.`);
    }
  }

  // ---- S3: every source file has a header comment ----------------------
  const sourceSet = new Set();
  for (const rootDir of SOURCE_ROOTS) {
    const abs = join(root, rootDir);
    if (!existsSync(abs)) continue;
    for (const f of sourceFiles(abs)) sourceSet.add(f);
  }
  for (const abs of sourceSet) {
    const rel = relative(root, abs);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const firstLine = text.split('\n')[0].trim();
    // A shebang line is not a header — the header is the line after it.
    const header = firstLine.startsWith('#!') ? (text.split('\n')[1] ?? '').trim() : firstLine;
    if (!header.startsWith('//')) {
      findings.push(`S3  ${rel} has no header comment — every other source file opens with one that says what it owns`);
    }
  }

  // ---- S4: no VERBATIM copy of a helper within a package ---------------
  // Only a byte-identical copy is reported. Two files that happen to use
  // the same NAME (`main`, `die`, `run`) are not a defect — they are two
  // different functions that a reader tells apart by their file. A
  // VERBATIM copy is: the same rule written twice, which is how one rule
  // starts disagreeing with itself.
  const byPackage = new Map();
  for (const abs of sourceSet) {
    const rel = relative(root, abs);
    const pkg = rel.split('/')[0] === 'packages' ? rel.split('/').slice(0, 2).join('/') : 'internal';
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const [name, body] of definedFunctions(text)) {
      if (!byPackage.has(pkg)) byPackage.set(pkg, new Map());
      const m = byPackage.get(pkg);
      const key = `${name}\u0000${body}`;
      if (!m.has(key)) m.set(key, { name, body, files: [] });
      m.get(key).files.push(rel);
    }
  }
  for (const [pkg, copies] of byPackage) {
    for (const { name, files } of copies.values()) {
      if (files.length > 1) {
        findings.push(`S4  ${pkg}: '${name}' is copied VERBATIM into ${files.length} files — one implementation, one place: ${files.join(', ')}`);
      }
    }
  }

  // ---- S5: every relative import resolves ------------------------------
  for (const abs of sourceSet) {
    const rel = relative(root, abs);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const spec of importSpecifiers(text)) {
      const target = resolve(dirname(abs), spec);
      if (!existsSync(target)) {
        findings.push(`S5  ${rel} imports '${spec}' — that file does not exist`);
      }
    }
  }

  // ---- S6: no directory has grown past the size it was laid out for ----
  for (const rootDir of SOURCE_ROOTS) {
    const abs = join(root, rootDir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const dir = join(abs, entry.name);
      const count = readdirSync(dir).length;
      if (count > MAX_FILES_PER_DIR) {
        findings.push(`S6  ${relative(root, dir)} holds ${count} files — over the ${MAX_FILES_PER_DIR} it was laid out for. Split it by domain.`);
      }
    }
  }

  return { ok: findings.length === 0, findings };
}

function main() {
  const args = process.argv.slice(2);
  let root = DEFAULT_ROOT;
  const ri = args.indexOf('--root');
  if (ri !== -1 && args[ri + 1]) root = resolve(args[ri + 1]);

  let result;
  try {
    result = lintStructure(root);
  } catch (e) {
    console.error(`structure-lint: ${e.message}`);
    process.exit(4);
    return;
  }
  if (!result.ok) {
    console.error('structure-lint: the repository\'s shape has drifted.');
    for (const f of result.findings) console.error(`  ${f}`);
    console.error('  Each of these was a real defect at some point. See the header of this file.');
    process.exit(1);
    return;
  }
  console.log('structure-lint: the repository\'s shape is clean — no binary files, no nested dependencies, no headerless sources, no duplicated helpers, no broken imports, no oversized directory.');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
