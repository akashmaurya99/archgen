// gate-discipline.test.mjs — the gate runs twice, and the agent never invents
// requirements.
//
// WHY THIS FILE EXISTS.
//
// The gate was running three and four times, and each pass surfaced a new
// category of the same mechanical checks plus a fresh set of "the system should
// also do X" suggestions. Three causes, three contracts:
//
//   1. The deterministic floor did not cover the mechanical checks, so the
//      agent did them by eye, one category per round.
//   2. The protocol allowed an unbounded number of rounds.
//   3. The brief had no rule separating "the plan contradicts what was agreed"
//      from "the plan should have more features", so a missing capability was
//      reported as a defect and never converged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const SKILL = join(REPO, 'skill', 'SKILL.md');
const ORCH = join(REPO, 'packages', 'mcp', 'assets', 'references', 'orchestration.md');
const VERIFIER = join(REPO, 'packages', 'mcp', 'assets', 'briefs', 'verifier.md');
const REVIEW = join(REPO, 'packages', 'mcp', 'assets', 'briefs', 'review.md');

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

test('the skill runs the deterministic floor BEFORE dispatching a gate agent', () => {
  const text = read(SKILL);
  if (!text) return;
  assert.match(text, /archgen_plan\{action:'verify'/, 'the skill must run the floor');
  assert.match(
    text,
    /until it returns `APPROVE`|until .*APPROVE/,
    'the floor must be driven to APPROVE before the gate runs',
  );
  const verifyAt = text.indexOf("archgen_plan{action:'verify'");
  const briefAt = text.indexOf("action:'brief', kind:'verifier'");
  assert.ok(verifyAt >= 0 && briefAt >= 0);
  assert.ok(verifyAt < briefAt, 'the floor must come before the gate dispatch');
});

test('the skill caps the gate at two rounds', () => {
  const text = read(SKILL);
  if (!text) return;
  assert.match(text, /at most TWO rounds|TWO rounds/i, 'the skill must cap the gate');
  assert.match(text, /escalat/i, 'what remains must escalate to the user');
});

test('the orchestration protocol puts the floor first and caps the rounds', () => {
  const text = read(ORCH);
  if (!text) return;
  assert.match(text, /floor comes FIRST/i, 'the floor must come first');
  assert.match(text, /at most twice|TWO rounds/i);
  assert.match(text, /no Round 3/i, 'a third round must be forbidden');
  assert.match(text, /delta/i, 'round 2 must be a delta re-check');
});

test('BOTH gate stages run the SAME protocol — the review stage has no third pass', () => {
  const text = read(ORCH);
  if (!text) return;
  // The review stage used to keep its own 3-pass loop while the verifier was
  // capped at 2. Two stages with different loops are two stages that drift.
  assert.match(text, /ONE protocol, TWO stages, TWO rounds each/i);
  assert.match(
    text,
    /It runs the shared gate protocol/,
    'the review stage must run the shared protocol',
  );
  assert.doesNotMatch(text, /Pass 3 is final/, 'the old three-pass review loop must be gone');
});

test('a BLOCKING finding must name the artifact, the violated rule, and the fix', () => {
  for (const [label, path] of [['verifier', VERIFIER], ['review', REVIEW]]) {
    const text = read(path);
    if (!text) continue;
    assert.match(text, /the artifact/i, `${label}: the rule must name the artifact`);
    assert.match(text, /the rule it violates/i, `${label}: the rule must name the violated rule`);
    assert.match(text, /the change that satisfies it/i, `${label}: the rule must name the fix`);
    assert.match(
      text,
      /could also mention|NIT/i,
      `${label}: the wording-preference case must be classified`,
    );
  }
});

test('the fix pass is one pass per file, and the floor re-checks it', () => {
  const text = read(ORCH);
  if (!text) return;
  assert.match(text, /ONE pass, per file, per code/i);
  assert.match(text, /the CLASS was not fixed/i, 'a repeated code means the class was not fixed');
});

test('gate agents never reuse a worker session', () => {
  const text = read(ORCH);
  if (!text) return;
  assert.match(text, /Gates never reuse a session/i, 'independence requires a fresh gate session');
  assert.match(text, /changed contract invalidates the session/i);
});

test('the verifier brief classifies findings and forbids inventing requirements', () => {
  const text = read(VERIFIER);
  if (!text) return;
  assert.match(text, /\*\*BLOCKING\*\*/);
  assert.match(text, /\*\*NIT\*\*/);
  assert.match(text, /\*\*OBSERVATION\*\*/);
  assert.match(text, /DO NOT INVENT REQUIREMENTS/i, 'the brief must forbid new requirements');
  assert.match(text, /no Round 3/i);
  assert.match(text, /DELTA/);
  assert.match(text, /Mechanical floor/i, 'the brief must point at the rendered floor');
});

test('the review brief classifies findings too', () => {
  const text = read(REVIEW);
  if (!text) return;
  assert.match(text, /BLOCKING/);
  assert.match(text, /NIT/);
  assert.match(text, /OBSERVATION/);
  assert.match(text, /scope fit & minimalism/i);
  assert.match(text, /Round 2 is a DELTA/i);
  assert.match(text, /no Round 3/i);
});
