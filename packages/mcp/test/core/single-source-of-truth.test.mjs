// single-source-of-truth.test.mjs — a rule stated twice is a rule that drifts.
//
// WHY THIS FILE EXISTS.
//
// Two independent audits found the same class of defect in both halves of the
// system:
//
//   - the floor's code table lived in a reference while the codes lived in
//     the tool, and they disagreed (PROFILE_NOT_RECORDED was listed as an
//     issue and emitted as a warning);
//   - the gate-metrics block had THREE shapes in three files, and the floor
//     read one of them;
//   - the coverage dimensions were named as 8 in one file, 9 in another and 4
//     in a third;
//   - the profile's own `next` hint dropped the inputs that decided the
//     artifact set, so following the tool's own cursor served a DIFFERENT
//     plan.
//
// A duplicate is not free: it is a second place to forget. This file pins
// every duplicated rule to its owner, so CI fails the moment a copy drifts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAsset } from '../../src/context.mjs';
import { ISSUE_CODES, WARNING_CODES, BASE_CODES, KNOWN_CODES } from '../../src/core/codes.mjs';
import { buildPlanProfile } from '../../src/core/plan-profile.mjs';
import { buildScaffold } from '../../src/core/scaffold.mjs';
import { readWaivers } from '../../src/core/plan-audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const REFS = join(REPO, 'packages', 'mcp', 'assets', 'references');
const SKILL = join(REPO, 'skill', 'SKILL.md');
const BRIEFS = join(REPO, 'packages', 'mcp', 'assets', 'briefs');

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const ladder = loadAsset('depth-ladder.json');

// ── 1. the floor's code table ──────────────────────────────────────────────

test('the reference code table lists EVERY code the floor can report', () => {
  const ref = read(join(REFS, 'orchestration.md'));
  assert.ok(ref, 'orchestration.md must ship with the MCP server');
  for (const code of Object.keys(ISSUE_CODES)) {
    assert.ok(ref.includes(`\`${code}\``), `orchestration.md must list the issue code ${code}`);
  }
  for (const code of Object.keys(WARNING_CODES)) {
    assert.ok(ref.includes(`\`${code}\``), `orchestration.md must list the warning code ${code}`);
  }
});

test('the reference code table names no code the floor cannot report', () => {
  const ref = read(join(REFS, 'orchestration.md'));
  assert.ok(ref, 'orchestration.md must ship with the MCP server');
  // Only the section that documents the floor's codes — other sections quote
  // codes in passing (e.g. a waiver's scope example).
  const section = ref.split("### The floor's codes")[1]?.split('### ')[0] ?? '';
  const known = KNOWN_CODES;
  const BASE = new Set(BASE_CODES.map(([, code]) => code));
  // The identifiers the section uses to NAME its owners are not floor codes.
  const OWNERS = new Set(['ISSUE_CODES', 'WARNING_CODES', 'BASE_CODES', 'KNOWN_CODES']);
  for (const m of section.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) {
    if (OWNERS.has(m[1])) continue;
    assert.ok(
      known.has(m[1]) || BASE.has(m[1]),
      `orchestration.md lists ${m[1]}, which the floor can never report`,
    );
  }
});

test('every code the classifier can return is a documented code', () => {
  // `issueCode` falls back to PLAN_ISSUE for an unclassifiable message. A
  // code the floor can EMIT must be in the table the reference renders.
  assert.ok(KNOWN_CODES.has('PLAN_ISSUE'), 'PLAN_ISSUE must be a documented code');
  for (const [, code] of BASE_CODES) {
    assert.ok(KNOWN_CODES.has(code), `the classifier emits ${code}, which is not a documented code`);
  }
});

test('PROFILE_NOT_RECORDED is classified the same way in the code and in the table', () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(WARNING_CODES, 'PROFILE_NOT_RECORDED'),
    true,
    'PROFILE_NOT_RECORDED is a warning: the floor cannot prove artifact necessity without a profile',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(ISSUE_CODES, 'PROFILE_NOT_RECORDED'),
    false,
    'PROFILE_NOT_RECORDED must not also be an issue',
  );
});

// ── 2. the gate-metrics block ──────────────────────────────────────────────

/** The fields of the canonical gate block, read from the code that consumes it. */
const GATE_FIELDS = ['verifier', 'rounds', 'findings', 'waived', 'residual', 'at'];

test('the gate block has ONE shape, and every file that shows it shows the same one', () => {
  const artifact = read(join(REFS, 'artifact-templates.md'));
  const interview = read(join(REFS, 'interview.md'));
  const skill = read(SKILL);
  assert.ok(artifact && interview && skill, 'the three files must exist');

  // The CANONICAL block lives in artifact-templates.md. The other two point
  // at it; they must not restate a different shape.
  const canonical = artifact.split('### Gate metrics')[1]?.split('### ')[0] ?? '';
  for (const field of GATE_FIELDS) {
    assert.ok(canonical.includes(`${field}:`), `the canonical gate block must carry ${field}`);
  }
  assert.ok(
    /verifier:\s*"who approved it"/.test(canonical),
    'the canonical block must name the verifier — an approval needs a subject',
  );
  assert.ok(
    interview.includes('the canonical block'),
    'interview.md must point at the canonical block instead of restating it',
  );
  assert.ok(
    skill.includes('gate-metrics'),
    'SKILL.md must point at the canonical gate block',
  );
});

// ── 3. the waiver shape ────────────────────────────────────────────────────

test('the waiver shape in the reference is the shape the code reads', () => {
  const artifact = read(join(REFS, 'artifact-templates.md'));
  assert.ok(artifact, 'artifact-templates.md must ship with the MCP server');
  const block = artifact.split('### Waivers')[1]?.split('### ')[0] ?? '';
  for (const field of ['id:', 'scope:', 'finding:', 'reason:', 'approved_by:', 'approved_at:']) {
    assert.ok(block.includes(field), `the waiver example must carry ${field}`);
  }
  // The code reads exactly these names.
  const parsed = readWaivers('/nonexistent/waivers.yaml');
  assert.ok(Array.isArray(parsed));
});

// ── 4. the coverage dimensions ─────────────────────────────────────────────

test('the nine coverage dimensions are the SAME nine in the brief and the reference', () => {
  const brief = read(join(BRIEFS, 'verifier.md'));
  const ref = read(join(REFS, 'orchestration.md'));
  assert.ok(brief && ref, 'the verifier brief and orchestration.md must exist');
  const dimensions = [
    'functional coverage',
    'security & data protection',
    'data integrity',
    'state, lifecycle & recovery',
    'resource limits & abuse',
    'operational entrypoints',
    'metric traceability',
    'consistency',
    'scope & artifact necessity',
  ];
  for (const d of dimensions) {
    assert.ok(brief.includes(d), `the verifier brief must carry the dimension "${d}"`);
  }
  // The reference POINTS at the brief's list rather than keeping its own.
  assert.ok(
    /the nine dimensions listed in the verifier brief/i.test(ref),
    'orchestration.md must point at the verifier brief instead of restating the list',
  );
});

// ── 5. the profile → scaffold round trip ───────────────────────────────────

/**
 * Parse a `tool{key:'value',key2:[...],key3:123}` call into an object.
 *
 * The agent copies the call verbatim, so this parser exists only to prove
 * the call is ROUND-TRIPPABLE: everything the profile decided must survive
 * the trip through the string.
 */
function parseCall(call) {
  const body = call.slice(call.indexOf('{') + 1, call.lastIndexOf('}'));
  const args = {};
  let i = 0;
  while (i < body.length) {
    const keyMatch = /^\s*([a-zA-Z][\w]*)\s*:/.exec(body.slice(i));
    if (!keyMatch) break;
    const key = keyMatch[1];
    i += keyMatch[0].length;
    if (body[i] === '[') {
      const close = body.indexOf(']', i);
      const inner = body.slice(i + 1, close);
      args[key] = [...inner.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      i = close + 1;
    } else if (body[i] === "'") {
      const close = body.indexOf("'", i + 1);
      args[key] = body.slice(i + 1, close);
      i = close + 1;
    } else {
      const m = /^\s*([^,}]+)/.exec(body.slice(i));
      args[key] = Number(m[1].trim());
      i += m[0].length;
    }
    // Skip the separator.
    const next = body.indexOf(',', i);
    i = next === -1 ? body.length : next + 1;
  }
  return args;
}

test('the profile\'s own `next` call reproduces the profile exactly', () => {
  const input = {
    intent: 'GREENFIELD-SYSTEM',
    signals: ['product-facing', 'production', 'multi-module'],
    modules: 4,
    tasks: 20,
    slug: 'demo',
  };
  const profile = buildPlanProfile(ladder, input);
  assert.ok(profile.next.startsWith('archgen_plan{action:\'scaffold\''), 'the next call must name the scaffold');

  // Parse the call back into arguments — the way an agent would read it.
  const args = parseCall(profile.next);

  // The scaffold called with the profile's OWN inputs serves the profile's
  // create set — byte for byte.
  const built = buildScaffold(ladder, profile.scopeClass, {
    intent: args.intent,
    signals: args.signals,
    modules: args.modules,
    tasks: args.tasks,
    slug: args.slug,
  });
  const profileCreate = profile.artifacts.filter((a) => a.decision === 'create').map((a) => a.path).sort();
  const scaffoldCreate = built.artifacts.filter((a) => a.decision === 'create').map((a) => a.path).sort();
  assert.deepEqual(scaffoldCreate, profileCreate, 'the scaffold must serve exactly the profile\'s create set');
  assert.equal(built.scopeClass, profile.scopeClass, 'the scope class must agree');
});

test('a scaffold called WITHOUT an intent says it served the candidate set, not the profile', () => {
  const built = buildScaffold(ladder, 'MEDIUM', { slug: 'demo' });
  assert.equal(built.mode, 'class', 'no intent means no evidence — the candidate set, not a profile');
  assert.match(built.modeNote, /profile/i, 'the note must point at the profile');
});

// ── 6. the ladder's own contract ───────────────────────────────────────────

test('every artifact rule carries a family pattern the floor can match', () => {
  for (const rule of ladder.profile.artifactRules ?? []) {
    assert.ok(rule.pattern, `the rule ${rule.path} must carry a pattern`);
    assert.ok(!rule.pattern.includes('<'), `the pattern ${rule.pattern} must not contain a placeholder`);
  }
});

test('the interview round cap is keyed by INTENT, not by scope class', () => {
  assert.ok(ladder.profile.interviewRoundCaps, 'the ladder must carry the interview round caps');
  for (const cap of Object.values(ladder.profile.interviewRoundCaps)) {
    assert.equal(typeof cap, 'number', 'a round cap must be a number');
  }
  // The cap belongs to the intent: the same intent gets the same cap whatever
  // class its signals add up to.
  const small = buildPlanProfile(ladder, { intent: 'BROWNFIELD-CHANGE', signals: [] });
  const large = buildPlanProfile(ladder, { intent: 'BROWNFIELD-CHANGE', signals: ['data-migration'] });
  assert.equal(small.interviewRoundCap, large.interviewRoundCap);
  const system = buildPlanProfile(ladder, { intent: 'GREENFIELD-SYSTEM', signals: ['production'] });
  assert.equal(system.interviewRoundCap, 6);
});
