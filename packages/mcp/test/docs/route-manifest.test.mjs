import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadAsset } from '../../src/context.mjs';
import { referenceRoute } from '../../src/core/docs/refs.mjs';
import { INTENTS } from '../../src/core/plan/plan-profile.mjs';
import { estimateTokens } from '../../src/core/protocol/tokens.mjs';

const manifest = loadAsset('mode-routes.json');
const roots = { assetsDir: join(process.cwd(), 'assets', 'references'), skillDir: null };

test('every route entry resolves without duplicates, wildcards, or missing intent selection', () => {
  for (const [mode, route] of Object.entries(manifest.modes)) {
    for (const phase of route.order) {
      const results = INTENTS.map((intent) => referenceRoute(manifest, { mode, phase, intent, roots }));
      for (const result of results) {
        const keys = result.sections.map((section) => `${section.topic}/${section.section}`);
        assert.equal(new Set(keys).size, keys.length, `${mode}/${phase} duplicates a section`);
        for (const section of result.sections) {
          assert.ok(section.text.length > 0, `${mode}/${phase} did not resolve ${section.topic}/${section.section}`);
          assert.ok(!section.section.includes('*'));
        }
        const tokens = estimateTokens(result.sections.map((section) => section.text).join('\n'));
        assert.ok(tokens <= 2500, `${mode}/${phase} costs ${tokens} tokens`);
      }
    }
  }
});

test('a complete mode never reloads the same section in a later phase', () => {
  for (const [mode, route] of Object.entries(manifest.modes)) {
    const seen = new Set();
    for (const phase of route.order) {
      const result = referenceRoute(manifest, { mode, phase, intent: 'GREENFIELD-SYSTEM', roots });
      for (const section of result.sections) {
        const key = `${section.topic}/${section.section}`;
        assert.equal(seen.has(key), false, `${mode} reloads ${key} in ${phase}`);
        seen.add(key);
      }
    }
  }
});

test('GENERATE discovery loads only the selected intent', () => {
  const result = referenceRoute(manifest, { mode: 'GENERATE', phase: 'discover', intent: 'GREENFIELD-MODULE', roots });
  assert.ok(result.sections.some((section) => section.section.startsWith('greenfield-module')));
  assert.ok(!result.sections.some((section) => section.section.startsWith('greenfield-system')));
  assert.ok(!result.sections.some((section) => section.section.startsWith('brownfield-')));
  assert.equal(referenceRoute(manifest, { mode: 'GENERATE', phase: 'discover', roots }).intentRequired, true);
});

test('GREENFIELD-SYSTEM discovery includes the actual nested questions and close-out', () => {
  const result = referenceRoute(manifest, { mode: 'GENERATE', phase: 'discover', intent: 'GREENFIELD-SYSTEM', roots });
  const discovery = result.sections.find((section) => section.section.startsWith('greenfield-system'));
  assert.ok(discovery.text.length > 1500, 'the route must include the nested discovery rounds, not just their parent heading');
  assert.match(discovery.text, /Core problem/);
  assert.match(discovery.text, /R5 — environment, naming & close-out/);
  assert.doesNotMatch(discovery.text, /### R6/);
  assert.ok(discovery.text.split(/^### R\d/m).length - 1 <= 5, 'Round 0 plus R1–R5 respects the six-round cap');
});

test('GENERATE pre-artifact reading is bounded', () => {
  for (const intent of INTENTS) {
    const total = ['scope', 'discover', 'author', 'invariants'].reduce((sum, phase) => {
      const route = referenceRoute(manifest, { mode: 'GENERATE', phase, intent, roots });
      return sum + estimateTokens(route.sections.map((section) => section.text).join('\n'));
    }, 0);
    assert.ok(total <= 7000, `${intent} pre-artifact references cost ${total}`);
  }
});
