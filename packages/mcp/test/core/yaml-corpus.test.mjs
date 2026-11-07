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

import { parseYaml, stringifyYaml } from '../../src/core/yaml.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/mcp/test/core -> repo root (four levels up).
const REPO = join(HERE, '..', '..', '..', '..');
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
  if (!existsSync(CORPUS_DIR)) return; // published package — no repo fixtures
  assert.ok(
    corpusFiles.length >= 5,
    `the yaml corpus must not be emptied (found ${corpusFiles.length} files)`,
  );
});

test('every corpus file has a committed expectation', () => {
  if (!existsSync(CORPUS_DIR)) return;
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

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
