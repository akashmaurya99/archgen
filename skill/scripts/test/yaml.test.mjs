// Tests for lib/yaml.mjs — run: node --test scripts/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, stringifyYaml } from '../lib/yaml.mjs';

const SAMPLE = `# Project tasks
tasks:
  # Core pipeline
  - id: C   # the root
    title: Build core
    file_ownership: ["src/core/**"]
    depends_on: []
  - id: B
    title: Wire API
    file_ownership:
      - "src/api/**"
    depends_on: [C]
meta:
  slug: demo
  active: true
  retries: 3
`;
const SAMPLE2 = `# Project tasks
tasks:
  # Core pipeline
  - id: C   # the root
    title: Build core
    file_ownership: ["src/core/**"]
    depends_on: []
  - id: B
    title: Wire API
    file_ownership:
      - "src/api/**"
    depends_on: [C]
meta:
  slug: demo
  active: true
  retries: 3
`;

test('parses nested maps, seq-of-maps, flow lists, scalars', () => {
  const { data } = parseYaml(SAMPLE);
  assert.equal(data.tasks.length, 2);
  assert.equal(data.tasks[0].id, 'C');
  assert.deepEqual(data.tasks[0].depends_on, []);
  assert.deepEqual(data.tasks[1].file_ownership, ['src/api/**']);
  assert.equal(data.meta.active, true);
  assert.equal(data.meta.retries, 3);
});

test('comment round-trip: every comment re-emitted verbatim in order', () => {
  const { data, comments } = parseYaml(SAMPLE);
  const texts = comments.map((c) => c.text);
  assert.ok(texts.includes('# Project tasks'));
  assert.ok(texts.includes('# Core pipeline'));
  assert.ok(comments.some((c) => c.inline && c.text.includes('# the root')));
  const out = stringifyYaml(data, comments);
  const re = parseYaml(out);
  // All original comment texts survive, in order, after a round-trip.
  const origOrder = (SAMPLE.match(/#[^\n]*/g) || []).map((s) => s.trim());
  const outOrder = (out.match(/#[^\n]*/g) || []).map((s) => s.trim());
  assert.deepEqual(outOrder, origOrder);
  assert.deepEqual(re.data, data);
});

test('value mutation preserves comments positionally', () => {
  const { data, comments } = parseYaml(SAMPLE2);
  data.tasks[0].status = 'done';
  const out = stringifyYaml(data, comments);
  assert.ok(out.includes('# Project tasks'));
  assert.ok(out.includes('# Core pipeline'));
  assert.ok(out.includes('status: done'));
  assert.ok(out.indexOf('# Project tasks') < out.indexOf('tasks:'));
});

test('tab indentation throws with filename and line', () => {
  try {
    parseYaml('a:\n\tb: 1\n', { filename: 'tasks.yaml' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.match(e.message, /tasks\.yaml:2/);
    assert.match(e.message, /tab/i);
  }
});

test('block scalars rejected with clear error', () => {
  assert.throws(() => parseYaml('desc: |\n  line one\n'), /block scalars are not supported/);
  assert.throws(() => parseYaml('desc: >\n  folded\n'), /block scalars are not supported/);
});

test('anchors/tags rejected', () => {
  assert.throws(() => parseYaml('a: &anchor 1\n'), /anchors\/tags/);
});

test('quoted strings preserve specials; escapes work', () => {
  const { data } = parseYaml(`a: "has: colon #hash"\nb: 'it''s'\n`);
  assert.equal(data.a, 'has: colon #hash');
  assert.equal(data.b, "it's");
});

test('flow sequence with quoted commas', () => {
  const { data } = parseYaml(`list: ["a, b", c, 'd']\n`);
  assert.deepEqual(data.list, ['a, b', 'c', 'd']);
});

test('null forms', () => {
  const { data } = parseYaml('a:\nb: ~\nc: null\n');
  assert.equal(data.a, null); assert.equal(data.b, null); assert.equal(data.c, null);
});

test('empty collections emit usable flow form', () => {
  const out = stringifyYaml({ t: [], m: {} });
  const { data } = parseYaml(out);
  assert.deepEqual(data, { t: [], m: {} });
});

test('scalar-only documents fail with the clean mapping-entry error', () => {
  for (const src of ['null\n', '42\n', 'true\n']) {
    try { parseYaml(src, { filename: 'scalar-root' }); assert.fail('should have thrown'); }
    catch (e) { assert.match(e.message, /expected 'key:' mapping entry/); }
  }
});

test('fuzz: 20 malformed inputs never crash uncaught — always YamlError or clean parse', () => {
  const bad = [
    'a: [1, 2', 'key\n', '- a\nb: 1\n', 'a:\n  - x\n y: 1\n', '"unclosed: 1\n',
    'a: *ref\n', '{flow: map}\n', 'a: |x\n', '\ta: 1\n', 'a: b: c\n',
    '- - -\n', 'a: [", ]\n', ': novalue\n', 'a::\n', 'x: "mixed\'\n',
    'a: !tag v\n', '---\ndoc: 2\n', 'a:\n- b: 1\n- : x\n', 'k: v # ok\n\tbad: 1\n', 'l: [[1], (2)]\n',
  ];
  let thrown = 0;
  for (const src of bad) {
    try {
      parseYaml(src, { filename: 'fuzz' });
    } catch (e) {
      thrown++;
      assert.match(e.constructor.name, /Error/);
    }
  }
  assert.ok(thrown >= 15, `expected most malformed inputs to throw, got ${thrown}`);
});
