// yaml-corpus.test.mjs — the canonical YAML parser, pinned to the corpus.
//
// WHY THIS FILE EXISTS. `fixtures/yaml-corpus/` is a FROZEN set of inputs and
// their committed expectations. It is the only artifact-format contract the
// repo holds: a plan is a `tasks.yaml`, an architecture is an
// `architecture.yaml`, and every other part of archgen (the verifier, the
// wave resolver, the registry updater, the status mutator) reads what this
// parser returns. If the parser drifts, every one of them drifts with it —
// silently, because each of them is individually correct.
//
// The corpus used to have TWO consumers: the MCP core's parser and a
// hand-written TypeScript port the VS Code extension carried. Two
// implementations of one format is exactly the drift this repo cannot afford,
// so the port is gone — and with it went the only test that asserted the
// corpus. This file is that test's replacement, and it is STRICTLY STRONGER
// than the one it replaces:
//
//   - the expectations are asserted against the CANONICAL parser (there is no
//     second implementation left to agree with);
//   - the round-trip asserts the COMMENT LEDGER survives, not merely that
//     the comment text appears somewhere in the output.
//
// The expectations are committed JSON, so a parser change that alters a
// parsed value fails here loudly instead of quietly changing what every
// downstream tool sees. Never adjust an expectation to make a test pass —
// that is how a format drifts without anyone noticing.
//
// The corpus lives at the repo root and is NOT published with the npm
// package, so the test skips itself when the corpus is absent (a published
// package has no `fixtures/`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml, stringifyYaml } from '../../src/core/fs/yaml.mjs';
import { REPO_ROOT, inRepo, requireCorpus } from '../support/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/mcp/test/core -> repo root (four levels up).
const REPO = REPO_ROOT;
const CORPUS_DIR = join(REPO, 'fixtures', 'yaml-corpus');

/** @typedef {{ok: true, data: unknown, comments: unknown[]}} ExpectedOk */
/** @typedef {{ok: false, errorMatches: string}} ExpectedErr */

const corpusFiles = existsSync(CORPUS_DIR)
  ? readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.yaml')).sort()
  : [];

/** Read the committed expectation for one corpus file. */
function expectationFor(file) {
  const p = join(CORPUS_DIR, file.replace(/\.yaml$/, '.expected.json'));
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** The comments a source file carries, as the parser records them. */
function commentOrder(text) {
  return [...text.matchAll(/#[^\n]*/g)].map((m) => m[0].trim());
}

test('the YAML corpus is present and non-empty', () => {
  if (!inRepo()) return; // published package — the corpus is not shipped
  requireCorpus(CORPUS_DIR, 'the YAML corpus');
  assert.ok(
    corpusFiles.length >= 5,
    `the yaml corpus must not be emptied (found ${corpusFiles.length} files)`,
  );
});

test('every corpus file has a committed expectation', () => {
  if (!inRepo()) return; // published package — the corpus is not shipped
  requireCorpus(CORPUS_DIR, 'the YAML corpus');
  for (const file of corpusFiles) {
    const p = join(CORPUS_DIR, file.replace(/\.yaml$/, '.expected.json'));
    assert.ok(existsSync(p), `${file} has no .expected.json sibling`);
  }
});

for (const file of corpusFiles) {
  const source = readFileSync(join(CORPUS_DIR, file), 'utf8');
  const expected = expectationFor(file);

  test(`${file}: ${expected.ok ? 'parses to the committed data + comments' : `throws /${expected.errorMatches}/`}`, () => {
    if (!expected.ok) {
      assert.throws(
        () => parseYaml(source, { filename: file }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, new RegExp(escapeRegExp(expected.errorMatches)));
          return true;
        },
        `${file} must be rejected with a message matching ${expected.errorMatches}`,
      );
      return;
    }
    const { data, comments } = parseYaml(source, { filename: file });
    assert.deepEqual(data, expected.data, `${file}: the parsed data drifted from the committed expectation`);
    assert.deepEqual(comments, expected.comments, `${file}: the comment ledger drifted from the committed expectation`);
  });

  if (expected.ok) {
    test(`${file}: round-trips through stringifyYaml with its comments intact`, () => {
      const { data, comments } = parseYaml(source, { filename: file });
      const out = stringifyYaml(data, comments);
      const reparsed = parseYaml(out, { filename: file });
      assert.deepEqual(reparsed.data, data, `${file}: the data did not survive the round-trip`);
      // The LEDGER must survive — not just the text. A comment that drifts to
      // a different anchor is a reviewer note attached to the wrong line.
      assert.deepEqual(
        reparsed.comments,
        comments,
        `${file}: the comments did not survive the round-trip at their anchors`,
      );
      assert.deepEqual(
        commentOrder(out),
        commentOrder(source),
        `${file}: the comments changed order through the round-trip`,
      );
    });
  }
}

// ── the behaviours a plan file depends on ──────────────────────────────────
//
// The corpus covers the FILE SHAPES. These cases cover the DECISIONS: what
// the parser accepts, what it refuses, and where it anchors a comment. They
// are the same behaviours the old two-implementation parity test pinned —
// asserted against the one implementation that is left.

test('a duplicate mapping key is refused, never silently last-wins', () => {
  assert.throws(
    () => parseYaml('a: 1\na: 2\n', { filename: 'case.yaml' }),
    /duplicate key 'a'/,
  );
});

test('a tab in the indentation is refused', () => {
  assert.throws(
    () => parseYaml('good: 1\n\tbad: 2\n', { filename: 'case.yaml' }),
    /tab characters are not allowed/,
  );
});

test('an unterminated flow sequence is refused', () => {
  assert.throws(
    () => parseYaml('items: [1, 2\nmore: stuff\n', { filename: 'case.yaml' }),
    /unterminated flow sequence/,
  );
});

test('a scalar root is refused — a plan is always a mapping', () => {
  assert.throws(() => parseYaml('42\n', { filename: 'case.yaml' }), /expected 'key:' mapping entry/);
  assert.throws(() => parseYaml('null\n', { filename: 'case.yaml' }), /expected 'key:' mapping entry/);
});

test('a sequence of mappings parses into a sequence of objects', () => {
  const { data, comments } = parseYaml('items:\n  - id: X\n    ok: true\n', { filename: 'case.yaml' });
  assert.deepEqual(data, { items: [{ id: 'X', ok: true }] });
  assert.deepEqual(comments, []);
});

test('a leading comment anchors to its key and a trailing one stays inline', () => {
  const { data, comments } = parseYaml('# lead\na: 1 # trail\n', { filename: 'case.yaml' });
  assert.deepEqual(data, { a: 1 });
  assert.deepEqual(comments, [
    { path: ['a'], inline: false, text: '# lead' },
    { path: ['a'], inline: true, text: '# trail' },
  ]);
});

test('quoted values keep their exact text', () => {
  const { data } = parseYaml("a: 'x y'\nb: \"z\"\n", { filename: 'case.yaml' });
  assert.deepEqual(data, { a: 'x y', b: 'z' });
});

// ── what an agent actually writes ───────────────────────────────────────────
//
// The corpus pins the FILE SHAPES. These pin the DECISIONS an agent cannot be
// taught from the shapes: a title with a colon in it, an acceptance criterion
// that reads like a mapping, a value the writer would flatten into a string.
// Each of these was a fatal error or a silent corruption, and a plan that hit
// one could not be validated, executed, or status-updated.

test('a quoted sequence item is a scalar, never a mapping', () => {
  // The key-shaped tests match INSIDE the quotes, so this used to be rewritten
  // as a mapping and die on an unterminated quoted key.
  const { data } = parseYaml('acceptance:\n  - "Test: returns 200"\n', { filename: 'case.yaml' });
  assert.deepEqual(data, { acceptance: ['Test: returns 200'] });
});

test('a mapping value may contain ": "', () => {
  // A nested mapping cannot start on the key's own line, so the remainder is
  // unambiguously the scalar. Refusing it rejected ordinary titles and killed
  // every check on the file.
  const { data } = parseYaml('title: Refactor: the auth module\n', { filename: 'case.yaml' });
  assert.deepEqual(data, { title: 'Refactor: the auth module' });
});

test('a quoted key in a sequence item stays a mapping', () => {
  const { data } = parseYaml('items:\n  - "odd: key": 1\n', { filename: 'case.yaml' });
  assert.deepEqual(data, { items: [{ 'odd: key': 1 }] });
});

test('a flow mapping nested in a flow sequence parses', () => {
  const { data } = parseYaml('a: [{x: 1, y: 2}]\n', { filename: 'case.yaml' });
  assert.deepEqual(data, { a: [{ x: 1, y: 2 }] });
});

test('the writer never flattens a collection into a scalar', () => {
  // The first key of a sequence item shared the dash's line, so its value was
  // written through the scalar encoder: a list became "a,b" and an object
  // became "[object Object]". The writer put that on disk.
  const source = 'tasks:\n  - acceptance: ["a", "b"]\n    id: T1\n';
  const { data } = parseYaml(source, { filename: 'case.yaml' });
  const { data: again } = parseYaml(stringifyYaml(data), { filename: 'case.yaml' });
  assert.deepEqual(again, data);
});

test('every value the writer emits reads back unchanged', () => {
  // The writer's contract is that its output parses back to the value it was
  // given. A value it cannot express must be quoted, never approximated.
  const values = [
    'plain text', 'has: colon', 'a, b', 'C#', 'x # y', 'has "quotes"', "it's",
    "'quoted'", '"abc', '"', "'", '  padded  ', '- dash', '? question', '@ at',
    'back`tick', '% pct', '{brace}', '[brack]', 'ends with colon:', 'true',
    'false', 'null', '42', '-17', '3.14', 'yes', 'no', 'on', 'off', '',
    'line1\nline2', 'multi\nline\n', 'a\tb', '修复：认证模块', 'http://x/y',
    '1e21', '1e+5', '1e-5', '-0', '0.0', '007', '1.5', 'TRUE', 'NULL',
  ];
  for (const value of values) {
    const out = stringifyYaml({ k: value });
    let parsed;
    try {
      parsed = parseYaml(out, { filename: 'case.yaml' }).data;
    } catch (e) {
      assert.fail(`the writer emitted a file the parser refuses for ${JSON.stringify(value)}: ${out} — ${e.message}`);
    }
    assert.equal(parsed.k, value, `the writer lost ${JSON.stringify(value)}: emitted ${out}`);
  }
});

test('a nested array survives the write and the read back', () => {
  // A nested array written as a MAPPING came back as {"0": 1, "1": 2} — a
  // silent type change on every rewrite.
  const source = 'k: [[1, 2]]\n';
  const { data } = parseYaml(source, { filename: 'case.yaml' });
  const { data: back } = parseYaml(stringifyYaml(data), { filename: 'case.yaml' });
  assert.deepEqual(back, data);
  assert.deepEqual(back.k, [[1, 2]]);
});

test('the writer preserves a collection nested under a sequence item', () => {
  const source = 'tasks:\n  - meta:\n      a: 1\n    id: T1\n';
  const { data } = parseYaml(source, { filename: 'case.yaml' });
  const { data: again } = parseYaml(stringifyYaml(data), { filename: 'case.yaml' });
  assert.deepEqual(again, data);
});

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
