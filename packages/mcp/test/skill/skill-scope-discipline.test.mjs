// skill-scope-discipline.test.mjs — scope is measured, artifacts are earned.
//
// The defect this pins: intent alone selected a scope, and a scope made every
// artifact in its class mandatory. A greenfield prototype therefore paid for a
// PRD, an architecture contract, ADRs, and diagrams it did not need.
//
// These tests hold the always-on skill to the five laws that fix it:
// evidence over assumption, necessity over completeness, reuse over
// regenerate, proportionality, and a recorded decision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../support/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = REPO_ROOT;
const SKILL = join(REPO, 'skill', 'SKILL.md');
const INTERVIEW = join(REPO, 'packages', 'mcp', 'assets', 'references', 'interview.md');
const ARTIFACTS = join(REPO, 'packages', 'mcp', 'assets', 'references', 'artifact-templates.md');
const VERIFIER = join(REPO, 'packages', 'mcp', 'assets', 'briefs', 'verifier.md');

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

test('the skill requires the deterministic profile before artifacts', () => {
  const text = read(SKILL);
  if (!text) return;
  assert.match(text, /archgen_plan\{action:'profile'/, 'the skill must call the profile action');
  assert.match(text, /before creating files/i, 'the profile must run before artifacts');
  assert.match(text, /default down/i, 'missing evidence must default down, not up');
  assert.match(text, /confidence:low/i, 'a low-confidence profile must ask one question');
  assert.match(text, /never.*LARGE|never default to LARGE/i, 'the skill must forbid the LARGE default');
});

test('the skill states artifact necessity, reuse, and omission rules', () => {
  const text = read(SKILL);
  if (!text) return;
  assert.match(text, /consumer/i, 'an artifact needs a consumer');
  assert.match(text, /reuse names an existing repository path/i, 'reuse must name the host path');
  assert.match(text, /omit records its reason/i, 'every omission needs a recorded reason');
  assert.match(text, /duplicate of a host document/i, 'duplicating a host document is a defect');
});

test('the skill carries the stop list that prevents unneeded artifacts', () => {
  const text = read(SKILL);
  if (!text) return;
  assert.match(text, /no PRD/i);
  assert.match(text, /no ADR/i);
  assert.match(text, /no diagram/i);
  assert.match(text, /no second copy/i);
  assert.match(text, /no task without a requirement or verification/i);
});

test('the interview no longer maps intent to a default scope class', () => {
  const text = read(INTERVIEW);
  if (!text) return;
  assert.doesNotMatch(text, /Default\s+`?scope_class`?/i, 'the default-scope column must be gone');
  assert.match(text, /Scope is \*\*computed/i, 'scope must be computed by the profile');
  assert.match(text, /default down/i);
  assert.match(text, /plan_profile:/, 'the decision must be recorded in answers.yaml');
});

test('the artifact reference carries necessity, reuse, and depth budgets', () => {
  const text = read(ARTIFACTS);
  if (!text) return;
  assert.match(text, /## Artifact necessity & reuse/);
  assert.match(text, /## Depth budgets/);
  assert.match(text, /create/i);
  assert.match(text, /reuse/i);
  assert.match(text, /omit/i);
});

test('the verifier audits scope and artifact necessity as a ninth dimension', () => {
  const text = read(VERIFIER);
  if (!text) return;
  assert.match(text, /SCOPE & ARTIFACT NECESSITY:/);
  assert.match(text, /9 dimensions/);
  assert.match(text, /scope & artifact necessity/i);
});
