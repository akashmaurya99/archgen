// Corpus parity tests — shared fixtures consumed by BOTH yaml implementations.
// Files: <repo-root>/fixtures/yaml-corpus/*.yaml + *.expected.json
// The VS Code extension's vitest suite (extension/test/corpus.test.ts) asserts
// the SAME expectations against its faithful TS port of lib/yaml.mjs. If these
// tests fail after an edit to either parser, the two sides have diverged — fix
// both together; never adjust expected outputs unilaterally.
// Run: node --test scripts/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseYaml, stringifyYaml } from '../lib/yaml.mjs';

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'yaml-corpus');

for (const f of readdirSync(corpusDir).sort()) {
  if (!f.endsWith('.yaml')) continue;
  const expected = JSON.parse(readFileSync(join(corpusDir, f.replace(/\.yaml$/, '.expected.json')), 'utf8'));
  const src = readFileSync(join(corpusDir, f), 'utf8');

  test(`corpus[${f}] matches expected ${expected.ok ? 'parse' : 'error'}`, () => {
    if (!expected.ok) {
      assert.throws(() => parseYaml(src, { filename: f }), (e) => e.message.includes(expected.errorMatches));
      return;
    }
    const { data, comments } = parseYaml(src, { filename: f });
    assert.deepEqual(data, expected.data);
    assert.deepEqual(comments, expected.comments);
  });

  if (expected.ok) {
    test(`corpus[${f}] round-trips through stringifyYaml`, () => {
      const { data, comments } = parseYaml(src, { filename: f });
      const out = stringifyYaml(data, comments);
      const re = parseYaml(out, { filename: f });
      assert.deepEqual(re.data, data);
      // every original comment text survives a round-trip, in order
      const origOrder = (src.match(/#[^\n]*/g) || []).map((s) => s.trim());
      const outOrder = (out.match(/#[^\n]*/g) || []).map((s) => s.trim());
      assert.deepEqual(outOrder, origOrder);
    });
  }
}
