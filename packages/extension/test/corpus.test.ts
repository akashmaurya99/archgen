// Corpus parity tests (extension side) — same fixtures as the skill's
// node:test suite; asserts the TS port parses IDENTICALLY to the committed
// expectations generated from skill/scripts/lib/yaml.mjs.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml, stringifyYaml } from '../src/host/readers/yaml';

const HERE = dirname(fileURLToPath(import.meta.url));

const CORPUS_DIR = join(HERE, '..', '..', '..', 'fixtures', 'yaml-corpus');

interface ExpectedOk { ok: true; data: unknown; comments: unknown[] }
interface ExpectedErr { ok: false; errorMatches: string }
type Expected = ExpectedOk | ExpectedErr;

const corpusFiles = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.yaml')).sort();

describe('yaml corpus parity', () => {
  for (const f of corpusFiles) {
    const src = readFileSync(join(CORPUS_DIR, f), 'utf8');
    const expected = JSON.parse(readFileSync(join(CORPUS_DIR, f.replace(/\.yaml$/, '.expected.json')), 'utf8')) as Expected;

    it(`${f}: ${expected.ok ? 'parses to expected data+comments' : `throws /${expected.errorMatches}/`}`, () => {
      if (!expected.ok) {
        expect(() => parseYaml(src, { filename: f })).toThrowError(expected.errorMatches);
        return;
      }
      const { data, comments } = parseYaml(src, { filename: f });
      expect(data).toEqual(expected.data);
      expect(comments).toEqual(expected.comments);
    });

    if (expected.ok) {
      it(`${f}: round-trips through stringifyYaml`, () => {
        const { data, comments } = parseYaml(src, { filename: f });
        const out = stringifyYaml(data, comments);
        const re = parseYaml(out, { filename: f });
        expect(re.data).toEqual(data);
        const origOrder = (src.match(/#[^\n]*/g) ?? []).map((s) => s.trim());
        const outOrder = (out.match(/#[^\n]*/g) ?? []).map((s) => s.trim());
        expect(outOrder).toEqual(origOrder);
      });
    }
  }

  it('corpus is non-empty (guards against silent fixture deletion)', () => {
    expect(corpusFiles.length).toBeGreaterThanOrEqual(5);
  });
});
