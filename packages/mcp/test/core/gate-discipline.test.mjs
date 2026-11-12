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

import { BRIEFS_DIR } from '../../src/context.mjs';
import { loadBrief } from '../../src/core/briefs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const SKILL = join(REPO, 'skill', 'SKILL.md');
const ORCH = join(REPO, 'packages', 'mcp', 'assets', 'references', 'orchestration.md');

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

/**
 * The brief AS THE AGENT RECEIVES IT.
 *
 * The two gate briefs share one protocol file: the classes, the BLOCKING
 * test and the round cap live in `_gate-protocol.md` and are pasted into
 * each brief at load time. So the template file is an implementation
 * detail — what the contract is about is the RENDERED brief.
 *
 * Reading the raw file would test the wrong thing: it would pass while the
 * agent received a brief with no protocol in it.
 */
const renderedBrief = (kind) => loadBrief(BRIEFS_DIR, kind).brief;

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
  for (const kind of ['verifier', 'review']) {
    const text = renderedBrief(kind);
    assert.match(text, /the artifact/i, `${kind}: the rule must name the artifact`);
    assert.match(text, /the rule it violates/i, `${kind}: the rule must name the violated rule`);
    assert.match(text, /the change that satisfies it/i, `${kind}: the rule must name the fix`);
    assert.match(
      text,
      /could also mention|NIT/i,
      `${kind}: the wording-preference case must be classified`,
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
  const text = renderedBrief('verifier');
  assert.match(text, /\*\*BLOCKING\*\*/);
  assert.match(text, /\*\*NIT\*\*/);
  assert.match(text, /\*\*OBSERVATION\*\*/);
  assert.match(text, /DO NOT INVENT REQUIREMENTS/i, 'the brief must forbid new requirements');
  assert.match(text, /no Round 3/i);
  assert.match(text, /DELTA/);
  assert.match(text, /Mechanical floor/i, 'the brief must point at the rendered floor');
});

test('the review brief classifies findings too', () => {
  const text = renderedBrief('review');
  assert.match(text, /BLOCKING/);
  assert.match(text, /NIT/);
  assert.match(text, /OBSERVATION/);
  assert.match(text, /scope fit & minimalism/i);
  assert.match(text, /Round 2 is a DELTA/i);
  assert.match(text, /no Round 3/i);
});

test('both gate briefs carry the SAME shared protocol — one source, no drift', () => {
  // The protocol lives in ONE file and is pasted into both briefs. This gate
  // is what makes that true rather than hopeful: it compares the shared
  // rules in the two DELIVERED briefs, so a change to one that is not
  // mirrored in the other fails here instead of reaching an agent.
  const verifier = renderedBrief('verifier');
  const review = renderedBrief('review');
  const SHARED = [
    /\*\*BLOCKING\*\*/,
    /\*\*NIT\*\*/,
    /\*\*OBSERVATION\*\*/,
    /the artifact/i,
    /the rule it violates/i,
    /the change that satisfies it/i,
    /DO NOT INVENT REQUIREMENTS/i,
    /Round 1 is exhaustive/i,
    /Round 2 is a DELTA/i,
    /There is no Round 3/i,
    /EXACTLY ONE additional pass/i,
  ];
  for (const pattern of SHARED) {
    assert.match(verifier, pattern, `the verifier brief must carry ${pattern}`);
    assert.match(review, pattern, `the review brief must carry ${pattern}`);
  }
});
