// AUDIT-REGRESSION — regression tests for bugs found in the 2026-08 archgen audit.
// NEW FILE ONLY: no existing file was modified. Tests tagged BUG-* encode the
// DESIRED behavior and are expected to FAIL against the current code.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
let dir;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'archgen-audit-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function run(script, args) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8' });
}
function writeTasks(content) {
  const p = join(dir, 'tasks.yaml');
  writeFileSync(p, content);
  return p;
}
function planMentioning(ids, plansDir = join(dir, 'plans')) {
  mkdirSync(plansDir, { recursive: true });
  const p = join(plansDir, 'p.md');
  writeFileSync(p, 'Plan covers ' + ids.join(' and ') + '.\n');
  return plansDir;
}

// BUG-VER1: verify-plan only rejects MISSING/EMPTY acceptance arrays; entries
// that are whitespace-only or empty strings pass the "objective criteria" gate.
test('BUG-VER1 // AUDIT-REGRESSION verify-plan rejects whitespace-only / empty-string acceptance entries', () => {
  const p = writeTasks(`tasks:
  - id: A
    title: t
    file_ownership: ["src/a.ts"]
    acceptance:
      - "   "
      - ""
`);
  const r = run('verify-plan.mjs', [p, '--plan', planMentioning(['A'])]);
  assert.equal(r.status, 1, 'verifier APPROVEd non-criteria acceptance entries');
  assert.match(r.stdout, /acceptance/);
});

// BUG-VER2: findOwnershipConflict compares globs as opaque strings, so two
// same-wave tasks owning OVERLAPPING (not identical) globs — src/** vs
// src/**/*.ts — are approved to run concurrently. SKILL.md promises disjoint
// ownership per wave ("Do NOT put two same-wave tasks on overlapping
// file_ownership globs"), so the gate under-enforces its own contract.
test('BUG-VER2 // AUDIT-REGRESSION verify-plan flags same-wave tasks whose ownership globs overlap via ** patterns', () => {
  const p = writeTasks(`tasks:
  - id: W1
    title: a
    file_ownership: ["src/**"]
    acceptance: ["x"]
  - id: W2
    title: b
    file_ownership: ["src/**/*.ts"]
    acceptance: ["y"]
`);
  const r = run('verify-plan.mjs', [p, '--plan', planMentioning(['W1', 'W2'])]);
  assert.equal(r.status, 1, 'verifier APPROVEd overlapping ** globs in one wave');
  assert.match(r.stdout, /overlap/i);
});

// BUG-VER3: validate.mjs resolves --plan's value positionally; when the value
// is missing, planDir is undefined and `if (planDir)` silently skips ALL
// coverage checks, exiting 0 "valid". Desired: usage error (exit non-zero).
test('BUG-VER3 // AUDIT-REGRESSION validate --plan with a missing value is a usage error, not a silent skip', () => {
  const p = writeTasks(`tasks:
  - id: Z9
    title: t
    file_ownership: ["a"]
    acceptance: ["x"]
`);
  const r = run('validate.mjs', [p, '--plan']);
  assert.notEqual(r.status, 0, 'validate exited 0 while ignoring --plan entirely');
});

// BUG-STA1: the done->pending|ready guard is trivially bypassed in two legal
// single steps (done->failed, then failed->pending), reopening completed work
// without ever supplying --force.
test('BUG-STA1 // AUDIT-REGRESSION set-status cannot reopen done work via done->failed->pending without --force', () => {
  const p = writeTasks(`tasks:
  - id: B1
    title: t
    status: done
    file_ownership: ["a"]
    acceptance: ["x"]
`);
  const step1 = run('set-status.mjs', [p, 'B1', 'failed']);
  if (step1.status !== 0) return; // guard tightened at the first hop; bypass moot
  const step2 = run('set-status.mjs', [p, 'B1', 'pending']);
  assert.notEqual(step2.status, 0, 'done work reopened without --force via failed hop');
});

// BUG-STA2: set-status rewrites CRLF files through stringifyYaml, which joins
// with '\n' — every non-comment line flips CRLF->LF (comment lines keep their
// \r because comment text is emitted verbatim). Whole-file EOL churn breaks
// git diffs and contradicts the "comment-safe edit" contract's spirit.
test('BUG-STA2 // AUDIT-REGRESSION set-status preserves the CRLF line-ending convention of tasks.yaml', () => {
  const p = writeTasks(
    'tasks:\r\n  # note\r\n  - id: C1\r\n    title: t\r\n    status: pending\r\n    file_ownership: ["a"]\r\n    acceptance: ["x"]\r\n',
  );
  const r = run('set-status.mjs', [p, 'C1', 'done']);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(p, 'utf8');
  const total = out.split('\n').length - 1;
  const crlf = out.split(/\r\n/).length - 1;
  assert.equal(crlf, total, `mixed EOL after set-status (${crlf}/${total} lines kept CRLF)`);
});

// BUG-STA3: unlike next-tasks/validate, set-status has no try/catch around
// parse/read — truncated YAML or a missing path surfaces as a raw thrown
// YamlError/ENOENT stack with exit code 1 instead of a clean message + exit 4.
test('BUG-STA3 // AUDIT-REGRESSION set-status reports clean errors (no raw stack) for unparseable or missing files', () => {
  const bad = writeTasks('tasks:\n  - id: T1\n    titl');
  for (const [file, id] of [[bad, 'T1'], [join(dir, 'absent.yaml'), 'T1']]) {
    const r = run('set-status.mjs', [file, id, 'done']);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, /\n\s+at /, `raw stack trace for ${file}`);
    assert.doesNotMatch(r.stderr, /YamlError|ENOENT/, `unwrapped error class name for ${file}`);
  }
});

// BUG-IMP1: impact.mjs has no error handling at all around read/parse —
// missing file or malformed YAML crashes with a raw stack (exit 1).
test('BUG-IMP1 // AUDIT-REGRESSION impact reports clean errors (no raw stack) for unparseable or missing files', () => {
  const bad = writeTasks('tasks:\n  - id: T1\n    titl');
  for (const file of [bad, join(dir, 'absent.yaml')]) {
    const r = run('impact.mjs', [file, 'T1']);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, /\n\s+at /, `raw stack trace for ${file}`);
  }
});

// BUG-YML1: validate.mjs checks `t[r] === undefined` for required fields, so
// an explicitly EMPTY value (`id:` parses to null) sails through validation,
// then breaks addressing downstream (set-status/next-tasks see id null).
test('BUG-YML1 // AUDIT-REGRESSION validate rejects a task whose required field is present but empty (id:)', () => {
  const p = writeTasks(`tasks:
  - id:
    title: no-id
    file_ownership: ["a"]
    acceptance: ["x"]
`);
  const r = run('validate.mjs', [p]);
  assert.equal(r.status, 1, 'validate accepted id:null');
  assert.match(r.stderr, /id/);
});

// BUG-YML2: the hand-rolled parser lets duplicate mapping keys silently
// last-win (real YAML parsers reject them). A duplicated `id:` key hides data
// from every downstream check with no warning.
test('BUG-YML2 // AUDIT-REGRESSION duplicate keys inside a task are rejected (not silently last-wins)', () => {
  const p = writeTasks(`tasks:
  - id: DUP
    title: first
    id: DUP2
    file_ownership: ["a"]
    acceptance: ["x"]
`);
  const r = run('validate.mjs', [p]);
  assert.equal(r.status, 1, 'duplicate id keys were silently collapsed');
});

// BUG-YML3: schemas/tasks.schema.json requires id to match
// ^[A-Za-z0-9][A-Za-z0-9._-]*$ as a STRING, but validate.mjs never checks
// type/pattern and the parser coerces bare 007 to the NUMBER 7 — validate
// blesses the file, then set-status cannot address task '007' at all.
test('BUG-YML3 // AUDIT-REGRESSION validate enforces the schema id pattern/type so numeric-coerced ids fail fast', () => {
  const p = writeTasks(`tasks:
  - id: 007
    title: numeric id
    file_ownership: ["a"]
    acceptance: ["x"]
`);
  const v = run('validate.mjs', [p]);
  assert.equal(v.status, 1, 'validate accepted a schema-violating id (coerced to number)');
});

// BUG-UPD1: update-agents deriveStatus maps an all-'failed' feature to
// 'in progress' (blocked beats all, then done, then planned... else in
// progress). The registry then shows "in progress" for dead features.
test('BUG-UPD1 // AUDIT-REGRESSION update-agents does not label an all-failed feature "in progress"', () => {
  const proj = dir;
  const slug = 'deadfeat';
  mkdirSync(join(proj, '.archgen', slug), { recursive: true });
  writeFileSync(join(proj, '.archgen', slug, 'tasks.yaml'), `tasks:
  - id: F1
    title: t
    status: failed
    file_ownership: ["a"]
    acceptance: ["x"]
`);
  writeFileSync(join(proj, 'AGENTS.md'), '# Guide\n');
  const r = run('update-agents.mjs', [proj]);
  assert.equal(r.status, 0, r.stderr);
  const table = readFileSync(join(proj, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(table, new RegExp(`\\| ${slug} \\| in progress \\|`),
    'all-failed feature shown as "in progress"');
});
