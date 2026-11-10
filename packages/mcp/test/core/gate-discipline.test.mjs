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
});
