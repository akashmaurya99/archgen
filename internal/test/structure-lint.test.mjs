// structure-lint.test.mjs — the shape gate must be able to FAIL.
//
// WHY THIS FILE EXISTS.
//
// The repository's gates are only worth what they can catch. A gate that
// cannot fail is a gate whose BEHAVIOUR nobody knows: it looks like
// coverage, and it passes for reasons that have nothing to do with the
// thing it claims to check.
//
// This gate was written AFTER the defects it looks for were found, so each
// check has a known true positive. This suite builds a scratch repository
// with exactly ONE defect in it and asserts the gate reports that defect —
// and that the same repository, without the defect, passes.
//
// A check that silently stopped firing would leave the repository
// unprotected while every CI job stayed green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const GATE = join(ROOT, 'internal', 'tools', 'lint', 'structure-lint.mjs');

/**
 * Run the gate against a repository root.
 *
 * @param {string} root the repository root
 * @returns {{code: number, out: string}}
 */
function runGate(root) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, '--root', root], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

/**
 * A scratch git repository holding one source file, then mutated.
 *
 * It is a real git repository because the gate reads git's index: that is
 * what makes the gate ignore a developer's local machine state.
 *
 * @param {(dir: string) => void} mutate adds the defect
 * @returns {string} the repository root
 */
function scratchRepo(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'archgen-struct-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'gate@test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'gate'], { cwd: dir });
  mkdirSync(join(dir, 'packages', 'mcp', 'src', 'core', 'protocol'), { recursive: true });
  writeFileSync(
    join(dir, 'packages', 'mcp', 'src', 'core', 'protocol', 'errors.mjs'),
    "// errors.mjs — a clean file, so only the injected defect can fire.\nexport const E = 1;\n",
  );
  mutate(dir);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'scratch'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

test('structure-lint passes a repository with no structural defect', () => {
  const dir = scratchRepo(() => {});
  try {
    const r = runGate(dir);
    assert.equal(r.code, 0, `the gate must pass a clean repository:\n${r.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('structure-lint catches a NUL byte (the file reads as binary to every tool)', () => {
  const dir = scratchRepo((d) => {
    writeFileSync(
      join(d, 'packages', 'mcp', 'src', 'core', 'protocol', 'bad.mjs'),
      Buffer.concat([
        Buffer.from("// bad.mjs — a header, so only the NUL fires.\nconst x = 'a"),
        Buffer.from([0]),
        Buffer.from("';\n"),
      ]),
    );
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 1, 'the gate must fail on a NUL byte');
    assert.match(r.out, /S1/, 'the NUL byte must be reported as S1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('structure-lint catches a nested node_modules inside a package', () => {
  const dir = scratchRepo((d) => {
    const nm = join(d, 'packages', 'mcp', 'src', 'core', 'protocol', 'node_modules');
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, 'stale.js'), 'module.exports = 1;\n');
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 1, 'the gate must fail on a nested node_modules');
    assert.match(r.out, /S2/, 'the nested node_modules must be reported as S2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('structure-lint catches a source file with no header comment', () => {
  const dir = scratchRepo((d) => {
    writeFileSync(
      join(d, 'packages', 'mcp', 'src', 'core', 'protocol', 'noheader.mjs'),
      'export const Q = 2;\n',
    );
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 1, 'the gate must fail on a headerless source file');
    assert.match(r.out, /S3/, 'the headerless file must be reported as S3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('structure-lint catches a helper copied verbatim into two files', () => {
  const dir = scratchRepo((d) => {
    const fn = "function helper() {\n  return 42;\n}\n";
    writeFileSync(
      join(d, 'packages', 'mcp', 'src', 'core', 'protocol', 'a.mjs'),
      `// a.mjs — a header.\n${fn}export { helper };\n`,
    );
    writeFileSync(
      join(d, 'packages', 'mcp', 'src', 'core', 'protocol', 'b.mjs'),
      `// b.mjs — a header.\n${fn}export { helper };\n`,
    );
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 1, 'the gate must fail on a verbatim copy');
    assert.match(r.out, /S4/, 'the verbatim copy must be reported as S4');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('structure-lint catches an import that points at a file that does not exist', () => {
  const dir = scratchRepo((d) => {
    writeFileSync(
      join(d, 'packages', 'mcp', 'src', 'core', 'protocol', 'broken.mjs'),
      "// broken.mjs — a header.\nimport { x } from './does-not-exist.mjs';\nexport { x };\n",
    );
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 1, 'the gate must fail on a broken import');
    assert.match(r.out, /S5/, 'the broken import must be reported as S5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('structure-lint passes the repository as it stands', () => {
  const r = runGate(ROOT);
  assert.equal(r.code, 0, `the gate must pass this repository:\n${r.out}`);
});
