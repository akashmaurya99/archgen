// plan-profile.test.mjs — scope is EVIDENCE, not a synonym for "big".
//
// The defect this pins: a greenfield request defaulted to LARGE, and LARGE
// meant every artifact in the depth ladder. A prototype, an internal tool,
// or a one-module feature paid for a PRD, an architecture contract, ADRs and
// diagrams it did not need.
//
// The classifier must:
//   - escalate only on explicit signals;
//   - default DOWN when the evidence is thin (and ask ONE question);
//   - decide each artifact independently (create / reuse / omit);
//   - never regenerate a document the host repository already owns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAsset } from '../../src/context.mjs';
import { buildPlanProfile, INTENTS, SCOPE_SIGNALS } from '../../src/core/plan-profile.mjs';

const ladder = loadAsset('depth-ladder.json');

function profile(input) {
  return buildPlanProfile(ladder, input);
}

function artifact(p, path) {
  return p.artifacts.find((a) => a.path.endsWith(path));
}

test('a localized brownfield change is SMALL and does not create heavyweight documents', () => {
  const p = profile({ intent: 'BROWNFIELD-CHANGE', slug: 'demo' });
  assert.equal(p.scopeClass, 'SMALL');
  assert.equal(p.confidence, 'medium');
  assert.equal(artifact(p, 'tasks.yaml').decision, 'create');
  assert.equal(artifact(p, 'plans/demo.md').decision, 'create');
  assert.equal(artifact(p, 'docs/prd.md').decision, 'omit');
  assert.equal(artifact(p, 'architecture.yaml').decision, 'omit');
  assert.equal(artifact(p, 'decisions/0001-<title>.md').decision, 'omit');
  assert.equal(artifact(p, 'docs/<module>.md').decision, 'omit');
});

test('a brownfield feature stays lean when it touches one module', () => {
  const p = profile({ intent: 'BROWNFIELD-FEATURE', signals: [], modules: 1, slug: 'demo' });
  assert.equal(p.scopeClass, 'SMALL');
  assert.equal(artifact(p, 'docs/prd.md').decision, 'omit');
  assert.equal(artifact(p, 'architecture.yaml').decision, 'omit');
});

test('a data migration escalates and requires an architecture contract', () => {
  const p = profile({ intent: 'BROWNFIELD-CHANGE', signals: ['data-migration'], slug: 'demo' });
  assert.notEqual(p.scopeClass, 'SMALL');
  assert.equal(artifact(p, 'architecture.yaml').decision, 'create');
});

test('a public contract escalates a change out of SMALL', () => {
  const p = profile({ intent: 'BROWNFIELD-CHANGE', signals: ['public-contract'], slug: 'demo' });
  assert.equal(p.scopeClass, 'MEDIUM');
});

test('a greenfield prototype is not forced into the full LARGE stack', () => {
  const p = profile({ intent: 'GREENFIELD-SYSTEM', signals: ['prototype'], slug: 'demo' });
  assert.equal(p.scopeClass, 'MEDIUM');
  assert.equal(artifact(p, 'docs/prd.md').decision, 'omit');
  assert.equal(artifact(p, 'architecture.yaml').decision, 'omit');
});

test('a production product-facing greenfield system is LARGE with a PRD', () => {
  const p = profile({
    intent: 'GREENFIELD-SYSTEM',
    signals: ['production', 'product-facing', 'multi-module'],
    modules: 4,
    slug: 'demo',
  });
  assert.equal(p.scopeClass, 'LARGE');
  assert.equal(artifact(p, 'docs/prd.md').decision, 'create');
  assert.equal(artifact(p, 'architecture.yaml').decision, 'create');
  assert.equal(artifact(p, 'answers.yaml').decision, 'create');
});

test('ADRs and diagrams stay conditional even at LARGE', () => {
  const p = profile({
    intent: 'GREENFIELD-SYSTEM',
    signals: ['production', 'product-facing', 'cross-team'],
    modules: 4,
    slug: 'demo',
  });
  assert.equal(p.scopeClass, 'LARGE');
  assert.equal(artifact(p, 'decisions/0001-<title>.md').decision, 'omit');
  assert.equal(artifact(p, 'docs/<module>.md').decision, 'omit');
  assert.equal(artifact(p, 'docs/mermaid-snippets.md').decision, 'omit');
});

test('an irreversible decision creates an ADR', () => {
  const p = profile({
    intent: 'GREENFIELD-SYSTEM',
    signals: ['production', 'multi-module', 'irreversible'],
    modules: 4,
    slug: 'demo',
  });
  assert.equal(artifact(p, 'decisions/0001-<title>.md').decision, 'create');
});

test('existing host documents are REUSED, never regenerated', () => {
  const p = profile({
    intent: 'GREENFIELD-SYSTEM',
    signals: ['production', 'product-facing', 'multi-module', 'existing-prd', 'existing-architecture', 'existing-adr'],
    modules: 4,
    slug: 'demo',
  });
  assert.equal(artifact(p, 'docs/prd.md').decision, 'reuse');
  assert.equal(artifact(p, 'architecture.yaml').decision, 'reuse');
  assert.equal(artifact(p, 'decisions/0001-<title>.md').decision, 'reuse');
  assert.equal(artifact(p, 'docs/prd.md').recordPath, true);
});

test('thin evidence defaults DOWN and asks exactly one question', () => {
  const p = profile({ intent: 'GREENFIELD-SYSTEM', signals: [], slug: 'demo' });
  assert.equal(p.confidence, 'low');
  assert.equal(typeof p.question, 'string');
  assert.equal(p.question.split('?').length, 2, 'one question, not an interview');
  assert.ok(p.missingSignals.length <= 2);
});

test('the profile reports the depth budget for its class', () => {
  const p = profile({ intent: 'BROWNFIELD-CHANGE', slug: 'demo' });
  assert.equal(p.depth.edgeCasesPerTask, 0);
  assert.equal(p.depth.maxAdrs, 0);
});

test('unknown intents and signals are typed INVALID_INPUT', () => {
  assert.throws(
    () => profile({ intent: 'BIG-BANG' }),
    (e) => e.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => profile({ intent: 'BROWNFIELD-CHANGE', signals: ['vibes'] }),
    (e) => e.code === 'INVALID_INPUT',
  );
});

test('the schema exports every value the classifier accepts', () => {
  assert.deepEqual(INTENTS, [
    'GREENFIELD-SYSTEM',
    'GREENFIELD-MODULE',
    'BROWNFIELD-FEATURE',
    'BROWNFIELD-CHANGE',
  ]);
  for (const signal of SCOPE_SIGNALS) {
    assert.ok(ladder.profile.signals.includes(signal), `${signal} must be declared in the ladder`);
  }
});
