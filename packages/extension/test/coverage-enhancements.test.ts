// Coverage enhancements: edge cases previously untested across host modules.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseYaml, stringifyYaml } from '../src/host/readers/yaml.js';
import { parseTasks, parseArchitecture } from '../src/host/readers/archgen.js';
import { interpolateTemplate, splitCommand, probeScriptsPath, parseWaves } from '../src/host/harness.js';
import { detectCodegraph, UnsupportedProductError } from '../src/host/codegraph.js';

describe('yaml.ts edge cases', () => {
  it('stringifies null root and REJECTS scalar-only documents with a clean error', () => {
    expect(stringifyYaml(null)).toBe('null\n');
    // A bare scalar is not a valid document root in our subset - must fail
    // with the standard mapping-entry message, never an internal TypeError.
    expect(() => parseYaml('null\n')).toThrow(/expected 'key:' mapping entry/);
    expect(() => parseYaml('42\n')).toThrow(/expected 'key:' mapping entry/);
  });

  it('duplicate mapping keys: last value wins (documented subset behavior)', () => {
    const { data } = parseYaml('a: first\na: second\n');
    expect(data).toEqual({ a: 'second' });
  });

  it('round-trips nested seq-of-maps with per-item comments positionally', () => {
    const src = 'items:\n  - id: X\n    # note for X\n    ok: true\n  - id: Y\n    # note for Y\n    ok: false\n';
    const { data, comments } = parseYaml(src);
    const out = stringifyYaml(data, comments);
    const xBlock = out.slice(out.indexOf('- id: X'), out.indexOf('- id: Y'));
    const yBlock = out.slice(out.indexOf('- id: Y'));
    expect(xBlock).toContain('# note for X');
    expect(yBlock).toContain('# note for Y');
    expect(parseYaml(out).data).toEqual(data);
  });
});

describe('parseTasks / parseArchitecture validation', () => {
  it('flags duplicate task ids as a warning instead of crashing', () => {
    const model = parseTasks(
      'tasks:\n  - {id: D, title: one, file_ownership: ["a/**"], acceptance: ["x"]}\n' +
      '  - {id: D, title: two, file_ownership: ["b/**"], acceptance: ["y"]}\n',
      'dup.yaml',
    );
    expect(model.warnings.some((w) => /duplicate/i.test(w.message))).toBe(true);
  });

  it('parses architecture modules with owns globs', () => {
    const model = parseArchitecture(
      'name: N\nslug: n\nstack:\n  - ts\nmodules:\n  - name: m\n    responsibility: r\n    owns:\n      - "src/m/**"\n',
      'arch.yaml',
    );
    expect(model.modules[0]?.owns).toEqual(['src/m/**']);
  });
});

describe('harness template + probe edges', () => {
  it('interpolateTemplate replaces every occurrence of a placeholder', () => {
    expect(interpolateTemplate('{{p}} && echo {{p}}', { p: 'hi' })).toBe('hi && echo hi');
  });

  it('splitCommand keeps quoted args with spaces as single tokens', () => {
    expect(splitCommand('claude -p "two words" --flag')).toEqual(['claude', '-p', 'two words', '--flag']);
  });

  it('probeScriptsPath prefers workspace discovery over home fallback', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    mkdirSync(join(ws, 'skills/archgen/scripts'), { recursive: true });
    expect(probeScriptsPath(ws, '/nonexistent-home')).toBe(join(ws, 'skills/archgen/scripts'));
  });

  it('probeScriptsPath honors a configured override that actually exists', () => {
    const configured = mkdtempSync(join(tmpdir(), 'cfg-'));
    mkdirSync(join(configured), { recursive: true });
    expect(probeScriptsPath(null, '/nonexistent-home', configured)).toBe(configured);
  });

  it('parseWaves rejects non-scalar wave entries', () => {
    expect(() => parseWaves('{"waves":[["a"],["b", 42]]}')).toThrow();
  });
});

describe('codegraph detection matrix', () => {
  it('detects colby via .codegraph/codegraph.db', () => {
    const ws = mkdtempSync(join(tmpdir(), 'cg-colby-'));
    mkdirSync(join(ws, '.codegraph'), { recursive: true });
    writeFileSync(join(ws, '.codegraph/codegraph.db'), '');
    expect(detectCodegraph(ws, '/nonexistent-home').product).toBe('colby');
  });

  it('detects optave via .codegraph/graph.db', () => {
    const ws = mkdtempSync(join(tmpdir(), 'cg-optave-'));
    mkdirSync(join(ws, '.codegraph'), { recursive: true });
    writeFileSync(join(ws, '.codegraph/graph.db'), '');
    expect(detectCodegraph(ws, '/nonexistent-home').product).toBe('optave');
  });

  it('absent product yields non-colby/optave detection and typed error class works', () => {
    const ws = mkdtempSync(join(tmpdir(), 'cg-none-'));
    const d = detectCodegraph(ws, join(tmpdir(), 'definitely-missing-home'));
    expect(['colby', 'optave']).not.toContain(d.product);
    expect(() => { throw new UnsupportedProductError('x'); }).toThrow(UnsupportedProductError);
  });
});
