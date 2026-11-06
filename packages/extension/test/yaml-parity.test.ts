// yaml-parity.test.ts — the extension's YAML port must equal the MCP core's.
//
// The extension used to carry a hand-written TypeScript port of the skill's
// YAML parser. The parser now lives in ONE place — the MCP core
// (packages/mcp/src/core/yaml.mjs) — and the extension keeps its port for
// in-process reads. Two implementations of the same format is exactly the
// kind of drift this repo cannot afford: a plan the extension renders
// differently from the plan the agent edits is a silent data bug.
//
// This test pins them together over the repo's YAML corpus.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml as parseYamlPort } from '../src/host/readers/yaml.js';

// The MCP core is plain ESM JavaScript (no type declarations); import it
// dynamically through a non-literal specifier (so TypeScript does not try to
// resolve types for it) with an explicit shape. The URL is absolute because
// the test file lives in packages/extension/test but the core lives in
// packages/mcp.
const CORE_URL = new URL('../../mcp/src/core/yaml.mjs', import.meta.url).href;
const { parseYaml: parseYamlCore } = (await import(CORE_URL)) as {
  parseYaml: (text: string, opts?: { filename?: string }) => { data: unknown };
};

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, '..', '..', '..', 'fixtures', 'yaml-corpus');

/** Parse with both implementations; return the comparable outcome. */
function both(text: string): { core: unknown; port: unknown } {
  const attempt = (fn: (t: string) => unknown): unknown => {
    try {
      return { ok: true, data: fn(text) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  return {
    core: attempt((t) => (parseYamlCore(t) as { data: unknown }).data),
    port: attempt((t) => (parseYamlPort(t) as { data: unknown }).data),
  };
}

describe('YAML parity — the MCP core and the extension port', () => {
  it('both implementations exist', () => {
    expect(typeof parseYamlCore).toBe('function');
    expect(typeof parseYamlPort).toBe('function');
  });

  it('agrees on the whole yaml-corpus', () => {
    if (!existsSync(CORPUS)) {
      // The corpus lives at the repo root; a published extension checkout may
      // not have it. Skip rather than fail.
      return;
    }
    for (const name of readdirSync(CORPUS)) {
      if (!name.endsWith('.yaml')) continue;
      const text = readFileSync(join(CORPUS, name), 'utf8');
      const { core, port } = both(text);
      expect(JSON.stringify(port), `port disagrees with core on ${name}`).toEqual(JSON.stringify(core));
    }
  });

  it('agrees on the behaviours that matter for a plan file', () => {
    const cases: Array<[string, string]> = [
      ['duplicate mapping key', 'a: 1\na: 2\n'],
      ['tab indentation', 'good: 1\n\tbad: 2\n'],
      ['unterminated flow sequence', 'items: [1, 2\nmore: stuff\n'],
      ['scalar root', '42\n'],
      ['null root', 'null\n'],
      ['nested seq of maps', 'items:\n  - id: X\n    ok: true\n'],
      ['comments', '# lead\na: 1 # trail\n'],
      ['quoted values', "a: 'x y'\nb: \"z\"\n"],
    ];
    for (const [label, text] of cases) {
      const { core, port } = both(text);
      expect(JSON.stringify(port), `port disagrees with core on: ${label}`).toEqual(JSON.stringify(core));
    }
  });
});
